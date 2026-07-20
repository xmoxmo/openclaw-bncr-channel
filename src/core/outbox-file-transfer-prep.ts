import type { BncrConnection, OutboxEntry } from './types.ts';

type PushRouteSelectionArgs<C> = {
  entry: OutboxEntry;
  owner: BncrConnection | null;
  resolvePushConnIds: (accountId: string) => Iterable<string>;
  resolveRecentInboundConnIds: (accountId: string) => Iterable<string>;
  hasRecentInboundReachability: (accountId: string) => boolean;
  isRevalidatedAttemptedConn: (connId: string) => boolean;
  selectRouteCandidates: (args: {
    routeCandidates: Iterable<string>;
    attemptedConnIds: string[];
    recentInboundConnIds: Iterable<string>;
    ownerConnId?: string;
    recentInboundReachable: boolean;
    isRevalidatedAttemptedConn: (connId: string) => boolean;
  }) => C;
};

/** Shared route selection prep for both text and file push flows. */
export function prepareRouteSelection<C>(args: PushRouteSelectionArgs<C>): C {
  const attemptedConnIds = Array.isArray(args.entry.routeAttemptConnIds)
    ? args.entry.routeAttemptConnIds.filter((v): v is string => typeof v === 'string' && !!v)
    : [];

  return args.selectRouteCandidates({
    routeCandidates: args.resolvePushConnIds(args.entry.accountId),
    attemptedConnIds,
    recentInboundConnIds: args.resolveRecentInboundConnIds(args.entry.accountId),
    ownerConnId: args.owner?.connId,
    recentInboundReachable: args.hasRecentInboundReachability(args.entry.accountId),
    isRevalidatedAttemptedConn: args.isRevalidatedAttemptedConn,
  });
}
