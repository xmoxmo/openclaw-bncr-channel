import type { OutboxEntry } from '../core/types.ts';
import type {
  PushFailureDecision,
  RetryRerouteDecision,
} from '../messaging/outbound/retry-policy.ts';

export function applyBncrRetryRerouteDecisionToEntry(
  entry: OutboxEntry,
  decision: Extract<RetryRerouteDecision, { kind: 'retry' }>,
): OutboxEntry {
  return {
    ...entry,
    routeAttemptConnIds: decision.attemptedConnIds,
    fastReroutePending: decision.fastReroutePending,
    retryCount: decision.nextRetryCount,
    lastAttemptAt: decision.lastAttemptAt,
    nextAttemptAt: decision.nextAttemptAt,
    lastError: decision.lastError,
    routeAttemptRound: decision.routeAttemptRound,
  };
}

export function applyBncrPushFailureDecisionToEntry(
  entry: OutboxEntry,
  decision: Extract<PushFailureDecision, { kind: 'retry' }>,
): OutboxEntry {
  return {
    ...entry,
    retryCount: decision.nextRetryCount,
    lastAttemptAt: decision.lastAttemptAt,
    nextAttemptAt: decision.nextAttemptAt,
    lastError: decision.lastError,
  };
}

export function buildBncrAckRetryEntryPatch(args: {
  entry: OutboxEntry;
  error: string;
  nextAttemptAt: number;
}): OutboxEntry {
  return {
    ...args.entry,
    nextAttemptAt: args.nextAttemptAt,
    lastError: args.error,
    awaitingRetryPush: true,
  };
}

export function buildBncrOutboxFailureEntryPatch(args: {
  entry: OutboxEntry;
  lastError: string;
}): OutboxEntry {
  return {
    ...args.entry,
    lastError: args.lastError,
  };
}

export function buildBncrOutboxPushSuccessEntryPatch(args: {
  entry: OutboxEntry;
  connIds: Iterable<string>;
  pushedAt: number;
  ownerConnId?: string;
  ownerClientId?: string;
  clearLastError?: boolean;
}): OutboxEntry {
  const connIds = Array.from(args.connIds);
  const lastPushConnId = args.ownerConnId || (connIds.length === 1 ? connIds[0] : undefined);
  const routeAttemptConnIds = Array.isArray(args.entry.routeAttemptConnIds)
    ? [...args.entry.routeAttemptConnIds]
    : [];
  if (lastPushConnId && !routeAttemptConnIds.includes(lastPushConnId)) {
    routeAttemptConnIds.push(lastPushConnId);
  }
  return {
    ...args.entry,
    lastPushAt: args.pushedAt,
    lastPushConnId,
    lastPushClientId: args.ownerClientId,
    awaitingRetryPush: false,
    routeAttemptConnIds,
    lastError: args.clearLastError ? undefined : args.entry.lastError,
  };
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function buildBncrAckOkTelemetryPatch(args: {
  entry: OutboxEntry;
  ackAt: number;
  defaultAckTimeoutMs: number;
}): {
  ackAt: number;
  ackQueueLatencyMs: number;
  ackPushLatencyMs: number | null;
  lateAccepted: boolean;
  shouldResetAdaptiveAckRecovery: boolean;
  shouldIncrementAdaptiveAckRecovery: boolean;
} {
  const ackAt = finiteNumberOr(args.ackAt, 0);
  const defaultAckTimeoutMs = Math.max(0, finiteNumberOr(args.defaultAckTimeoutMs, 0));
  const ackQueueLatencyMs = Math.max(0, ackAt - finiteNumberOr(args.entry.createdAt, ackAt));
  const ackPushLatencyMs =
    typeof args.entry.lastPushAt === 'number' ? Math.max(0, ackAt - args.entry.lastPushAt) : null;
  const lateAccepted = args.entry.awaitingRetryPush === true;
  return {
    ackAt,
    ackQueueLatencyMs,
    ackPushLatencyMs,
    lateAccepted,
    shouldResetAdaptiveAckRecovery: lateAccepted,
    shouldIncrementAdaptiveAckRecovery:
      !lateAccepted &&
      typeof ackPushLatencyMs === 'number' &&
      ackPushLatencyMs <= defaultAckTimeoutMs,
  };
}
