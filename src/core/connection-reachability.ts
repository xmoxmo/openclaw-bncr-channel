import type { BncrConnection, OutboxEntry } from './types.ts';

function finiteNumberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function hasRecentInboundReachability(args: {
  now: number;
  windowMs: number;
  lastInboundAt: number;
  lastActivityAt: number;
}) {
  const nowMs = finiteNumberOr(args.now, 0);
  const windowMs = finiteNumberOr(args.windowMs, 0);
  const lastReachableAt = Math.max(
    finiteNumberOr(args.lastInboundAt, 0),
    finiteNumberOr(args.lastActivityAt, 0),
  );
  return nowMs > 0 && windowMs > 0 && lastReachableAt > 0 && nowMs - lastReachableAt <= windowMs;
}

export function resolveRecentInboundConnIds(args: {
  accountId: string;
  now: number;
  connectTtlMs: number;
  recentInboundReachable: boolean;
  connections: Iterable<BncrConnection>;
}) {
  const connIds = new Set<string>();
  if (!args.recentInboundReachable) return connIds;

  const nowMs = finiteNumberOr(args.now, 0);
  const connectTtlMs = finiteNumberOr(args.connectTtlMs, 0);
  if (!nowMs || !connectTtlMs) return connIds;

  for (const c of args.connections) {
    if (c.accountId !== args.accountId) continue;
    if (!c.connId) continue;
    const lastSeenAt = finiteNumberOr(c.lastSeenAt, 0);
    if (!lastSeenAt) continue;
    if (nowMs - lastSeenAt > connectTtlMs * 2) continue;
    connIds.add(c.connId);
  }

  return connIds;
}

export function isRecentlyReachableConn(args: {
  accountId: string;
  connId?: string;
  clientId?: string;
  recentConnIds: Set<string>;
  activeConnection?: BncrConnection | null;
}) {
  const cid = String(args.connId || '').trim();
  const client = String(args.clientId || '').trim() || undefined;
  if (!cid) return false;
  if (args.recentConnIds.has(cid)) return true;

  const active = args.activeConnection;
  if (!active?.connId) return false;
  if (active.accountId !== args.accountId) return false;
  if (active.connId !== cid) return false;
  if (client && active.clientId && active.clientId !== client) return false;
  return true;
}

export function hasAlternativeLiveConnection(args: {
  accountId: string;
  now: number;
  connectTtlMs: number;
  currentConnId?: string;
  currentClientId?: string;
  connections: Iterable<BncrConnection>;
}) {
  const currentConn = String(args.currentConnId || '').trim();
  const currentClient = String(args.currentClientId || '').trim() || undefined;
  const nowMs = finiteNumberOr(args.now, 0);
  const connectTtlMs = finiteNumberOr(args.connectTtlMs, 0);
  if (!nowMs || !connectTtlMs) return false;

  for (const conn of args.connections) {
    if (conn.accountId !== args.accountId) continue;
    if (!conn.connId) continue;
    const lastSeenAt = finiteNumberOr(conn.lastSeenAt, 0);
    if (!lastSeenAt) continue;
    if (nowMs - lastSeenAt > connectTtlMs) continue;
    const sameConn = !!currentConn && conn.connId === currentConn;
    const sameClient = !currentConn && !!currentClient && conn.clientId === currentClient;
    if (sameConn || sameClient) continue;
    return true;
  }
  return false;
}

type ReachableConnection = BncrConnection & {
  inboundOnly?: boolean;
  preferredForOutboundUntil?: number;
  outboundReadyUntil?: number;
  lastAckOkAt?: number;
  lastPushTimeoutAt?: number;
};

export function getRevalidatedAttemptReason(args: {
  entry: OutboxEntry;
  connId: string;
  accountId: string;
  now: number;
  connectTtlMs: number;
  recentInboundReachable: boolean;
  connections: Iterable<BncrConnection>;
}) {
  const targetConnId = String(args.connId || '').trim();
  if (!targetConnId) return null;

  const nowMs = finiteNumberOr(args.now, 0);
  const connectTtlMs = finiteNumberOr(args.connectTtlMs, 0);
  if (!nowMs || !connectTtlMs) return null;

  const lastAttemptAt = finiteNumberOr(args.entry.lastAttemptAt, 0);
  for (const rawConn of args.connections) {
    const conn = rawConn as ReachableConnection;
    if (conn.accountId !== args.accountId) continue;
    if (conn.connId !== targetConnId) continue;
    const lastSeenAt = finiteNumberOr(conn.lastSeenAt, 0);
    if (!lastSeenAt) continue;
    if (nowMs - lastSeenAt > connectTtlMs) continue;
    if (conn.inboundOnly === true) continue;

    const preferredForOutboundUntil = finiteNumberOr(conn.preferredForOutboundUntil, 0);
    const outboundReadyUntil = finiteNumberOr(conn.outboundReadyUntil, 0);
    const lastAckOkAt = finiteNumberOr(conn.lastAckOkAt, 0);
    const lastPushTimeoutAt = finiteNumberOr(conn.lastPushTimeoutAt, 0);

    const revalidatedByPreferred = preferredForOutboundUntil > nowMs;
    const revalidatedByReady = outboundReadyUntil > nowMs;
    const revalidatedByAck = lastAckOkAt > 0 && lastAckOkAt > lastAttemptAt;
    const revalidatedByFreshReachability =
      args.recentInboundReachable &&
      lastPushTimeoutAt > 0 &&
      lastPushTimeoutAt <= lastAttemptAt &&
      lastSeenAt > lastPushTimeoutAt;

    if (
      !revalidatedByPreferred &&
      !revalidatedByReady &&
      !revalidatedByAck &&
      !revalidatedByFreshReachability
    ) {
      return null;
    }

    return {
      reason: revalidatedByAck
        ? 'ack-after-last-attempt'
        : revalidatedByPreferred
          ? 'preferred-ttl'
          : revalidatedByReady
            ? 'ready-ttl'
            : 'fresh-reachability',
      lastAttemptAt,
      lastAckOkAt: lastAckOkAt || null,
      lastPushTimeoutAt: lastPushTimeoutAt || null,
      outboundReadyUntil: outboundReadyUntil || null,
      preferredForOutboundUntil: preferredForOutboundUntil || null,
      lastSeenAt,
      recentInboundReachable: args.recentInboundReachable,
    };
  }

  return null;
}
