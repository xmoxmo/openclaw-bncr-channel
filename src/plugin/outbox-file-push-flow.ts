import { resolveFileTransferGuard } from '../core/outbox-file-transfer-guards.ts';
import { prepareRouteSelection } from '../core/outbox-file-transfer-prep.ts';
import type { BncrConnection, OutboxEntry } from '../core/types.ts';
import { selectOutboxFileTransferRouteCandidates } from '../messaging/outbound/queue-selectors.ts';

export async function runBncrFileTransferOutboxPush(args: {
  entry: OutboxEntry;
  msg: Record<string, unknown>;
  gatewayContext: unknown;
  owner: BncrConnection | null;
  resolvePushConnIds: (accountId: string) => Set<string>;
  resolveRecentInboundConnIds: (accountId: string) => Set<string>;
  hasRecentInboundReachability: (accountId: string) => boolean;
  isRevalidatedAttemptedConn: (connId: string) => boolean;
  handleFileTransferPushGuardFailure: (args: {
    entry: OutboxEntry;
    guard: Exclude<ReturnType<typeof resolveFileTransferGuard>, { ok: true }>;
  }) => void;
  pushFileTransferSuccessPath: (args: {
    entry: OutboxEntry;
    msg: Record<string, unknown>;
    owner: BncrConnection | null;
    connIds: Iterable<string>;
    recentInboundReachable: boolean;
    routeReason: string;
    mediaUrl: string;
  }) => Promise<void>;
  handleFileTransferPushFailure: (args: { entry: OutboxEntry; error: unknown }) => void;
}) {
  const selection = prepareRouteSelection({
    entry: args.entry,
    owner: args.owner,
    resolvePushConnIds: args.resolvePushConnIds,
    resolveRecentInboundConnIds: args.resolveRecentInboundConnIds,
    hasRecentInboundReachability: args.hasRecentInboundReachability,
    isRevalidatedAttemptedConn: args.isRevalidatedAttemptedConn,
    selectRouteCandidates: selectOutboxFileTransferRouteCandidates,
  });
  const guard = resolveFileTransferGuard({
    gatewayContext: args.gatewayContext,
    entry: args.entry,
    owner: args.owner,
    routeSelection: selection,
    mediaUrl: String(args.msg.mediaUrl || '').trim(),
  });
  if (!guard.ok) {
    args.handleFileTransferPushGuardFailure({
      entry: args.entry,
      guard,
    });
    return false;
  }

  try {
    await args.pushFileTransferSuccessPath({
      entry: args.entry,
      msg: args.msg,
      owner: args.owner,
      connIds: guard.connIds,
      recentInboundReachable: guard.recentInboundReachable,
      routeReason: guard.routeReason,
      mediaUrl: guard.mediaUrl,
    });
    return true;
  } catch (error) {
    args.handleFileTransferPushFailure({ entry: args.entry, error });
    return false;
  }
}
