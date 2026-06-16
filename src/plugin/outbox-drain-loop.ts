import type { OutboxEntry } from '../core/types.ts';
import {
  buildFlushDebugInfo,
  buildOutboxDrainSkipDebugInfo,
  buildOutboxDrainStuckDebugInfo,
} from '../messaging/outbound/diagnostics.ts';
import {
  buildOutboxOnlineDebugInfo,
  computeNextOutboxDelay,
  findDueOutboxEntry,
  listAccountOutboxEntries,
  selectOutboxTargetAccounts,
  updateMinOutboxDelay,
} from '../messaging/outbound/queue-selectors.ts';
import { OUTBOUND_SCHEDULE_SOURCE } from '../messaging/outbound/reasons.ts';

type FlushPushQueueArgs = {
  accountId?: string;
  trigger?: string;
  reason?: string;
};

// Flush argument normalization ----------------------------------------------

// Flush entrypoint args are normalized once so the rest of the drain flow can
// work with canonical account/trigger/reason values.

function normalizeFlushPushQueueArgs(
  args: FlushPushQueueArgs | undefined,
  helpers: {
    asString: (value: unknown, fallback?: string) => string;
    normalizeAccountId: (accountId: string) => string;
  },
) {
  const filterAcc = args?.accountId ? helpers.normalizeAccountId(args.accountId) : null;
  const trigger = helpers.asString(args?.trigger || '').trim() || 'manual';
  const reason = helpers.asString(args?.reason || '').trim() || undefined;
  return { filterAcc, trigger, reason };
}

// The drain loop yields on either time or entry budget. These helpers stay
// local so the account-drain flow reads top-to-bottom without jumping files.

// Account-drain budget helpers ----------------------------------------------

function shouldYieldAccountDrainForTimeBudget(args: {
  processedThisRun: number;
  accountDrainStartedAt: number;
  now: number;
  pushDrainAccountTimeBudgetMs: number;
}) {
  return (
    args.processedThisRun > 0 &&
    args.now - args.accountDrainStartedAt >= args.pushDrainAccountTimeBudgetMs
  );
}

function shouldYieldAccountDrainForEntryBudget(args: {
  processedThisRun: number;
  pushDrainAccountBudget: number;
}) {
  return args.processedThisRun >= args.pushDrainAccountBudget;
}

function scheduleAccountYieldForBudget(args: {
  accountId: string;
  source: string;
  localNextDelay: number | null;
  scheduleAccountYield: (args: {
    accountId: string;
    source: string;
    localNextDelay: number | null;
    updateMinOutboxDelay: typeof updateMinOutboxDelay;
  }) => number | null;
}) {
  return args.scheduleAccountYield({
    accountId: args.accountId,
    source: args.source,
    localNextDelay: args.localNextDelay,
    updateMinOutboxDelay,
  });
}

type BncrOutboxDrainScheduleRuntime = {
  scheduleAccountWait: (args: {
    accountId: string;
    messageId?: string;
    source: string;
    wait: number;
    localNextDelay: number | null;
    updateMinOutboxDelay: typeof updateMinOutboxDelay;
  }) => number | null;
  scheduleAccountYield: (args: {
    accountId: string;
    source: string;
    localNextDelay: number | null;
    updateMinOutboxDelay: typeof updateMinOutboxDelay;
  }) => number | null;
  mergeAccountNextDelay: (args: {
    accountId: string;
    localNextDelay: number;
    globalNextDelay: number | null;
    updateMinOutboxDelay: typeof updateMinOutboxDelay;
    source: string;
  }) => number | null;
  scheduleFlushNextDrain: (args: { globalNextDelay: number; source: string }) => void;
};

type BncrOutboxDrainLoopRuntime = {
  bridgeId: string;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  normalizeAccountId: (accountId: string) => string;
  stopped: () => boolean;
  outbox: Map<string, OutboxEntry>;
  connectionsValues: () => IterableIterator<{
    accountId: string;
    connId: string;
    clientId?: string;
    connectedAt: number;
    lastSeenAt: number;
    inboundOnly?: boolean;
    outboundReady?: boolean;
    preferredForOutbound?: boolean;
    outboundReadyUntil?: number;
    preferredForOutboundUntil?: number;
    lastAckOkAt?: number;
    lastPushTimeoutAt?: number;
    pushFailureScore?: number;
  }>;
  gatewayContextAvailable: () => boolean;
  messageAckWaiterCount: () => number;
  fileAckWaiterCount: () => number;
  activeConnectionCount: (accountId: string) => number;
  getAccountPendingOutboxEntries: (accountId: string) => OutboxEntry[];
  pushDrainRunningAccounts: Set<string>;
  pushDrainRunningSinceByAccount: Map<string, number>;
  pushDrainStuckWarnedAtByAccount: Map<string, number>;
  isOnline: (accountId: string) => boolean;
  hasRecentInboundReachability: (accountId: string) => boolean;
  sleepMs: (ms: number) => Promise<void>;
  schedulePushDrain: (delayMs: number) => void;
  outboxDrainSchedule: BncrOutboxDrainScheduleRuntime;
  tryPushEntry: (entry: OutboxEntry) => Promise<boolean>;
  handleFileTransferPushFailure: (args: { entry: OutboxEntry; error: unknown }) => void;
  handleTextPushFailure: (args: { entry: OutboxEntry; error: unknown }) => void;
  isPlainObject: (value: unknown) => value is Record<string, unknown>;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  pushDrainStuckWarnMs: number;
  pushDrainIntervalMs: number;
  pushDrainAccountTimeBudgetMs: number;
  pushDrainAccountBudget: number;
};

export function createBncrOutboxDrainLoop(
  runtime: BncrOutboxDrainLoopRuntime,
  handlers: {
    handlePushedDrainEntry: (args: {
      accountId: string;
      entry: OutboxEntry;
      onlineNow: boolean;
      recentInboundReachable: boolean;
      localNextDelay: number | null;
      updateMinOutboxDelay: typeof updateMinOutboxDelay;
    }) => Promise<{ action: 'continue' | 'break'; localNextDelay: number | null }>;
    handleFailedDrainEntry: (args: {
      accountId: string;
      entry: OutboxEntry;
      localNextDelay: number | null;
      attemptedAt: number;
      updateMinOutboxDelay: typeof updateMinOutboxDelay;
    }) => { action: 'continue' | 'break'; localNextDelay: number | null };
  },
) {
  // Flow order in this module is intentional:
  // 1) account selection helpers
  // 2) drain observability and next-entry lookup
  // 3) single-entry push attempt
  // 4) per-account cooperative loop
  // 5) per-account cycle orchestration
  // 6) global flush entrypoint

  // Account-scoped queue selectors -----------------------------------------

  const buildAccountEntries = (accountId: string) => {
    return listAccountOutboxEntries({
      accountId,
      outboxEntries: runtime.outbox.values(),
      normalizeAccountId: runtime.normalizeAccountId,
    });
  };

  // Re-entrant drains are expected under heavy ACK / retry churn. This warning
  // path is the observability guardrail for drains that stop making progress.

  // Drain observability / next-entry selection ------------------------------
  function maybeLogOutboxDrainStuck(args: { accountId: string; trigger: string; reason: string }) {
    const acc = runtime.normalizeAccountId(args.accountId);
    const startedAt = runtime.pushDrainRunningSinceByAccount.get(acc) || 0;
    if (!startedAt) return;

    const t = runtime.now();
    const runningMs = Math.max(0, t - startedAt);
    if (runningMs < runtime.pushDrainStuckWarnMs) return;

    const lastWarnedAt = runtime.pushDrainStuckWarnedAtByAccount.get(acc) || 0;
    if (lastWarnedAt && t - lastWarnedAt < runtime.pushDrainStuckWarnMs) return;

    const pendingEntries = runtime.getAccountPendingOutboxEntries(acc);
    const pending = pendingEntries.length;
    if (!pending) return;

    runtime.pushDrainStuckWarnedAtByAccount.set(acc, t);
    runtime.logWarn(
      'outbox drain stuck',
      `accountId=${acc}|pending=${pending}|runningMs=${runningMs}|waiters=${runtime.messageAckWaiterCount()}/${runtime.fileAckWaiterCount()}`,
    );
    runtime.logInfo(
      'outbox',
      `drain-stuck ${JSON.stringify(
        buildOutboxDrainStuckDebugInfo({
          bridgeId: runtime.bridgeId,
          accountId: acc,
          reason: args.reason,
          trigger: args.trigger,
          outboxSize: runtime.outbox.size,
          pending,
          runningMs,
          runningSince: startedAt,
          hasGatewayContext: runtime.gatewayContextAvailable(),
          activeConnectionCount: runtime.activeConnectionCount(acc),
          messageAckWaiters: runtime.messageAckWaiterCount(),
          fileAckWaiters: runtime.fileAckWaiterCount(),
          pendingEntries,
          connections: runtime.connectionsValues(),
        }),
      )}`,
      { debugOnly: true },
    );
  }

  function resolveNextDrainEntry(args: {
    accountId: string;
    attemptedAt: number;
    localNextDelay: number | null;
  }): {
    entry: OutboxEntry | null;
    localNextDelay: number | null;
    shouldBreak: boolean;
  } {
    const { accountId, attemptedAt } = args;
    let { localNextDelay } = args;
    const entries = buildAccountEntries(accountId);

    if (!entries.length) {
      return { entry: null, localNextDelay, shouldBreak: true };
    }

    const entry = findDueOutboxEntry(entries, attemptedAt);
    if (entry) {
      return { entry, localNextDelay, shouldBreak: false };
    }

    const wait = computeNextOutboxDelay(entries, attemptedAt);
    if (wait != null) {
      localNextDelay = runtime.outboxDrainSchedule.scheduleAccountWait({
        accountId,
        source: OUTBOUND_SCHEDULE_SOURCE.ACCOUNT_NO_DUE_ENTRY,
        wait,
        localNextDelay,
        updateMinOutboxDelay,
      });
    }

    return { entry: null, localNextDelay, shouldBreak: true };
  }

  // One push attempt decides whether the loop continues immediately, waits for
  // retry scheduling, or exits back to the caller with a next-delay hint.

  // Single-entry push attempt ------------------------------------------------

  async function attemptDrainEntryPush(args: {
    accountId: string;
    entry: OutboxEntry;
    localNextDelay: number | null;
    attemptedAt: number;
  }): Promise<{ action: 'continue' | 'break'; localNextDelay: number | null }> {
    const { accountId, entry, attemptedAt } = args;
    const { localNextDelay } = args;
    const onlineNow = runtime.isOnline(accountId);
    const recentInboundReachable = runtime.hasRecentInboundReachability(accountId);
    let pushed = false;
    try {
      pushed = await runtime.tryPushEntry(entry);
    } catch (error) {
      const meta = runtime.isPlainObject(entry.payload?._meta) ? entry.payload._meta : null;
      if (meta?.kind === 'file-transfer') {
        runtime.handleFileTransferPushFailure({ entry, error });
      } else {
        runtime.handleTextPushFailure({ entry, error });
      }
      pushed = false;
    }

    if (pushed) {
      return await handlers.handlePushedDrainEntry({
        accountId,
        entry,
        onlineNow,
        recentInboundReachable,
        localNextDelay,
        updateMinOutboxDelay,
      });
    }

    if (!runtime.outbox.has(entry.messageId)) {
      await runtime.sleepMs(runtime.pushDrainIntervalMs);
      return { action: 'continue', localNextDelay };
    }

    return handlers.handleFailedDrainEntry({
      accountId,
      entry,
      localNextDelay,
      attemptedAt,
      updateMinOutboxDelay,
    });
  }

  // The inner account loop yields cooperatively before it monopolizes the
  // bridge. That keeps multi-account drains and ACK callbacks responsive.

  // Per-account drain loop --------------------------------------------------

  function shouldYieldAccountDrain(args: {
    accountId: string;
    processedThisRun: number;
    accountDrainStartedAt: number;
    localNextDelay: number | null;
  }): { shouldBreak: boolean; localNextDelay: number | null } {
    const { accountId, processedThisRun, accountDrainStartedAt } = args;
    let { localNextDelay } = args;

    if (
      shouldYieldAccountDrainForTimeBudget({
        processedThisRun,
        accountDrainStartedAt,
        now: runtime.now(),
        pushDrainAccountTimeBudgetMs: runtime.pushDrainAccountTimeBudgetMs,
      })
    ) {
      localNextDelay = scheduleAccountYieldForBudget({
        accountId,
        source: OUTBOUND_SCHEDULE_SOURCE.ACCOUNT_TIME_BUDGET_YIELD,
        localNextDelay,
        scheduleAccountYield: runtime.outboxDrainSchedule.scheduleAccountYield,
      });
      return { shouldBreak: true, localNextDelay };
    }

    if (
      shouldYieldAccountDrainForEntryBudget({
        processedThisRun,
        pushDrainAccountBudget: runtime.pushDrainAccountBudget,
      })
    ) {
      localNextDelay = scheduleAccountYieldForBudget({
        accountId,
        source: OUTBOUND_SCHEDULE_SOURCE.ACCOUNT_BUDGET_YIELD,
        localNextDelay,
        scheduleAccountYield: runtime.outboxDrainSchedule.scheduleAccountYield,
      });
      return { shouldBreak: true, localNextDelay };
    }

    return { shouldBreak: false, localNextDelay };
  }

  async function drainAccountOutbox(args: { accountId: string }): Promise<number | null> {
    const { accountId } = args;
    let localNextDelay: number | null = null;
    let processedThisRun = 0;
    const accountDrainStartedAt = runtime.now();

    while (true) {
      if (runtime.stopped()) break;
      const yieldCheck = shouldYieldAccountDrain({
        accountId,
        processedThisRun,
        accountDrainStartedAt,
        localNextDelay,
      });
      localNextDelay = yieldCheck.localNextDelay;
      if (yieldCheck.shouldBreak) break;
      const t = runtime.now();
      const nextEntry = resolveNextDrainEntry({
        accountId,
        attemptedAt: t,
        localNextDelay,
      });
      localNextDelay = nextEntry.localNextDelay;
      if (nextEntry.shouldBreak || !nextEntry.entry) break;

      processedThisRun += 1;
      const result = await attemptDrainEntryPush({
        accountId,
        entry: nextEntry.entry,
        localNextDelay,
        attemptedAt: t,
      });
      localNextDelay = result.localNextDelay;
      if (result.action === 'continue') continue;
      break;
    }

    return localNextDelay;
  }

  // A drain cycle owns one account at a time: emit state, prevent re-entry,
  // run the account loop, then merge any next-delay back into the global flush.

  // Per-account cycle orchestration ----------------------------------------

  async function runAccountDrainCycle(args: {
    accountId: string;
    trigger: string;
    reason?: string;
    globalNextDelay: number | null;
  }): Promise<number | null> {
    const { accountId, trigger, reason } = args;
    let { globalNextDelay } = args;

    if (runtime.pushDrainRunningAccounts.has(accountId)) {
      runtime.logInfo(
        'outbox',
        `drain-skip ${JSON.stringify(
          buildOutboxDrainSkipDebugInfo({
            bridgeId: runtime.bridgeId,
            accountId,
            reason: 'already-running',
            outboxSize: runtime.outbox.size,
            trigger,
          }),
        )}`,
        { debugOnly: true },
      );
      maybeLogOutboxDrainStuck({
        accountId,
        trigger,
        reason: reason || 'already-running',
      });
      return globalNextDelay;
    }

    const online = runtime.isOnline(accountId);
    const recentInboundReachable = runtime.hasRecentInboundReachability(accountId);
    runtime.logInfo(
      'outbox',
      `online ${JSON.stringify(
        buildOutboxOnlineDebugInfo({
          bridgeId: runtime.bridgeId,
          accountId,
          online,
          recentInboundReachable,
          connections: runtime.connectionsValues(),
        }),
      )}`,
      { debugOnly: true },
    );

    runtime.pushDrainRunningAccounts.add(accountId);
    runtime.pushDrainRunningSinceByAccount.set(accountId, runtime.now());
    runtime.pushDrainStuckWarnedAtByAccount.delete(accountId);
    try {
      const localNextDelay = await drainAccountOutbox({ accountId });
      if (localNextDelay != null) {
        globalNextDelay = runtime.outboxDrainSchedule.mergeAccountNextDelay({
          accountId,
          localNextDelay,
          globalNextDelay,
          updateMinOutboxDelay,
          source: OUTBOUND_SCHEDULE_SOURCE.ACCOUNT_NEXT_DELAY_MERGE,
        });
      }
    } finally {
      runtime.pushDrainRunningAccounts.delete(accountId);
      runtime.pushDrainRunningSinceByAccount.delete(accountId);
      runtime.pushDrainStuckWarnedAtByAccount.delete(accountId);
    }

    return globalNextDelay;
  }

  // Global flush entrypoint -------------------------------------------------

  async function flushPushQueue(args?: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }): Promise<void> {
    if (runtime.stopped()) return;
    const { filterAcc, trigger, reason } = normalizeFlushPushQueueArgs(args, {
      asString: runtime.asString,
      normalizeAccountId: runtime.normalizeAccountId,
    });
    const targetAccounts = selectOutboxTargetAccounts({
      accountId: filterAcc,
      outboxEntries: runtime.outbox.values(),
      normalizeAccountId: runtime.normalizeAccountId,
    });
    runtime.logInfo(
      'outbox',
      `flush ${JSON.stringify(
        buildFlushDebugInfo({
          bridgeId: runtime.bridgeId,
          accountId: filterAcc,
          targetAccounts,
          outboxSize: runtime.outbox.size,
          trigger,
          reason,
        }),
      )}`,
      { debugOnly: true },
    );

    let globalNextDelay: number | null = null;

    for (const acc of targetAccounts) {
      if (!acc) continue;
      globalNextDelay = await runAccountDrainCycle({
        accountId: acc,
        trigger,
        reason,
        globalNextDelay,
      });
    }

    if (globalNextDelay != null) {
      runtime.outboxDrainSchedule.scheduleFlushNextDrain({
        globalNextDelay,
        source: OUTBOUND_SCHEDULE_SOURCE.FLUSH_NEXT_DRAIN,
      });
      runtime.schedulePushDrain(globalNextDelay);
    }
  }

  return {
    maybeLogOutboxDrainStuck,
    runAccountDrainCycle,
    flushPushQueue,
  };
}
