import type { BncrConnection, OutboxEntry } from './types.ts';
import { finiteNumberOr } from './value-sanitize.ts';

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

type OutboundPushCandidateConnection = BncrConnection & {
  inboundOnly?: boolean;
  preferredForOutboundUntil?: number;
  outboundReadyUntil?: number;
  lastAckOkAt?: number;
  lastPushTimeoutAt?: number;
  pushFailureScore?: number;
};

export function isEligibleOutboundPushConnection(args: {
  connection?: BncrConnection | null;
  now: number;
  connectTtlMs: number;
}): args is { connection: OutboundPushCandidateConnection; now: number; connectTtlMs: number } {
  const conn = args.connection as OutboundPushCandidateConnection | null | undefined;
  if (!conn?.connId) return false;
  const nowMs = finiteNumberOr(args.now, 0);
  const connectTtlMs = finiteNumberOr(args.connectTtlMs, 0);
  const lastSeenAt = finiteNumberOr(conn.lastSeenAt, 0);
  if (!nowMs || !connectTtlMs || !lastSeenAt) return false;
  if (nowMs - lastSeenAt > connectTtlMs) return false;
  if (conn.inboundOnly === true) return false;
  return true;
}

function scoreOutboundPushConnection(args: {
  connection: BncrConnection;
  now: number;
  recentInboundConnIds: Set<string>;
}) {
  const conn = args.connection as OutboundPushCandidateConnection;
  const preferredForOutboundUntil = finiteNumberOr(conn.preferredForOutboundUntil, 0);
  const outboundReadyUntil = finiteNumberOr(conn.outboundReadyUntil, 0);
  const lastPushTimeoutAt = finiteNumberOr(conn.lastPushTimeoutAt, 0);
  const lastAckOkAt = finiteNumberOr(conn.lastAckOkAt, 0);
  const pushFailureScore = finiteNumberOr(conn.pushFailureScore, 0);
  const recentTimeoutPenalty =
    lastPushTimeoutAt > 0 && args.now - lastPushTimeoutAt <= 30_000 ? 1 : 0;
  return {
    preferred: preferredForOutboundUntil > args.now ? 1 : 0,
    ready: outboundReadyUntil > args.now ? 1 : 0,
    recentInbound: args.recentInboundConnIds.has(conn.connId) ? 1 : 0,
    recentTimeoutPenalty,
    pushFailureScore,
    lastAckOkAt,
    lastPushTimeoutAt,
    lastSeenAt: finiteNumberOr(conn.lastSeenAt, 0),
    connectedAt: finiteNumberOr(conn.connectedAt, 0),
  };
}

function compareOutboundPushConnections(args: {
  a: BncrConnection;
  b: BncrConnection;
  now: number;
  recentInboundConnIds: Set<string>;
}) {
  const sa = scoreOutboundPushConnection({
    connection: args.a,
    now: args.now,
    recentInboundConnIds: args.recentInboundConnIds,
  });
  const sb = scoreOutboundPushConnection({
    connection: args.b,
    now: args.now,
    recentInboundConnIds: args.recentInboundConnIds,
  });
  if (sb.preferred !== sa.preferred) return sb.preferred - sa.preferred;
  if (sb.ready !== sa.ready) return sb.ready - sa.ready;
  if (sa.recentTimeoutPenalty !== sb.recentTimeoutPenalty)
    return sa.recentTimeoutPenalty - sb.recentTimeoutPenalty;
  if (sa.pushFailureScore !== sb.pushFailureScore) return sa.pushFailureScore - sb.pushFailureScore;
  if (sb.lastAckOkAt !== sa.lastAckOkAt) return sb.lastAckOkAt - sa.lastAckOkAt;
  if (sa.lastPushTimeoutAt !== sb.lastPushTimeoutAt)
    return sa.lastPushTimeoutAt - sb.lastPushTimeoutAt;
  if (sb.recentInbound !== sa.recentInbound) return sb.recentInbound - sa.recentInbound;
  if (sb.lastSeenAt !== sa.lastSeenAt) return sb.lastSeenAt - sa.lastSeenAt;
  return sb.connectedAt - sa.connectedAt;
}

export function selectOrderedOutboundPushConnections(args: {
  accountId: string;
  now: number;
  connectTtlMs: number;
  recentInboundConnIds: Set<string>;
  connections: Iterable<BncrConnection>;
}) {
  return Array.from(args.connections)
    .filter((c): c is BncrConnection => c.accountId === args.accountId)
    .filter((connection) =>
      isEligibleOutboundPushConnection({
        connection,
        now: args.now,
        connectTtlMs: args.connectTtlMs,
      }),
    )
    .sort((a, b) =>
      compareOutboundPushConnections({
        a,
        b,
        now: args.now,
        recentInboundConnIds: args.recentInboundConnIds,
      }),
    );
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
