import {
  buildFileTransferPushOkArgs,
  buildFileTransferPushSuccessArgs,
} from '../core/outbox-file-transfer-bookkeeping.ts';
import {
  buildFileTransferBroadcastPayload,
  buildFileTransferRouteSelectArgs,
} from '../core/outbox-file-transfer-success.ts';
import type { BncrConnection, BncrRoute, OutboxEntry } from '../core/types.ts';

export function createBncrBridgeFileTransferPushFacade(runtime: {
  pushEvent: string;
  getGatewayContext: () => {
    broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => void;
  } | null;
  transferMediaToBncrClient: (params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
    downloadMedia?: boolean;
  }) => Promise<{
    mode: 'base64' | 'chunk';
    mimeType?: string;
    fileName?: string;
    base64?: string;
    path?: string;
  }>;
  buildFileTransferOutboundFrame: (params: {
    entry: OutboxEntry;
    msg: Record<string, unknown>;
    media: { fileName?: string; mimeType?: string; path?: string; base64?: string; type?: string };
    mediaUrl: string;
  }) => Record<string, unknown>;
  logOutboxRouteSelect: (args: {
    messageId: string;
    accountId: string;
    kind?: 'file-transfer';
    routeReason: string;
    connIds: Iterable<string>;
    ownerConnId: string;
    ownerClientId: string;
    recentInboundReachable: boolean;
    event: string;
  }) => void;
  recordOutboxPushSuccess: (args: {
    entry: OutboxEntry;
    connIds: Iterable<string>;
    ownerConnId?: string;
    ownerClientId?: string;
    clearLastError?: boolean;
  }) => void;
  logOutboxPushOkSummary: (messageId: string) => void;
  logOutboxPushOk: (args: {
    messageId: string;
    accountId: string;
    kind?: 'file-transfer';
    connIds: Iterable<string>;
    ownerConnId: string;
    ownerClientId: string;
    recentInboundReachable: boolean;
    event: string;
  }) => void;
  handleFileTransferPushFailure: (args: { entry: OutboxEntry; error: unknown }) => void;
  handleFileTransferPushGuardFailure: (args: {
    entry: OutboxEntry;
    guard: {
      reason: 'media-url-missing' | 'no-gateway-context' | 'no-active-connection';
      lastError: string;
      recentInboundReachable?: boolean;
    };
  }) => void;
}) {
  const pushFileTransferSuccessPath = async (args: {
    entry: OutboxEntry;
    msg: Record<string, unknown>;
    owner: BncrConnection | null;
    connIds: Iterable<string>;
    recentInboundReachable: boolean;
    routeReason: string;
    mediaUrl: string;
  }): Promise<void> => {
    const media = await runtime.transferMediaToBncrClient({
      accountId: args.entry.accountId,
      sessionKey: args.entry.sessionKey,
      route: args.entry.route,
      mediaUrl: args.mediaUrl,
      mediaLocalRoots: Array.isArray(args.msg.mediaLocalRoots)
        ? args.msg.mediaLocalRoots.filter((v): v is string => typeof v === 'string')
        : undefined,
      downloadMedia: args.msg.downloadMedia as boolean | undefined,
    });
    const frame = runtime.buildFileTransferOutboundFrame({
      entry: args.entry,
      msg: args.msg,
      media,
      mediaUrl: args.mediaUrl,
    });

    runtime.getGatewayContext()!.broadcastToConnIds(
      runtime.pushEvent,
      buildFileTransferBroadcastPayload({
        frame,
        messageId: args.entry.messageId,
      }),
      new Set(args.connIds),
    );
    runtime.logOutboxRouteSelect(
      buildFileTransferRouteSelectArgs({
        entry: args.entry,
        connIds: args.connIds,
        routeReason: args.routeReason,
        recentInboundReachable: args.recentInboundReachable,
        owner: args.owner,
        event: runtime.pushEvent,
      }),
    );
    runtime.recordOutboxPushSuccess(
      buildFileTransferPushSuccessArgs({
        entry: args.entry,
        connIds: args.connIds,
        owner: args.owner,
      }),
    );
    runtime.logOutboxPushOkSummary(args.entry.messageId);
    runtime.logOutboxPushOk(
      buildFileTransferPushOkArgs({
        entry: args.entry,
        connIds: args.connIds,
        recentInboundReachable: args.recentInboundReachable,
        event: runtime.pushEvent,
      }),
    );
  };

  return {
    pushFileTransferSuccessPath,
    handleFileTransferPushFailure: runtime.handleFileTransferPushFailure,
    handleFileTransferPushGuardFailure: runtime.handleFileTransferPushGuardFailure,
  };
}
