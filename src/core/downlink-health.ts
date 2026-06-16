import type { BncrDownlinkHealthSummary, OutboxEntry } from './types.ts';
import { finiteNumberOr, nonNegativeFiniteNumberOr } from './value-sanitize.ts';

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
    ? Math.min(...pending.map((entry) => finiteNumberOr(entry.createdAt, input.now)))
    : null;
  const oldestPendingAgeMs =
    oldestPendingCreatedAt !== null ? Math.max(0, input.now - oldestPendingCreatedAt) : 0;
  const lastSignalAt =
    Math.max(finiteNumberOr(input.lastInboundAt, 0), finiteNumberOr(input.lastActivityAt, 0)) ||
    null;
  const inboundHealthy = !!lastSignalAt && input.now - lastSignalAt <= 5 * 60 * 1000;
  const ackRecentlyHealthy = !!input.lastAckOkAt && input.now - input.lastAckOkAt <= 5 * 60 * 1000;
  const ackTimeoutRecent =
    !!input.lastAckTimeoutAt && input.now - input.lastAckTimeoutAt <= 5 * 60 * 1000;
  const recentAckTimeoutCount = nonNegativeFiniteNumberOr(input.recentAckTimeoutCount, 0);
  const activeConnectionCount = nonNegativeFiniteNumberOr(input.activeConnectionCount, 0);
  const ackStalled =
    pendingCount > 0 &&
    activeConnectionCount === 1 &&
    inboundHealthy &&
    ackTimeoutRecent &&
    recentAckTimeoutCount > 0 &&
    !ackRecentlyHealthy;

  return {
    pendingOutbox: pendingCount,
    oldestPendingCreatedAt,
    oldestPendingAgeMs,
    lastAckOkAt: input.lastAckOkAt,
    lastAckTimeoutAt: input.lastAckTimeoutAt,
    recentAckTimeoutCount,
    activeConnectionCount,
    recentInboundReachable: inboundHealthy,
    onlineByConn: input.onlineByConn,
    ackStalled,
    recommendReconnect: ackStalled,
    recommendReason: ackStalled
      ? 'single-conn pending outbox with recent ack timeout and no recent ack-ok while inbound/activity is still alive'
      : '',
  } satisfies BncrDownlinkHealthSummary;
}
