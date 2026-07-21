import type {
  BncrAckObservability,
  BncrExtendedOutboundDiagnostics,
  BncrOutboxIncidentSummary,
  BncrOutboxQueueDiagnostics,
  OutboxEntry,
} from '../../core/types.ts';
import { finiteNumberOrNull } from '../../core/value-sanitize.ts';

export {
  buildFlushDebugInfo,
  buildOutboxAckDebugInfo,
  buildOutboxDrainSkipDebugInfo,
  buildOutboxDrainStuckDebugInfo,
  buildOutboxPushOkDebugInfo,
  buildOutboxPushSkipDebugInfo,
  buildOutboxRouteSelectDebugInfo,
  buildOutboxScheduleDebugInfo,
  buildPushFailureDebugInfo,
  buildRetryRerouteDebugInfo,
} from './diagnostics-debug-builders.ts';

type OutboxIncidentSummaryInput = {
  pending: number;
  oldestPendingAt?: number | null;
  lastAttemptAt?: number | null;
  lastPushAt?: number | null;
  lastPushError?: string | null;
  hasGatewayContext: boolean;
  activeOutboundConnection: boolean;
  activeOutboundConnectionCount: number;
  prePushGuardSkipCount?: number;
  lastPrePushGuardSkipAt?: number | null;
  lastPrePushGuardSkipReason?: string | null;
  lastAckQueueLatencyMs?: number | null;
  lastAckPushLatencyMs?: number | null;
  lastLateAckQueueLatencyMs?: number | null;
  lastLateAckPushLatencyMs?: number | null;
  lastLateAckOkAt?: number | null;
  adaptiveAckTimeoutMs?: number | null;
  adaptiveAckTimeoutReason?: string | null;
  nowMs?: number;
};

function positiveAgeMs(nowMs: number, at: unknown): number | null {
  const n = finiteNumberOrNull(at);
  if (n === null || n < 0) return null;
  return Math.max(0, nowMs - n);
}

export function buildOutboxIncidentSummary(
  input: OutboxIncidentSummaryInput,
): BncrOutboxIncidentSummary {
  const pending = Math.max(0, Math.floor(finiteNumberOrNull(input.pending) || 0));
  const nowMs = finiteNumberOrNull(input.nowMs) || Date.now();
  const lastPushError =
    typeof input.lastPushError === 'string' && input.lastPushError ? input.lastPushError : null;
  const lastPrePushGuardSkipReason =
    typeof input.lastPrePushGuardSkipReason === 'string' && input.lastPrePushGuardSkipReason
      ? input.lastPrePushGuardSkipReason
      : null;
  const oldestPendingAgeMs = positiveAgeMs(nowMs, input.oldestPendingAt);
  const lastLateAckAgeMs = positiveAgeMs(nowMs, input.lastLateAckOkAt);
  const adaptiveAckTimeoutReason =
    typeof input.adaptiveAckTimeoutReason === 'string' && input.adaptiveAckTimeoutReason
      ? input.adaptiveAckTimeoutReason
      : null;
  const hasRecentLateAck = lastLateAckAgeMs !== null && lastLateAckAgeMs <= 3_600_000;
  const hasActiveAdaptiveAck =
    adaptiveAckTimeoutReason !== null &&
    ![
      'no-timeout-evidence',
      'no-late-ack-evidence',
      'missing-latency',
      'late-ack-expired',
      'recovered',
    ].includes(adaptiveAckTimeoutReason);

  let type = 'none';
  let severity: 'ok' | 'warning' | 'critical' = 'ok';
  let recommendedAction = 'none';

  if (pending > 0 && !input.hasGatewayContext) {
    type = 'no-gateway-context';
    severity = 'critical';
    recommendedAction = 'check-channel-message-runtime-context';
  } else if (pending > 0 && !input.activeOutboundConnection) {
    type = 'no-active-outbound-connection';
    severity = 'critical';
    recommendedAction = 'reconnect-bncr-client';
  } else if (pending > 0 && lastPrePushGuardSkipReason) {
    type = lastPrePushGuardSkipReason;
    severity = 'warning';
    recommendedAction = 'inspect-pre-push-guard';
  } else if (pending > 0 && lastPushError) {
    type =
      lastPushError.includes('ack') || lastPushError.includes('timeout')
        ? 'ack-timeout'
        : lastPushError;
    severity = type === 'ack-timeout' ? 'critical' : 'warning';
    recommendedAction = 'inspect-ack-and-route-state';
  } else if (pending > 0 && oldestPendingAgeMs !== null && oldestPendingAgeMs >= 120_000) {
    type = 'outbox-backlog';
    severity = 'warning';
    recommendedAction = 'inspect-outbox-drain';
  } else if (pending > 0) {
    type = 'pending-outbox';
    severity = 'warning';
    recommendedAction = 'inspect-outbox-drain';
  } else if (hasRecentLateAck || hasActiveAdaptiveAck) {
    type = 'slow-or-late-ack';
    severity = 'warning';
    recommendedAction = 'inspect-ack-latency';
  }

  return {
    active: type !== 'none',
    type,
    severity,
    recommendedAction,
    pending,
    oldestPendingAgeMs,
    lastAttemptAgeMs: positiveAgeMs(nowMs, input.lastAttemptAt),
    lastPushAgeMs: positiveAgeMs(nowMs, input.lastPushAt),
    lastPushError,
    hasGatewayContext: input.hasGatewayContext,
    activeOutboundConnection: input.activeOutboundConnection,
    activeOutboundConnectionCount: Math.max(
      0,
      Math.floor(finiteNumberOrNull(input.activeOutboundConnectionCount) || 0),
    ),
    prePushGuardSkipCount: Math.max(
      0,
      Math.floor(finiteNumberOrNull(input.prePushGuardSkipCount) || 0),
    ),
    lastPrePushGuardSkipAgeMs: positiveAgeMs(nowMs, input.lastPrePushGuardSkipAt),
    lastPrePushGuardSkipReason,
    ack: {
      lastQueueLatencyMs: finiteNumberOrNull(input.lastAckQueueLatencyMs),
      lastPushLatencyMs: finiteNumberOrNull(input.lastAckPushLatencyMs),
      lastLateQueueLatencyMs: finiteNumberOrNull(input.lastLateAckQueueLatencyMs),
      lastLatePushLatencyMs: finiteNumberOrNull(input.lastLateAckPushLatencyMs),
      lastLateAckAgeMs,
      adaptiveTimeoutMs: finiteNumberOrNull(input.adaptiveAckTimeoutMs),
      adaptiveTimeoutReason: adaptiveAckTimeoutReason,
    },
  };
}

export function buildExtendedOutboundDiagnostics(input: {
  outbox: BncrOutboxQueueDiagnostics;
  enqueueCount: number;
  lastEnqueueAt?: number | null;
  prePushGuardSkipCount: number;
  lastPrePushGuardSkipAt?: number | null;
  lastPrePushGuardSkipReason?: string | null;
  hasGatewayContext: boolean;
  lastGatewayContextAt?: number | null;
  ackObservability: BncrAckObservability;
  nowMs?: number;
}): BncrExtendedOutboundDiagnostics {
  const lastEnqueueAt = finiteNumberOrNull(input.lastEnqueueAt);
  const lastPrePushGuardSkipAt = finiteNumberOrNull(input.lastPrePushGuardSkipAt);
  const lastGatewayContextAt = finiteNumberOrNull(input.lastGatewayContextAt);
  return {
    ...input.outbox,
    enqueueCount: input.enqueueCount,
    lastEnqueueAt,
    prePushGuardSkipCount: input.prePushGuardSkipCount,
    lastPrePushGuardSkipAt,
    lastPrePushGuardSkipReason: input.lastPrePushGuardSkipReason || null,
    hasGatewayContext: input.hasGatewayContext,
    lastGatewayContextAt,
    incident: buildOutboxIncidentSummary({
      ...input.outbox,
      pending: Number(input.outbox.pending) || 0,
      hasGatewayContext: input.hasGatewayContext,
      activeOutboundConnection: Boolean(input.outbox.activeOutboundConnection),
      activeOutboundConnectionCount: Number(input.outbox.activeOutboundConnectionCount) || 0,
      prePushGuardSkipCount: input.prePushGuardSkipCount,
      lastPrePushGuardSkipAt,
      lastPrePushGuardSkipReason: input.lastPrePushGuardSkipReason || null,
      lastAckQueueLatencyMs: input.ackObservability.lastAckQueueLatencyMs,
      lastAckPushLatencyMs: input.ackObservability.lastAckPushLatencyMs,
      lastLateAckQueueLatencyMs: input.ackObservability.lastLateAckQueueLatencyMs,
      lastLateAckPushLatencyMs: input.ackObservability.lastLateAckPushLatencyMs,
      lastLateAckOkAt: input.ackObservability.lastLateAckOkAt,
      adaptiveAckTimeoutMs: input.ackObservability.currentAckTimeoutMs,
      adaptiveAckTimeoutReason: input.ackObservability.recommendedAckTimeoutReason,
      nowMs: input.nowMs,
    }),
  };
}

export function buildOutboxQueueDiagnostics(args: {
  accountId: string;
  outboxEntries: Iterable<OutboxEntry>;
  pendingAllAccounts: number;
  pushConnIds: Iterable<string>;
}): BncrOutboxQueueDiagnostics {
  const accountEntries = Array.from(args.outboxEntries).filter(
    (entry) => entry.accountId === args.accountId,
  );
  let oldestPendingAt: number | null = null;
  let newestPendingAt: number | null = null;
  let lastAttemptAt: number | null = null;
  let lastPushAt: number | null = null;
  let lastError: string | null = null;

  for (const entry of accountEntries) {
    const createdAt = Number(entry.createdAt);
    if (Number.isFinite(createdAt)) {
      oldestPendingAt = oldestPendingAt === null ? createdAt : Math.min(oldestPendingAt, createdAt);
      newestPendingAt = newestPendingAt === null ? createdAt : Math.max(newestPendingAt, createdAt);
    }
    const attemptAt = Number(entry.lastAttemptAt);
    if (Number.isFinite(attemptAt) && (lastAttemptAt === null || attemptAt > lastAttemptAt)) {
      lastAttemptAt = attemptAt;
    }
    const pushAt = Number(entry.lastPushAt);
    if (Number.isFinite(pushAt) && (lastPushAt === null || pushAt > lastPushAt)) {
      lastPushAt = pushAt;
      lastError = entry.lastError || null;
    }
  }

  const pushConnIds = Array.from(args.pushConnIds);
  return {
    pending: accountEntries.length,
    pendingAllAccounts: args.pendingAllAccounts,
    oldestPendingAt,
    newestPendingAt,
    lastAttemptAt,
    lastPushAt,
    lastPushError: lastError,
    activeOutboundConnection: pushConnIds.length > 0,
    activeOutboundConnectionCount: pushConnIds.length,
  };
}

export function buildEnqueueFromReplyDebugInfo(args: {
  accountId: string;
  sessionKey: string;
  route: { platform?: string; groupId?: string; userId?: string } | null | undefined;
  payload: {
    text: string;
    mediaUrl: string;
    mediaUrls?: string[];
    asVoice: boolean;
    audioAsVoice: boolean;
    kind?: 'tool' | 'block' | 'final';
    replyToId: string;
  };
}) {
  return {
    accountId: args.accountId,
    sessionKey: args.sessionKey,
    route: {
      platform: args.route?.platform,
      groupId: args.route?.groupId,
      userId: args.route?.userId,
    },
    payload: {
      text: args.payload.text,
      mediaUrl: args.payload.mediaUrl,
      mediaUrls: args.payload.mediaUrls,
      asVoice: args.payload.asVoice,
      audioAsVoice: args.payload.audioAsVoice,
      kind: args.payload.kind,
      replyToId: args.payload.replyToId,
    },
  };
}
