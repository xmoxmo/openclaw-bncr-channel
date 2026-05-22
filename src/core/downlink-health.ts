import type { OutboxEntry } from './types.ts';

type DownlinkHealthInput = {
  accountId: string;
  now: number;
  outboxEntries: Iterable<OutboxEntry>;
  lastAckOkAt: number | null;
  lastAckTimeoutAt: number | null;
  recentAckTimeoutCount: number;
  activeConnectionCount: number;
  lastInboundAt: number | null;
  lastActivityAt: number | null;
  onlineByConn: boolean;
};

export function buildDownlinkHealth(input: DownlinkHealthInput) {
  const pending = Array.from(input.outboxEntries).filter((v) => v.accountId === input.accountId);
  const pendingCount = pending.length;
  const oldestPendingCreatedAt = pending.length
    ? Math.min(...pending.map((entry) => Number(entry.createdAt || input.now)))
    : null;
  const oldestPendingAgeMs = oldestPendingCreatedAt
    ? Math.max(0, input.now - oldestPendingCreatedAt)
    : 0;
  const lastSignalAt =
    Math.max(Number(input.lastInboundAt || 0), Number(input.lastActivityAt || 0)) || null;
  const inboundHealthy = !!lastSignalAt && input.now - lastSignalAt <= 5 * 60 * 1000;
  const ackRecentlyHealthy =
    !!input.lastAckOkAt && input.now - input.lastAckOkAt <= 5 * 60 * 1000;
  const ackTimeoutRecent =
    !!input.lastAckTimeoutAt && input.now - input.lastAckTimeoutAt <= 5 * 60 * 1000;
  const ackStalled =
    pendingCount > 0 &&
    input.activeConnectionCount === 1 &&
    inboundHealthy &&
    ackTimeoutRecent &&
    input.recentAckTimeoutCount > 0 &&
    !ackRecentlyHealthy;

  return {
    pendingOutbox: pendingCount,
    oldestPendingCreatedAt,
    oldestPendingAgeMs,
    lastAckOkAt: input.lastAckOkAt,
    lastAckTimeoutAt: input.lastAckTimeoutAt,
    recentAckTimeoutCount: input.recentAckTimeoutCount,
    activeConnectionCount: input.activeConnectionCount,
    recentInboundReachable: inboundHealthy,
    onlineByConn: input.onlineByConn,
    ackStalled,
    recommendReconnect: ackStalled,
    recommendReason: ackStalled
      ? 'single-conn pending outbox with recent ack timeout and no recent ack-ok while inbound/activity is still alive'
      : '',
  };
}
