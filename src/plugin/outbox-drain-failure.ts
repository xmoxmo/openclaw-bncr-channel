import type { OutboxEntry } from '../core/types.ts';
import { computeOutboxRetryWait } from '../messaging/outbound/queue-selectors.ts';
import { OUTBOUND_SCHEDULE_SOURCE } from '../messaging/outbound/reasons.ts';
import { computePushFailureDecision } from '../messaging/outbound/retry-policy.ts';
import { applyBncrPushFailureDecisionToEntry } from '../runtime/outbox-transitions.ts';

type UpdateMinOutboxDelay = (current: number | null, candidate: number | null) => number | null;

type BncrOutboxDrainScheduleRuntime = {
  scheduleAccountWait: (args: {
    accountId: string;
    messageId?: string;
    source: string;
    wait: number;
    localNextDelay: number | null;
    updateMinOutboxDelay: UpdateMinOutboxDelay;
  }) => number | null;
};

type BncrOutboxDrainFailureRuntime = {
  backoffMs: (retryCount: number) => number;
  outbox: Map<string, OutboxEntry>;
  resolveAccountIdForSession: (sessionKey: string) => string | null;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  isPrePushGuardDeferral: (entry: OutboxEntry) => boolean;
  moveToDeadLetter: (entry: OutboxEntry, reason: string) => void;
  scheduleSave: () => void;
  outboxDrainSchedule: BncrOutboxDrainScheduleRuntime;
  maxRetry: number;
  prePushGuardRetryDelayMs: number;
};

export function createBncrOutboxDrainFailure(runtime: BncrOutboxDrainFailureRuntime) {
  return function handleFailedDrainEntry(args: {
    accountId: string;
    entry: OutboxEntry;
    localNextDelay: number | null;
    attemptedAt: number;
    updateMinOutboxDelay: UpdateMinOutboxDelay;
  }): { action: 'continue' | 'break'; localNextDelay: number | null } {
    const { accountId, entry, attemptedAt, updateMinOutboxDelay } = args;
    let { localNextDelay } = args;

    // If the entry keeps hitting pre-push guard (no active connection), the
    // accountId on the entry might be wrong (e.g. constructed from route data).
    // Try to correct it from recent inbound session context before giving up.
    if (runtime.isPrePushGuardDeferral(entry) && entry.retryCount > 0) {
      const corrected = runtime.resolveAccountIdForSession(entry.sessionKey);
      if (corrected && corrected !== entry.accountId) {
        const oldAccountId = entry.accountId;
        runtime.logWarn(
          'outbound',
          `account corrected sessionKey=${entry.sessionKey} ${oldAccountId}→${corrected}`,
        );
        runtime.logInfo(
          'outbound',
          JSON.stringify({
            event: 'account-corrected',
            messageId: entry.messageId,
            sessionKey: entry.sessionKey,
            oldAccountId,
            corrected,
            retryCount: entry.retryCount,
            lastError: entry.lastError,
          }),
          { debugOnly: true },
        );
        entry.accountId = corrected;
        entry.retryCount = 0;
        entry.lastError = undefined;
        runtime.outbox.set(entry.messageId, entry);
        runtime.scheduleSave();
        return { action: 'continue', localNextDelay };
      }
    }

    if (runtime.isPrePushGuardDeferral(entry)) {
      const wait = runtime.prePushGuardRetryDelayMs;
      localNextDelay = runtime.outboxDrainSchedule.scheduleAccountWait({
        accountId,
        messageId: entry.messageId,
        source: OUTBOUND_SCHEDULE_SOURCE.PRE_PUSH_GUARD_WAIT,
        wait,
        localNextDelay,
        updateMinOutboxDelay,
      });
      return { action: 'break', localNextDelay };
    }

    const decision = computePushFailureDecision(
      {
        nowMs: attemptedAt,
        maxRetry: runtime.maxRetry,
        currentRetryCount: entry.retryCount,
        lastError: entry.lastError,
      },
      { backoffMs: runtime.backoffMs },
    );
    if (decision.kind === 'dead-letter') {
      runtime.moveToDeadLetter(entry, decision.terminalReason);
      return { action: 'continue', localNextDelay };
    }

    const nextEntry = applyBncrPushFailureDecisionToEntry(entry, decision);
    runtime.outbox.set(entry.messageId, nextEntry);
    runtime.scheduleSave();

    const wait = computeOutboxRetryWait(decision.nextAttemptAt, attemptedAt);
    localNextDelay = runtime.outboxDrainSchedule.scheduleAccountWait({
      accountId,
      messageId: entry.messageId,
      source: OUTBOUND_SCHEDULE_SOURCE.PUSH_FAIL_WAIT,
      wait,
      localNextDelay,
      updateMinOutboxDelay,
    });
    return { action: 'break', localNextDelay };
  };
}
