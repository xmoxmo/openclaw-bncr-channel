import type { BncrConnection } from '../../core/types.ts';
import { OUTBOUND_TERMINAL_REASON, type OutboundScheduleSource } from './reasons.ts';
import type { RetryRerouteDecision } from './retry-policy.ts';

export function buildOutboxScheduleDebugInfo(args: {
  bridgeId: string;
  accountId?: string | null;
  // Account-local aggregated next delay after considering currently visible entries.
  localNextDelay?: number | null;
  // Bridge-global aggregated next delay after merging account-local scheduling decisions.
  globalNextDelay?: number | null;
  // Immediate wait observed for this specific scheduling event.
  wait?: number | null;
  source: OutboundScheduleSource;
  messageId?: string;
}) {
  return {
    bridge: args.bridgeId,
    ...(args.accountId ? { accountId: args.accountId } : {}),
    ...(args.messageId ? { messageId: args.messageId } : {}),
    source: args.source,
    ...(typeof args.wait === 'number' ? { wait: args.wait } : {}),
    ...(typeof args.localNextDelay === 'number' ? { localNextDelay: args.localNextDelay } : {}),
    ...(typeof args.globalNextDelay === 'number' ? { globalNextDelay: args.globalNextDelay } : {}),
  };
}

export function buildOutboxPushSkipDebugInfo(args: {
  messageId: string;
  accountId: string;
  reason: string;
  recentInboundReachable?: boolean;
  kind?: string;
  routeReason?: string;
  connIds?: Iterable<string>;
  ownerConnId?: string;
  ownerClientId?: string;
  activeConnectionCount?: number;
  connections?: Iterable<BncrConnection>;
}) {
  return {
    messageId: args.messageId,
    accountId: args.accountId,
    ...(args.kind ? { kind: args.kind } : {}),
    reason: args.reason,
    ...(args.routeReason ? { routeReason: args.routeReason } : {}),
    ...(args.connIds ? { connIds: Array.from(args.connIds) } : {}),
    ...(args.ownerConnId ? { ownerConnId: args.ownerConnId } : {}),
    ...(args.ownerClientId ? { ownerClientId: args.ownerClientId } : {}),
    ...(typeof args.activeConnectionCount === 'number'
      ? { activeConnectionCount: args.activeConnectionCount }
      : {}),
    ...(args.connections
      ? {
          connections: Array.from(args.connections)
            .filter((c) => c.accountId === args.accountId)
            .slice(0, 8)
            .map((c) => ({
              connId: c.connId,
              clientId: c.clientId,
              lastSeenAt: c.lastSeenAt,
              outboundReadyUntil: (c as any).outboundReadyUntil,
              preferredForOutboundUntil: (c as any).preferredForOutboundUntil,
              inboundOnly: (c as any).inboundOnly,
              lastAckOkAt: (c as any).lastAckOkAt,
              lastPushTimeoutAt: (c as any).lastPushTimeoutAt,
              pushFailureScore: (c as any).pushFailureScore,
            })),
        }
      : {}),
    ...(typeof args.recentInboundReachable === 'boolean'
      ? { recentInboundReachable: args.recentInboundReachable }
      : {}),
  };
}

export function buildOutboxRouteSelectDebugInfo(args: {
  messageId: string;
  accountId: string;
  routeReason: string;
  connIds: Iterable<string>;
  ownerConnId?: string;
  ownerClientId?: string;
  recentInboundReachable: boolean;
  event: string;
  kind?: string;
}) {
  return {
    messageId: args.messageId,
    accountId: args.accountId,
    ...(args.kind ? { kind: args.kind } : {}),
    routeReason: args.routeReason,
    connIds: Array.from(args.connIds),
    ownerConnId: args.ownerConnId || '',
    ownerClientId: args.ownerClientId || '',
    recentInboundReachable: args.recentInboundReachable,
    event: args.event,
  };
}

export function buildOutboxPushOkDebugInfo(args: {
  messageId: string;
  accountId: string;
  connIds: Iterable<string>;
  ownerConnId?: string;
  ownerClientId?: string;
  recentInboundReachable: boolean;
  event: string;
  kind?: string;
}) {
  return {
    messageId: args.messageId,
    accountId: args.accountId,
    ...(args.kind ? { kind: args.kind } : {}),
    connIds: Array.from(args.connIds),
    ownerConnId: args.ownerConnId || '',
    ownerClientId: args.ownerClientId || '',
    recentInboundReachable: args.recentInboundReachable,
    event: args.event,
  };
}

export function buildFlushDebugInfo(args: {
  bridgeId: string;
  accountId: string | null;
  targetAccounts: string[];
  outboxSize: number;
  trigger: string;
  reason?: string;
}) {
  return {
    bridge: args.bridgeId,
    accountId: args.accountId,
    targetAccounts: [...args.targetAccounts],
    outboxSize: args.outboxSize,
    trigger: args.trigger,
    reason: args.reason,
  };
}

export function buildOutboxDrainSkipDebugInfo(args: {
  bridgeId: string;
  accountId: string;
  reason: string;
  outboxSize: number;
  trigger: string;
}) {
  return {
    bridge: args.bridgeId,
    accountId: args.accountId,
    reason: args.reason,
    outboxSize: args.outboxSize,
    trigger: args.trigger,
  };
}

export function buildOutboxDrainStuckDebugInfo(args: {
  bridgeId: string;
  accountId: string;
  reason: string;
  trigger: string;
  outboxSize: number;
  pending: number;
  runningMs: number;
  runningSince?: number | null;
  hasGatewayContext: boolean;
  activeConnectionCount: number;
  messageAckWaiters: number;
  fileAckWaiters: number;
  pendingEntries?: Iterable<{
    messageId?: string;
    retryCount?: number;
    nextAttemptAt?: number;
    lastAttemptAt?: number;
    lastError?: string;
    lastPushAt?: number;
    lastPushConnId?: string;
    routeAttemptConnIds?: string[];
  }>;
  connections?: Iterable<BncrConnection>;
}) {
  return {
    bridge: args.bridgeId,
    accountId: args.accountId,
    reason: args.reason,
    trigger: args.trigger,
    outboxSize: args.outboxSize,
    pending: args.pending,
    runningMs: args.runningMs,
    runningSince: args.runningSince || null,
    hasGatewayContext: args.hasGatewayContext,
    activeConnectionCount: args.activeConnectionCount,
    waiters: {
      messageAck: args.messageAckWaiters,
      fileAck: args.fileAckWaiters,
    },
    ...(args.pendingEntries
      ? {
          pendingEntries: Array.from(args.pendingEntries)
            .slice(0, 8)
            .map((entry) => ({
              messageId: entry.messageId || '',
              retryCount: entry.retryCount,
              nextAttemptAt: entry.nextAttemptAt,
              lastAttemptAt: entry.lastAttemptAt,
              lastError: entry.lastError,
              lastPushAt: entry.lastPushAt,
              lastPushConnId: entry.lastPushConnId,
              routeAttemptConnIds: entry.routeAttemptConnIds,
            })),
        }
      : {}),
    ...(args.connections
      ? {
          connections: Array.from(args.connections)
            .filter((c) => c.accountId === args.accountId)
            .slice(0, 8)
            .map((c) => ({
              connId: c.connId,
              clientId: c.clientId,
              connectedAt: c.connectedAt,
              lastSeenAt: c.lastSeenAt,
              outboundReadyUntil: (c as any).outboundReadyUntil,
              preferredForOutboundUntil: (c as any).preferredForOutboundUntil,
              inboundOnly: (c as any).inboundOnly,
              lastAckOkAt: (c as any).lastAckOkAt,
              lastPushTimeoutAt: (c as any).lastPushTimeoutAt,
              pushFailureScore: (c as any).pushFailureScore,
            })),
        }
      : {}),
  };
}

export function buildOutboxAckDebugInfo(args: {
  messageId: string;
  accountId: string;
  requireAck: boolean;
  ackResult: 'acked' | 'timeout';
  onlineNow: boolean;
  recentInboundReachable: boolean;
  connIds?: Iterable<string>;
  ownerConnId?: string;
  ownerClientId?: string;
  sessionKey?: string;
  to?: string;
  ackStage?: string;
  ackOutcome?: string;
  reason?: string;
  kind?: string;
  event?: string;
  ackTimeoutMs?: number;
  adaptiveAckTimeoutEnabled?: boolean;
}) {
  return {
    messageId: args.messageId,
    accountId: args.accountId,
    ...(args.sessionKey ? { sessionKey: args.sessionKey } : {}),
    ...(args.to ? { to: args.to } : {}),
    ...(args.kind ? { kind: args.kind } : {}),
    requireAck: args.requireAck,
    ackResult: args.ackResult,
    ackStage: args.ackStage || 'message',
    ackOutcome: args.ackOutcome || args.ackResult,
    ...(args.reason ? { reason: args.reason } : {}),
    ...(typeof args.ackTimeoutMs === 'number' ? { ackTimeoutMs: args.ackTimeoutMs } : {}),
    ...(typeof args.adaptiveAckTimeoutEnabled === 'boolean'
      ? { adaptiveAckTimeoutEnabled: args.adaptiveAckTimeoutEnabled }
      : {}),
    onlineNow: args.onlineNow,
    recentInboundReachable: args.recentInboundReachable,
    ...(args.connIds ? { connIds: Array.from(args.connIds) } : {}),
    ...(args.ownerConnId ? { ownerConnId: args.ownerConnId } : {}),
    ...(args.ownerClientId ? { ownerClientId: args.ownerClientId } : {}),
    ...(args.event ? { event: args.event } : {}),
  };
}

export function buildRetryRerouteDebugInfo(args: {
  messageId: string;
  accountId: string;
  currentConnId: string;
  decision: RetryRerouteDecision;
  availableConnIds: string[];
}) {
  if (args.decision.kind !== 'retry') {
    return {
      messageId: args.messageId,
      accountId: args.accountId,
      currentConnId: args.currentConnId,
      availableConnIds: [...args.availableConnIds],
      kind: args.decision.kind,
      terminalReason: args.decision.terminalReason,
      nextRetryCount: args.decision.nextRetryCount,
      lastAttemptAt: args.decision.lastAttemptAt,
    };
  }

  return {
    messageId: args.messageId,
    accountId: args.accountId,
    currentConnId: args.currentConnId,
    attemptedConnIds: [...args.decision.attemptedConnIds],
    availableConnIds: [...args.availableConnIds],
    revalidatedConnIds: [...args.decision.revalidatedConnIds],
    hasUntriedAlternative: args.decision.hasUntriedAlternative,
    shouldFastReroute: args.decision.shouldFastReroute,
    routeAttemptRound: args.decision.routeAttemptRound,
    nextAttemptAt: args.decision.nextAttemptAt,
    fastReroutePending: args.decision.fastReroutePending,
    nextRetryCount: args.decision.nextRetryCount,
    lastAttemptAt: args.decision.lastAttemptAt,
    lastError: args.decision.lastError,
    kind: args.decision.kind,
  };
}

export function buildPushFailureDebugInfo(args: {
  messageId: string;
  accountId: string;
  retryCount: number;
  lastError?: string;
  retryable?: boolean;
  kind?: string;
}) {
  return {
    messageId: args.messageId,
    accountId: args.accountId,
    ...(args.kind ? { kind: args.kind } : {}),
    ...(typeof args.retryable === 'boolean' ? { retryable: args.retryable } : {}),
    retryCount: args.retryCount,
    error:
      (typeof args.lastError === 'string' && args.lastError) || OUTBOUND_TERMINAL_REASON.PUSH_RETRY,
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

export function buildReplyMediaFallbackDebugInfo(args: {
  sessionKey: string;
  mediaUrl: string;
  replyToId: string;
  fallback: { text: string; reason: string };
}) {
  return {
    sessionKey: args.sessionKey,
    mediaUrl: args.mediaUrl,
    replyToId: args.replyToId || undefined,
    fallbackText: args.fallback.text,
    reason: args.fallback.reason,
  };
}
