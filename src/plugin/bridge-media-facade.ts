import type { BncrRoute, FileSendTransferState } from '../core/types.ts';
import type {
  NormalizedReplyPayload,
  OutboundReplyTargetPolicy,
  ReplyMediaEntriesParams,
  ReplyPayloadInput,
} from '../messaging/outbound/reply-enqueue.ts';
import type { OpenClawLoadedMedia } from '../openclaw/media-runtime.ts';
import { loadOpenClawWebMedia } from '../openclaw/media-runtime.ts';

type RuntimeMediaApiHolder = Parameters<typeof loadOpenClawWebMedia>[0];

export function createBncrBridgeMediaFacade(runtime: {
  getApi: () => RuntimeMediaApiHolder;
  resolveOutboundFileName: (args: {
    mediaUrl: string;
    fileName?: string;
    mimeType?: string;
  }) => string;
  outboxRoute: {
    buildTransferRouteDiagnostics: (args: {
      accountId: string;
      recentInboundReachable: boolean;
    }) => unknown;
    selectTransferConnIds: (args: {
      directConnIds: Set<string>;
      recentConnIds: Set<string>;
      recentInboundReachable: boolean;
    }) => ReadonlySet<string>;
  };
  fileTransferOrchestrator: {
    waitChunkAck: (params: {
      transferId: string;
      chunkIndex: number;
      timeoutMs?: number;
    }) => Promise<void>;
    waitCompleteAck: (params: {
      transferId: string;
      timeoutMs?: number;
    }) => Promise<{ path: string }>;
    transferMediaToBncrClient: (params: {
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      mediaUrl: string;
      mediaLocalRoots?: readonly string[];
    }) => Promise<{
      mode: 'base64' | 'chunk';
      mimeType?: string;
      fileName?: string;
      base64?: string;
      path?: string;
    }>;
  };
  replyMediaOrchestrator: {
    enqueueFromReply: (params: {
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      payload: ReplyPayloadInput;
      mediaLocalRoots?: readonly string[];
      replyTargetPolicy?: OutboundReplyTargetPolicy;
    }) => void;
    enqueueReplyMediaEntries: (params: ReplyMediaEntriesParams) => void;
  };
  logInfoJson: (
    scope: string | undefined,
    event: string,
    payload: Record<string, unknown>,
    options?: { debugOnly?: boolean },
  ) => void;
  buildEnqueueFromReplyDebugInfo: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: NormalizedReplyPayload;
  }) => Record<string, unknown>;
  fileTransferLogs: {
    logFileChunkDiag: (args: {
      accountId: string;
      sessionKey: string;
      mediaUrl: string;
      hasGatewayContext: boolean;
      activeConnectionKey: string | null;
      ownerConnId?: string;
      ownerClientId?: string;
      directConnIds: Iterable<string>;
      recentInboundReachable: boolean;
      recentConnIds: Iterable<string>;
      accountConnections: Array<{
        connId: string;
        clientId?: string;
        connectedAt: number;
        lastSeenAt: number;
      }>;
    }) => void;
    logFileTransferStart: (args: {
      transferId: string;
      accountId: string;
      sessionKey: string;
      mediaUrl: string;
      fileName: string;
      mimeType?: string;
      fileSize: number;
      chunkSize: number;
      totalChunks: number;
      connIds: ReadonlySet<string>;
      ownerConnId?: string;
      ownerClientId?: string;
    }) => void;
    logFileTransferChunkSend: (args: {
      transferId: string;
      accountId: string;
      chunkIndex: number;
      attempt: number;
      offset: number;
      size: number;
      connIds: ReadonlySet<string>;
    }) => void;
    logFileTransferChunkAck: (args: {
      transferId: string;
      accountId: string;
      chunkIndex: number;
      attempt: number;
    }) => void;
    logFileTransferChunkAckFail: (args: {
      transferId: string;
      accountId: string;
      chunkIndex: number;
      attempt: number;
      error: unknown;
    }) => void;
    logFileTransferCompleteSend: (args: {
      transferId: string;
      accountId: string;
      connIds: ReadonlySet<string>;
    }) => void;
    logFileTransferCompleteAck: (args: {
      transferId: string;
      accountId: string;
      payload: { path: string };
    }) => void;
    buildInitialFileSendTransferState: (args: {
      transferId: string;
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      fileName: string;
      mimeType?: string;
      fileSize: number;
      chunkSize: number;
      totalChunks: number;
      fileSha256: string;
      ownerConnId?: string;
      ownerClientId?: string;
      normalizeAccountId: (accountId: string) => string;
    }) => FileSendTransferState;
  };
  normalizeAccountId: (accountId: string) => string;
}) {
  const loadOutboundTransferMedia = async (params: {
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
    downloadMedia?: boolean;
  }): Promise<{
    loaded: OpenClawLoadedMedia;
    size: number;
    mimeType?: string;
    fileName: string;
  }> => {
    const loaded = await loadOpenClawWebMedia(runtime.getApi(), params.mediaUrl, {
      localRoots: params.mediaLocalRoots,
      maxBytes: 50 * 1024 * 1024,
    });
    const size = loaded.buffer.byteLength;
    const mimeType = loaded.contentType;
    const fileName = runtime.resolveOutboundFileName({
      mediaUrl: params.mediaUrl,
      fileName: loaded.fileName,
      mimeType,
    });
    return { loaded, size, mimeType, fileName };
  };

  const logEnqueueFromReply = (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: NormalizedReplyPayload;
  }) => {
    runtime.logInfoJson(
      'outbound',
      'enqueue-from-reply',
      runtime.buildEnqueueFromReplyDebugInfo(args),
      {
        debugOnly: true,
      },
    );
  };

  return {
    loadOutboundTransferMedia,
    buildTransferRouteDiagnostics: (args: { accountId: string; recentInboundReachable: boolean }) =>
      runtime.outboxRoute.buildTransferRouteDiagnostics(args),
    selectTransferConnIds: (args: {
      directConnIds: Set<string>;
      recentConnIds: Set<string>;
      recentInboundReachable: boolean;
    }) => runtime.outboxRoute.selectTransferConnIds(args),
    waitChunkAck: runtime.fileTransferOrchestrator.waitChunkAck,
    waitCompleteAck: runtime.fileTransferOrchestrator.waitCompleteAck,
    transferMediaToBncrClient: runtime.fileTransferOrchestrator.transferMediaToBncrClient,
    enqueueFromReply: runtime.replyMediaOrchestrator.enqueueFromReply,
    enqueueReplyMediaEntries: runtime.replyMediaOrchestrator.enqueueReplyMediaEntries,
    logEnqueueFromReply,
    logFileChunkDiag: runtime.fileTransferLogs.logFileChunkDiag,
    logFileTransferStart: runtime.fileTransferLogs.logFileTransferStart,
    logFileTransferChunkSend: runtime.fileTransferLogs.logFileTransferChunkSend,
    logFileTransferChunkAck: runtime.fileTransferLogs.logFileTransferChunkAck,
    logFileTransferChunkAckFail: runtime.fileTransferLogs.logFileTransferChunkAckFail,
    logFileTransferCompleteSend: runtime.fileTransferLogs.logFileTransferCompleteSend,
    logFileTransferCompleteAck: runtime.fileTransferLogs.logFileTransferCompleteAck,
    buildInitialFileSendTransferState: (args: {
      transferId: string;
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      fileName: string;
      mimeType?: string;
      fileSize: number;
      chunkSize: number;
      totalChunks: number;
      fileSha256: string;
      ownerConnId?: string;
      ownerClientId?: string;
    }) =>
      runtime.fileTransferLogs.buildInitialFileSendTransferState({
        ...args,
        normalizeAccountId: runtime.normalizeAccountId,
      }),
  };
}
