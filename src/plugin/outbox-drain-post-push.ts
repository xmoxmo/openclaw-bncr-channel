import type { OutboxEntry } from '../core/types.ts';
import { OUTBOUND_DEGRADE_REASON } from '../messaging/outbound/reasons.ts';
import {
  computeRetryRerouteDecision,
  type RetryRerouteDecision,
} from '../messaging/outbound/retry-policy.ts';

type UpdateMinOutboxDelay = (current: number | null, candidate: number | null) => number | null;

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
    updateMinOutboxDelay: UpdateMinOutboxDelay;
  }) => { kind: 'dead-letter' } | { kind: 'retry'; localNextDelay: number | null };
};

type BncrOutboxDrainPostPushRuntime = {
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  backoffMs: (retryCount: number) => number;
  outbox: Map<string, OutboxEntry>;
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
  outboxDrainAck: BncrOutboxDrainAckRuntime;
  pushDrainIntervalMs: number;
  pushAckTimeoutMs: number;
  maxRetry: number;
};

export function createBncrOutboxDrainPostPush(runtime: BncrOutboxDrainPostPushRuntime) {
  return async function handlePushedDrainEntry(args: {
    accountId: string;
    entry: OutboxEntry;
    onlineNow: boolean;
    recentInboundReachable: boolean;
    localNextDelay: number | null;
    updateMinOutboxDelay: UpdateMinOutboxDelay;
  }): Promise<{ action: 'continue' | 'break'; localNextDelay: number | null }> {
    const { accountId, entry, onlineNow, recentInboundReachable, updateMinOutboxDelay } = args;
    let { localNextDelay } = args;
    const requireAck = runtime.isOutboundAckRequired(accountId);
    const ackTimeoutMs = requireAck ? runtime.resolveMessageAckTimeoutMs(accountId) : null;
    let ackResult: 'acked' | 'timeout' = requireAck ? 'timeout' : 'acked';
    if (onlineNow && requireAck) {
      runtime.outboxDrainAck.logAckWaitStart({
        entry,
        requireAck,
        ackTimeoutMs,
        onlineNow,
        recentInboundReachable,
      });
      ackResult = await runtime.waitForMessageAck(
        entry.messageId,
        ackTimeoutMs || runtime.pushAckTimeoutMs,
      );
    }

    runtime.logOutboxAckWait({
      entry,
      requireAck,
      ackResult,
      onlineNow,
      recentInboundReachable,
      ackTimeoutMs,
    });

    if (!requireAck && onlineNow) {
      runtime.outbox.delete(entry.messageId);
    }
    if (!runtime.outbox.has(entry.messageId)) {
      await runtime.sleepMs(runtime.pushDrainIntervalMs);
      return { action: 'continue', localNextDelay };
    }

    if (onlineNow && (!requireAck || ackResult !== 'timeout')) {
      await runtime.sleepMs(runtime.pushDrainIntervalMs);
      return { action: 'continue', localNextDelay };
    }

    if (entry.lastPushConnId || entry.lastPushClientId) {
      runtime.degradeOutboundCapability({
        accountId,
        connId: entry.lastPushConnId || undefined,
        clientId: entry.lastPushClientId || undefined,
        reason: requireAck
          ? OUTBOUND_DEGRADE_REASON.ACK_TIMEOUT
          : OUTBOUND_DEGRADE_REASON.PUSH_UNCONFIRMED,
      });
    }

    const attemptedConnIds = Array.isArray(entry.routeAttemptConnIds)
      ? entry.routeAttemptConnIds.filter((v): v is string => typeof v === 'string' && !!v)
      : [];
    const currentConnId = runtime.asString(entry.lastPushConnId || '').trim();
    const availableConnIds = Array.from(runtime.resolvePushConnIds(accountId));
    const decision = computeRetryRerouteDecision(
      {
        nowMs: runtime.now(),
        maxRetry: runtime.maxRetry,
        requireAck,
        currentRetryCount: entry.retryCount,
        currentRouteAttemptRound: Number(entry.routeAttemptRound || 0),
        currentFastReroutePending: entry.fastReroutePending === true,
        lastError: entry.lastError,
        currentConnId: currentConnId || undefined,
        attemptedConnIds,
        availableConnIds,
      },
      { backoffMs: runtime.backoffMs },
    );

    const rerouteResult = runtime.outboxDrainAck.handleAckTimeoutReroute({
      accountId,
      entry,
      requireAck,
      currentConnId,
      availableConnIds,
      decision,
      localNextDelay,
      ackTimeoutMs,
      updateMinOutboxDelay,
    });
    if (rerouteResult.kind === 'dead-letter') {
      return { action: 'continue', localNextDelay };
    }

    localNextDelay = rerouteResult.localNextDelay;
    await runtime.sleepMs(runtime.pushDrainIntervalMs);
    return { action: 'break', localNextDelay };
  };
}
