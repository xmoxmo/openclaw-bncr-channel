import { buildOutboxScheduleDebugInfo } from '../messaging/outbound/diagnostics.ts';
import { clampOutboxDrainDelay } from '../messaging/outbound/queue-selectors.ts';
import {
  OUTBOUND_FLUSH_REASON,
  OUTBOUND_FLUSH_TRIGGER,
  OUTBOUND_SCHEDULE_SOURCE,
} from '../messaging/outbound/reasons.ts';
import { buildFlushBestEffortError } from './bridge-surface-helpers.ts';

export function createBncrBridgeDrainFacade(runtime: {
  bridgeId: string;
  asString: (value: unknown, fallback?: string) => string;
  normalizeAccountId: (accountId: string) => string;
  getApi: () => unknown;
  getStopped: () => boolean;
  getPushTimer: () => NodeJS.Timeout | null;
  setPushTimer: (timer: NodeJS.Timeout | null) => void;
  getRetryCount: () => number;
  setRetryCount: (count: number) => void;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logError: (scope: string, message: string) => void;
  flushPushQueue: (args?: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }) => Promise<void>;
  schedulePushDrain: (delayMs?: number) => void;
  resolveOutboundAckRequired: (args: { api: unknown; accountId?: string }) => boolean;
  retryLimit: number;
  retryDelayMs: number;
}) {
  const schedulePushDrain = (delayMs = 0) => {
    if (runtime.getStopped()) return;
    if (runtime.getPushTimer()) return;
    const delay = clampOutboxDrainDelay(delayMs);
    runtime.logInfo(
      'outbox',
      `schedule ${JSON.stringify(
        buildOutboxScheduleDebugInfo({
          bridgeId: runtime.bridgeId,
          source: OUTBOUND_SCHEDULE_SOURCE.SCHEDULE_PUSH_DRAIN,
          wait: delay,
        }),
      )}`,
      { debugOnly: true },
    );
    runtime.setPushTimer(
      setTimeout(() => {
        runtime.setPushTimer(null);
        if (runtime.getStopped()) return;
        flushPushQueueBestEffort({
          trigger: OUTBOUND_FLUSH_TRIGGER.TIMER,
          reason: OUTBOUND_FLUSH_REASON.SCHEDULED_DRAIN,
        });
      }, delay),
    );
  };

  const flushPushQueueBestEffort = (args?: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }) => {
    void runtime
      .flushPushQueue(args)
      .then(() => {
        runtime.setRetryCount(0);
      })
      .catch((error) => {
        const nextRetryCount = runtime.getRetryCount() + 1;
        const flushError = buildFlushBestEffortError({
          accountId: args?.accountId,
          trigger: args?.trigger,
          reason: args?.reason,
          error,
          asString: runtime.asString,
          normalizeAccountId: runtime.normalizeAccountId,
          nextRetryCount,
          retryLimit: runtime.retryLimit,
        });
        runtime.setRetryCount(nextRetryCount);
        runtime.logError(
          'outbox drain fail',
          `accountId=${flushError.accountId || '-'}|reason=${flushError.reason}|err=${flushError.err}|retry=${flushError.retryDisplay}|limit=${runtime.retryLimit}`,
        );
        if (flushError.willRetry) runtime.schedulePushDrain(runtime.retryDelayMs);
      });
  };

  const isOutboundAckRequired = (accountId?: string) =>
    runtime.resolveOutboundAckRequired({ api: runtime.getApi(), accountId });

  return {
    schedulePushDrain,
    flushPushQueueBestEffort,
    isOutboundAckRequired,
  };
}
