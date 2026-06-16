import type { OutboxEntry } from '../core/types.ts';
import type { updateMinOutboxDelay } from '../messaging/outbound/queue-selectors.ts';
import type { RetryRerouteDecision } from '../messaging/outbound/retry-policy.ts';
import { createBncrOutboxDrainFailure } from './outbox-drain-failure.ts';
import { createBncrOutboxDrainLoop } from './outbox-drain-loop.ts';
import { createBncrOutboxDrainPostPush } from './outbox-drain-post-push.ts';

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

type BncrOutboxDrainAckRuntime = {
  logAckWaitStart: (args: {
    entry: OutboxEntry;
    requireAck: boolean;
    ackTimeoutMs: number | null;
    onlineNow: boolean;
    recentInboundReachable: boolean;
  }) => void;
  handleAckTimeoutReroute: (args: {
    accountId: string;
    entry: OutboxEntry;
    requireAck: boolean;
    currentConnId: string;
    availableConnIds: string[];
    decision: RetryRerouteDecision;
    localNextDelay: number | null;
    ackTimeoutMs: number | null;
    updateMinOutboxDelay: typeof updateMinOutboxDelay;
  }) => { kind: 'dead-letter' } | { kind: 'retry'; localNextDelay: number | null };
};

type BncrOutboxDrainRuntime = {
  bridgeId: string;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  backoffMs: (retryCount: number) => number;
  isPlainObject: (value: unknown) => value is Record<string, unknown>;
  normalizeAccountId: (accountId: string) => string;
  stopped: () => boolean;
  outbox: Map<string, OutboxEntry>;
  deadLetter: () => OutboxEntry[];
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
  isOutboundAckRequired: (accountId?: string) => boolean;
  resolveMessageAckTimeoutMs: (accountId: string) => number;
  waitForMessageAck: (messageId: string, waitMs: number) => Promise<'acked' | 'timeout'>;
  logOutboxAckWait: (args: {
    entry: OutboxEntry;
    requireAck: boolean;
    ackResult: 'acked' | 'timeout';
    onlineNow: boolean;
    recentInboundReachable: boolean;
    ackTimeoutMs: number | null;
  }) => void;
  degradeOutboundCapability: (args: {
    accountId: string;
    connId?: string;
    clientId?: string;
    reason: string;
  }) => void;
  resolvePushConnIds: (accountId: string) => Iterable<string>;
  sleepMs: (ms: number) => Promise<void>;
  schedulePushDrain: (delayMs: number) => void;
  outboxDrainSchedule: BncrOutboxDrainScheduleRuntime;
  outboxDrainAck: BncrOutboxDrainAckRuntime;
  tryPushEntry: (entry: OutboxEntry) => Promise<boolean>;
  handleFileTransferPushFailure: (args: { entry: OutboxEntry; error: unknown }) => void;
  handleTextPushFailure: (args: { entry: OutboxEntry; error: unknown }) => void;
  isPrePushGuardDeferral: (entry: OutboxEntry) => boolean;
  moveToDeadLetter: (entry: OutboxEntry, reason: string) => void;
  scheduleSave: () => void;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logError: (scope: string, message: string) => void;
  flushTriggerTimer: string;
  flushReasonScheduledDrain: string;
  pushDrainExceptionRetryLimit: number;
  pushDrainExceptionRetryDelayMs: number;
  pushDrainStuckWarnMs: number;
  pushDrainIntervalMs: number;
  pushDrainAccountTimeBudgetMs: number;
  pushDrainAccountBudget: number;
  pushAckTimeoutMs: number;
  maxRetry: number;
  prePushGuardRetryDelayMs: number;
};

export function createBncrOutboxDrainRuntime(runtime: BncrOutboxDrainRuntime) {
  const handlePushedDrainEntry = createBncrOutboxDrainPostPush(runtime);
  const handleFailedDrainEntry = createBncrOutboxDrainFailure(runtime);

  return createBncrOutboxDrainLoop(runtime, {
    handlePushedDrainEntry,
    handleFailedDrainEntry,
  });
}
