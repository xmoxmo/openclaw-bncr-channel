import type { BncrConnection, OutboxEntry } from '../../core/types.ts';

export type OutboxRouteSelection = {
  connIds: string[];
  routeReason:
    | 'owner'
    | 'active-connections-unattempted-first'
    | 'active-connections-revalidated'
    | 'active-connections-all-visible'
    | 'recent-inbound-fallback'
    | 'none';
  recentInboundReachable: boolean;
  ownerConnId?: string;
};

export type OutboxFileTransferRouteSelection = {
  connIds: string[];
  routeReason:
    | 'owner'
    | 'active-connections'
    | 'active-connections-reused'
    | 'recent-inbound-fallback'
    | 'none';
  recentInboundReachable: boolean;
  ownerConnId?: string;
};

function finiteNumberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function computeOutboxRetryWait(nextAttemptAt: number, nowMs: number): number {
  return Math.max(0, finiteNumberOr(nextAttemptAt, 0) - finiteNumberOr(nowMs, 0));
}

export function updateMinOutboxDelay(currentDelay: number | null, candidateDelay: number | null): number | null {
  if (candidateDelay == null) return currentDelay;
  return currentDelay == null ? candidateDelay : Math.min(currentDelay, candidateDelay);
}

export function clampOutboxDrainDelay(delayMs: number): number {
  return Math.max(0, Math.min(finiteNumberOr(delayMs, 0), 30_000));
}

export function selectOutboxTargetAccounts(args: {
  accountId?: string | null;
  outboxEntries: Iterable<OutboxEntry>;
  normalizeAccountId: (accountId: string) => string;
}): string[] {
  const filterAcc = args.accountId ? args.normalizeAccountId(args.accountId) : null;
  if (filterAcc) return [filterAcc];
  return Array.from(
    new Set(Array.from(args.outboxEntries).map((entry) => args.normalizeAccountId(entry.accountId))),
  );
}

export function listAccountOutboxEntries(args: {
  accountId: string;
  outboxEntries: Iterable<OutboxEntry>;
  normalizeAccountId: (accountId: string) => string;
}): OutboxEntry[] {
  return Array.from(args.outboxEntries)
    .filter((entry) => args.normalizeAccountId(entry.accountId) === args.accountId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function findDueOutboxEntry(entries: OutboxEntry[], nowMs: number): OutboxEntry | null {
  return entries.find((item) => item.nextAttemptAt <= nowMs) || null;
}

export function computeNextOutboxDelay(entries: OutboxEntry[], nowMs: number): number | null {
  if (!entries.length) return null;
  const due = findDueOutboxEntry(entries, nowMs);
  if (due) return 0;
  return Math.max(0, entries[0].nextAttemptAt - nowMs);
}

export function buildOutboxOnlineDebugInfo(args: {
  bridgeId: string;
  accountId: string;
  online: boolean;
  recentInboundReachable: boolean;
  connections: Iterable<BncrConnection>;
}) {
  return {
    bridge: args.bridgeId,
    accountId: args.accountId,
    online: args.online,
    recentInboundReachable: args.recentInboundReachable,
    connections: Array.from(args.connections).map((c) => ({
      accountId: c.accountId,
      connId: c.connId,
      clientId: c.clientId,
      lastSeenAt: c.lastSeenAt,
    })),
  };
}

export function selectOutboxFileTransferRouteCandidates(args: {
  routeCandidates: Iterable<string>;
  attemptedConnIds: Iterable<string>;
  recentInboundConnIds: Iterable<string>;
  ownerConnId?: string;
  recentInboundReachable: boolean;
  isRevalidatedAttemptedConn: (connId: string) => boolean;
}): OutboxFileTransferRouteSelection {
  const routeCandidates = Array.from(args.routeCandidates);
  const attemptedConnIds = new Set(Array.from(args.attemptedConnIds));
  const filteredCandidates = routeCandidates.filter(
    (connId) => !attemptedConnIds.has(connId) || args.isRevalidatedAttemptedConn(connId),
  );
  const ownerConnId =
    args.ownerConnId && !attemptedConnIds.has(args.ownerConnId) ? args.ownerConnId : undefined;
  let connIds = ownerConnId ? [ownerConnId] : filteredCandidates.length > 0 ? filteredCandidates : routeCandidates;
  let routeReason: OutboxFileTransferRouteSelection['routeReason'] = ownerConnId
    ? 'owner'
    : connIds.length > 0
      ? filteredCandidates.length > 0
        ? 'active-connections'
        : 'active-connections-reused'
      : args.recentInboundReachable
        ? 'recent-inbound-fallback'
        : 'none';

  if (!connIds.length && args.recentInboundReachable) {
    const recentInboundConnIds = Array.from(args.recentInboundConnIds);
    const filteredRecentInboundConnIds = recentInboundConnIds.filter(
      (connId) => !attemptedConnIds.has(connId),
    );
    connIds = filteredRecentInboundConnIds.length > 0 ? filteredRecentInboundConnIds : recentInboundConnIds;
    routeReason = connIds.length > 0 ? 'recent-inbound-fallback' : 'none';
  }

  return {
    connIds,
    routeReason,
    recentInboundReachable: args.recentInboundReachable,
    ...(ownerConnId ? { ownerConnId } : {}),
  };
}

export function selectOutboxRouteCandidates(args: {
  routeCandidates: Iterable<string>;
  attemptedConnIds: Iterable<string>;
  recentInboundConnIds: Iterable<string>;
  ownerConnId?: string;
  recentInboundReachable: boolean;
  isRevalidatedAttemptedConn: (connId: string) => boolean;
}): OutboxRouteSelection {
  const routeCandidates = Array.from(args.routeCandidates);
  const attemptedConnIds = new Set(Array.from(args.attemptedConnIds));
  const unattemptedCandidates = routeCandidates.filter((connId) => !attemptedConnIds.has(connId));
  const revalidatedCandidates = routeCandidates.filter(
    (connId) => attemptedConnIds.has(connId) && args.isRevalidatedAttemptedConn(connId),
  );
  const preferredCandidates = unattemptedCandidates.length > 0 ? unattemptedCandidates : routeCandidates;
  const ownerConnId =
    args.ownerConnId && preferredCandidates.includes(args.ownerConnId) ? args.ownerConnId : undefined;
  let connIds = ownerConnId ? [ownerConnId] : preferredCandidates;
  let routeReason: OutboxRouteSelection['routeReason'] = ownerConnId
    ? 'owner'
    : connIds.length > 0
      ? unattemptedCandidates.length > 0
        ? 'active-connections-unattempted-first'
        : revalidatedCandidates.length > 0
          ? 'active-connections-revalidated'
          : 'active-connections-all-visible'
      : args.recentInboundReachable
        ? 'recent-inbound-fallback'
        : 'none';

  if (!connIds.length && args.recentInboundReachable) {
    const recentInboundConnIds = Array.from(args.recentInboundConnIds);
    const unattemptedRecentInboundConnIds = recentInboundConnIds.filter(
      (connId) => !attemptedConnIds.has(connId),
    );
    connIds =
      unattemptedRecentInboundConnIds.length > 0
        ? unattemptedRecentInboundConnIds
        : recentInboundConnIds;
    routeReason = connIds.length > 0 ? 'recent-inbound-fallback' : 'none';
  }

  return {
    connIds,
    routeReason,
    recentInboundReachable: args.recentInboundReachable,
    ...(ownerConnId ? { ownerConnId } : {}),
  };
}
