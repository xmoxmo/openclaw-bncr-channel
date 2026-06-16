import { resolveTextPushGuard } from '../core/outbox-text-push-guards.ts';
import { prepareTextPushRouteSelection } from '../core/outbox-text-push-prep.ts';
import type { BncrConnection, OutboxEntry } from '../core/types.ts';
import { selectOutboxRouteCandidates } from '../messaging/outbound/queue-selectors.ts';

export async function runBncrTextOutboxPush(args: {
  entry: OutboxEntry;
  gatewayContext: unknown;
  owner: BncrConnection | null;
  resolvePushConnIds: (accountId: string) => Set<string>;
  resolveRecentInboundConnIds: (accountId: string) => Set<string>;
  hasRecentInboundReachability: (accountId: string) => boolean;
  isRevalidatedAttemptedConn: (connId: string) => boolean;
  recordOutboxPrePushFailure: (args: {
    entry: OutboxEntry;
    lastError: string;
    persist?: boolean;
  }) => void;
  logOutboxPushSkip: (args: {
    messageId: string;
    accountId: string;
    reason: string;
    recentInboundReachable?: boolean;
    routeReason?: string;
    connIds?: Iterable<string>;
    ownerConnId?: string;
    ownerClientId?: string;
  }) => void;
  pushTextSuccessPath: (args: {
    entry: OutboxEntry;
    owner: BncrConnection | null;
    connIds: Iterable<string>;
    recentInboundReachable: boolean;
    routeReason: string;
    ownerConnId?: string;
  }) => void;
  handleTextPushFailure: (args: { entry: OutboxEntry; error: unknown }) => void;
}) {
  const selection = prepareTextPushRouteSelection({
    entry: args.entry,
    owner: args.owner,
    resolvePushConnIds: args.resolvePushConnIds,
    resolveRecentInboundConnIds: args.resolveRecentInboundConnIds,
    hasRecentInboundReachability: args.hasRecentInboundReachability,
    isRevalidatedAttemptedConn: args.isRevalidatedAttemptedConn,
    selectOutboxRouteCandidates,
  });
  const guard = resolveTextPushGuard({
    gatewayContext: args.gatewayContext,
    entry: args.entry,
    routeSelection: selection,
  });
  if (!guard.ok) {
    args.recordOutboxPrePushFailure({
      entry: args.entry,
      lastError:
        guard.reason === 'no-gateway-context'
          ? 'gateway context unavailable'
          : 'no active bncr client',
      persist: true,
    });
    args.logOutboxPushSkip({
      messageId: args.entry.messageId,
      accountId: args.entry.accountId,
      reason: guard.reason,
      recentInboundReachable:
        guard.reason === 'no-active-connection' ? guard.recentInboundReachable : undefined,
      routeReason: selection.routeReason,
      connIds: selection.connIds,
      ownerConnId: selection.ownerConnId,
      ownerClientId: args.owner?.clientId,
    });
    return false;
  }

  try {
    args.pushTextSuccessPath({
      entry: args.entry,
      owner: args.owner,
      connIds: guard.connIds,
      recentInboundReachable: guard.recentInboundReachable,
      routeReason: guard.routeReason,
      ownerConnId: guard.ownerConnId,
    });
    return true;
  } catch (error) {
    args.handleTextPushFailure({ entry: args.entry, error });
    return false;
  }
}
