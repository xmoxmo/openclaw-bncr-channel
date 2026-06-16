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
