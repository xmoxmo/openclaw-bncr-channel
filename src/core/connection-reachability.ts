import type { BncrConnection, OutboxEntry } from './types.ts';

export function hasRecentInboundReachability(args: {
  now: number;
  windowMs: number;
  lastInboundAt: number;
  lastActivityAt: number;
}) {
  const lastReachableAt = Math.max(args.lastInboundAt, args.lastActivityAt);
  return lastReachableAt > 0 && args.now - lastReachableAt <= args.windowMs;
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

  for (const c of args.connections) {
    if (c.accountId !== args.accountId) continue;
    if (!c.connId) continue;
    if (args.now - c.lastSeenAt > args.connectTtlMs * 2) continue;
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

  for (const conn of args.connections) {
    if (conn.accountId !== args.accountId) continue;
    if (!conn.connId) continue;
    if (args.now - conn.lastSeenAt > args.connectTtlMs) continue;
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

  const lastAttemptAt = Number(args.entry.lastAttemptAt || 0);
  for (const rawConn of args.connections) {
    const conn = rawConn as ReachableConnection;
    if (conn.accountId !== args.accountId) continue;
    if (conn.connId !== targetConnId) continue;
    if (args.now - conn.lastSeenAt > args.connectTtlMs) continue;
    if (conn.inboundOnly === true) continue;

    const preferredForOutboundUntil = Number(conn.preferredForOutboundUntil || 0);
    const outboundReadyUntil = Number(conn.outboundReadyUntil || 0);
    const lastAckOkAt = Number(conn.lastAckOkAt || 0);
    const lastPushTimeoutAt = Number(conn.lastPushTimeoutAt || 0);

    const revalidatedByPreferred = preferredForOutboundUntil > args.now;
    const revalidatedByReady = outboundReadyUntil > args.now;
    const revalidatedByAck = lastAckOkAt > 0 && lastAckOkAt > lastAttemptAt;
    const revalidatedByFreshReachability =
      args.recentInboundReachable &&
      lastPushTimeoutAt > 0 &&
      lastPushTimeoutAt <= lastAttemptAt &&
      conn.lastSeenAt > lastPushTimeoutAt;

    if (!revalidatedByPreferred && !revalidatedByReady && !revalidatedByAck && !revalidatedByFreshReachability) {
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
      lastSeenAt: conn.lastSeenAt,
      recentInboundReachable: args.recentInboundReachable,
    };
  }

  return null;
}
