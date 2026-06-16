import { normalizeAccountId } from '../core/accounts.ts';
import {
  isEligibleOutboundPushConnection,
  selectOrderedOutboundPushConnections,
} from '../core/connection-reachability.ts';
import type { BncrConnection } from '../core/types.ts';

type BncrConnectionWithOutboundHints = BncrConnection & {
  outboundReadyUntil?: number;
  preferredForOutboundUntil?: number;
};

export type BncrOutboxRouteRuntime = {
  bridgeId: string;
  now: () => number;
  connectTtlMs: number;
  finiteNumberOr: (value: unknown, fallback: number) => number;
  connections: Map<string, BncrConnection>;
  activeConnectionByAccount: Map<string, string>;
  resolveRecentInboundConnIds: (accountId: string) => Set<string>;
  connectionKey: (accountId: string, clientId?: string) => string;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  buildActiveConnectionDebugList: (
    accountId: string,
    options?: { includeOutboundState?: boolean },
  ) => unknown;
};

export function createBncrOutboxRoute(runtime: BncrOutboxRouteRuntime) {
  const resolveOutboxPushOwner = (accountId: string): BncrConnectionWithOutboundHints | null => {
    const acc = normalizeAccountId(accountId);
    const t = runtime.now();
    const primaryKey = runtime.activeConnectionByAccount.get(acc);
    const primary = primaryKey
      ? ((runtime.connections.get(primaryKey) as BncrConnectionWithOutboundHints | undefined) ??
        null)
      : null;

    const recentInboundConnIds = runtime.resolveRecentInboundConnIds(acc);

    if (primary) {
      if (
        isEligibleOutboundPushConnection({
          connection: primary,
          now: t,
          connectTtlMs: runtime.connectTtlMs,
        })
      ) {
        const preferredForOutboundUntil = runtime.finiteNumberOr(
          primary.preferredForOutboundUntil,
          0,
        );
        const outboundReadyUntil = runtime.finiteNumberOr(primary.outboundReadyUntil, 0);
        if (preferredForOutboundUntil > t || outboundReadyUntil > t) return primary;
      }
    }

    const candidates = selectOrderedOutboundPushConnections({
      accountId: acc,
      now: t,
      connectTtlMs: runtime.connectTtlMs,
      recentInboundConnIds,
      connections: runtime.connections.values(),
    });

    const next = (candidates[0] as BncrConnectionWithOutboundHints | undefined) || null;
    if (!next) return null;

    const nextKey = runtime.connectionKey(acc, next.clientId);
    if (primaryKey !== nextKey) {
      runtime.activeConnectionByAccount.set(acc, nextKey);
      runtime.logInfo(
        'connection',
        `owner:promote ${JSON.stringify({
          bridge: runtime.bridgeId,
          accountId: acc,
          previousActiveKey: primaryKey || null,
          previousActiveConn: primary || null,
          nextActiveKey: nextKey,
          nextActiveConn: {
            connId: next.connId,
            clientId: next.clientId,
            connectedAt: next.connectedAt,
            lastSeenAt: next.lastSeenAt,
            outboundReadyUntil: next.outboundReadyUntil || null,
            preferredForOutboundUntil: next.preferredForOutboundUntil || null,
            inboundOnly: next.inboundOnly === true,
          },
          reason: 'better-outbound-candidate',
        })}`,
        { debugOnly: true },
      );
    }

    return next;
  };

  const resolvePushConnIds = (accountId: string): Set<string> => {
    const acc = normalizeAccountId(accountId);
    const t = runtime.now();
    const connIds = new Set<string>();

    const recentInboundConnIds = runtime.resolveRecentInboundConnIds(acc);

    const primaryKey = runtime.activeConnectionByAccount.get(acc);
    if (primaryKey) {
      const primary = runtime.connections.get(primaryKey) ?? null;
      if (
        primary &&
        isEligibleOutboundPushConnection({
          connection: primary,
          now: t,
          connectTtlMs: runtime.connectTtlMs,
        })
      ) {
        connIds.add(primary.connId);
      }
    }

    const candidates = selectOrderedOutboundPushConnections({
      accountId: acc,
      now: t,
      connectTtlMs: runtime.connectTtlMs,
      recentInboundConnIds,
      connections: runtime.connections.values(),
    });

    for (const c of candidates) {
      connIds.add(c.connId);
    }

    if (connIds.size > 0) return connIds;

    for (const c of runtime.connections.values()) {
      if (c.accountId !== acc) continue;
      if (!c.connId) continue;
      if (t - c.lastSeenAt > runtime.connectTtlMs) continue;
      connIds.add(c.connId);
    }

    return connIds;
  };

  const buildTransferRouteDiagnostics = (args: {
    accountId: string;
    recentInboundReachable: boolean;
  }) => {
    const directConnIds = resolvePushConnIds(args.accountId);
    const recentConnIds = args.recentInboundReachable
      ? runtime.resolveRecentInboundConnIds(args.accountId)
      : new Set<string>();
    const activeConnectionKey = runtime.activeConnectionByAccount.get(args.accountId) || null;
    const accountConnections = runtime.buildActiveConnectionDebugList(args.accountId);

    return {
      directConnIds,
      recentConnIds,
      activeConnectionKey,
      accountConnections,
    };
  };

  const selectTransferConnIds = (args: {
    directConnIds: Set<string>;
    recentConnIds: Set<string>;
    recentInboundReachable: boolean;
  }) => {
    let connIds = args.directConnIds;
    if (!connIds.size && args.recentInboundReachable) {
      connIds = args.recentConnIds;
    }
    return connIds;
  };

  return {
    resolveOutboxPushOwner,
    resolvePushConnIds,
    buildTransferRouteDiagnostics,
    selectTransferConnIds,
  };
}
