import type { BncrConnection, OutboxEntry } from './types.ts';

export function prepareTextPushRouteSelection(args: {
  entry: OutboxEntry;
  owner: BncrConnection | null;
  resolvePushConnIds: (accountId: string) => Iterable<string>;
  resolveRecentInboundConnIds: (accountId: string) => Iterable<string>;
  hasRecentInboundReachability: (accountId: string) => boolean;
  isRevalidatedAttemptedConn: (connId: string) => boolean;
  selectOutboxRouteCandidates: (args: {
    routeCandidates: Iterable<string>;
    attemptedConnIds: string[];
    recentInboundConnIds: Iterable<string>;
    ownerConnId?: string;
    recentInboundReachable: boolean;
    isRevalidatedAttemptedConn: (connId: string) => boolean;
  }) => {
    connIds: Iterable<string>;
    recentInboundReachable: boolean;
    routeReason: string;
    ownerConnId?: string;
  };
}) {
  const attemptedConnIds = Array.isArray(args.entry.routeAttemptConnIds)
    ? args.entry.routeAttemptConnIds.filter((v): v is string => typeof v === 'string' && !!v)
    : [];

  return args.selectOutboxRouteCandidates({
    routeCandidates: args.resolvePushConnIds(args.entry.accountId),
    attemptedConnIds,
    recentInboundConnIds: args.resolveRecentInboundConnIds(args.entry.accountId),
    ownerConnId: args.owner?.connId,
    recentInboundReachable: args.hasRecentInboundReachability(args.entry.accountId),
    isRevalidatedAttemptedConn: args.isRevalidatedAttemptedConn,
  });
}
