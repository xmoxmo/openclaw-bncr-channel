import { createHash, randomUUID } from 'node:crypto';
import type { BncrRoute } from '../core/types.ts';

export type BncrFileTransferRouteDiagnostics = {
  activeConnectionKey: string | null;
  directConnIds: Set<string>;
  recentConnIds: Set<string>;
  accountConnections: Array<{
    connId: string;
    clientId?: string;
    connectedAt: number;
    lastSeenAt: number;
  }>;
};

export type BncrFileTransferSetupRuntime = {
  fileForceChunk: boolean;
  fileInlineThreshold: number;
  normalizeAccountId: (accountId: string) => string;
  loadOutboundTransferMedia: (args: {
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
  }) => Promise<{ loaded: { buffer: Buffer }; size: number; mimeType?: string; fileName: string }>;
  resolveOutboxPushOwner: (accountId: string) => { connId?: string; clientId?: string } | null;
  hasRecentInboundReachability: (accountId: string) => boolean;
  buildTransferRouteDiagnostics: (args: {
    accountId: string;
    recentInboundReachable: boolean;
  }) => BncrFileTransferRouteDiagnostics;
  selectTransferConnIds: (args: {
    directConnIds: Set<string>;
    recentConnIds: Set<string>;
    recentInboundReachable: boolean;
  }) => Set<string>;
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
  }) => {
    transferId: string;
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    fileName: string;
    mimeType: string;
    fileSize: number;
    chunkSize: number;
    totalChunks: number;
    fileSha256: string;
    startedAt: number;
    status: string;
    ownerConnId?: string;
    ownerClientId?: string;
    ackedChunks: Set<number>;
    failedChunks: Map<number, string>;
  };
};

export function createBncrFileTransferSetup(runtime: BncrFileTransferSetupRuntime) {
  const prepareOutboundTransfer = async (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
    hasGatewayContext: boolean;
  }) => {
    const { loaded, size, mimeType, fileName } = await runtime.loadOutboundTransferMedia({
      mediaUrl: args.mediaUrl,
      mediaLocalRoots: args.mediaLocalRoots,
    });

    if (!runtime.fileForceChunk && size <= runtime.fileInlineThreshold) {
      return {
        mode: 'base64' as const,
        mimeType,
        fileName,
        base64: loaded.buffer.toString('base64'),
      };
    }

    const owner = runtime.resolveOutboxPushOwner(args.accountId);
    const recentInboundReachable = runtime.hasRecentInboundReachability(args.accountId);
    const normalizedAccountId = runtime.normalizeAccountId(args.accountId);
    const routeDiagnostics = runtime.buildTransferRouteDiagnostics({
      accountId: normalizedAccountId,
      recentInboundReachable,
    });
    runtime.logFileChunkDiag({
      accountId: normalizedAccountId,
      sessionKey: args.sessionKey,
      mediaUrl: args.mediaUrl,
      hasGatewayContext: args.hasGatewayContext,
      activeConnectionKey: routeDiagnostics.activeConnectionKey,
      ownerConnId: owner?.connId,
      ownerClientId: owner?.clientId,
      directConnIds: routeDiagnostics.directConnIds,
      recentInboundReachable,
      recentConnIds: routeDiagnostics.recentConnIds,
      accountConnections: routeDiagnostics.accountConnections,
    });

    const connIds = runtime.selectTransferConnIds({
      directConnIds: routeDiagnostics.directConnIds,
      recentConnIds: routeDiagnostics.recentConnIds,
      recentInboundReachable,
    });
    const transferId = randomUUID();
    const chunkSize = 256 * 1024;
    const totalChunks = Math.ceil(size / chunkSize);
    const fileSha256 = createHash('sha256').update(loaded.buffer).digest('hex');

    runtime.logFileTransferStart({
      transferId,
      accountId: normalizedAccountId,
      sessionKey: args.sessionKey,
      mediaUrl: args.mediaUrl,
      fileName,
      mimeType,
      fileSize: size,
      chunkSize,
      totalChunks,
      connIds,
      ownerConnId: owner?.connId,
      ownerClientId: owner?.clientId,
    });

    const state = runtime.buildInitialFileSendTransferState({
      transferId,
      accountId: args.accountId,
      sessionKey: args.sessionKey,
      route: args.route,
      fileName,
      mimeType,
      fileSize: size,
      chunkSize,
      totalChunks,
      fileSha256,
      ownerConnId: owner?.connId,
      ownerClientId: owner?.clientId,
    });

    return {
      mode: 'chunk' as const,
      loaded,
      size,
      mimeType,
      fileName,
      owner,
      recentInboundReachable,
      accountId: normalizedAccountId,
      routeDiagnostics,
      connIds,
      transferId,
      chunkSize,
      totalChunks,
      fileSha256,
      state,
    };
  };

  return {
    prepareOutboundTransfer,
  };
}
