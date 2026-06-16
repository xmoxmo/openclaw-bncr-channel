import type { BncrRoute } from '../core/types.ts';

export type BncrFileTransferLogsRuntime = {
  bridgeId: string;
  now: () => number;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
};

export function createBncrFileTransferLogs(runtime: BncrFileTransferLogsRuntime) {
  const logFileChunkDiag = (args: {
    accountId: string;
    sessionKey: string;
    mediaUrl: string;
    hasGatewayContext: boolean;
    activeConnectionKey?: string | null;
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
      [key: string]: unknown;
    }>;
  }) => {
    runtime.logInfo(
      'file-chunk-diag',
      JSON.stringify({
        bridge: runtime.bridgeId,
        accountId: args.accountId,
        sessionKey: args.sessionKey,
        mediaUrl: args.mediaUrl,
        hasGatewayContext: args.hasGatewayContext,
        activeConnectionKey: args.activeConnectionKey || null,
        ownerConnId: args.ownerConnId || null,
        ownerClientId: args.ownerClientId || null,
        directConnIds: Array.from(args.directConnIds),
        recentInboundReachable: args.recentInboundReachable,
        recentConnIds: Array.from(args.recentConnIds),
        accountConnections: args.accountConnections,
      }),
      { debugOnly: true },
    );
  };

  const logFileTransferStart = (args: {
    transferId: string;
    accountId: string;
    sessionKey: string;
    mediaUrl: string;
    fileName: string;
    mimeType?: string;
    fileSize: number;
    chunkSize: number;
    totalChunks: number;
    connIds: Iterable<string>;
    ownerConnId?: string;
    ownerClientId?: string;
  }) => {
    runtime.logInfo(
      'file-transfer-start',
      JSON.stringify({
        bridge: runtime.bridgeId,
        transferId: args.transferId,
        accountId: args.accountId,
        sessionKey: args.sessionKey,
        mediaUrl: args.mediaUrl,
        fileName: args.fileName,
        mimeType: args.mimeType,
        fileSize: args.fileSize,
        chunkSize: args.chunkSize,
        totalChunks: args.totalChunks,
        connIds: Array.from(args.connIds),
        ownerConnId: args.ownerConnId || null,
        ownerClientId: args.ownerClientId || null,
      }),
      { debugOnly: true },
    );
  };

  const logFileTransferChunkSend = (args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
    offset: number;
    size: number;
    connIds: Iterable<string>;
  }) => {
    runtime.logInfo(
      'file-transfer-chunk-send',
      JSON.stringify({
        bridge: runtime.bridgeId,
        transferId: args.transferId,
        accountId: args.accountId,
        chunkIndex: args.chunkIndex,
        attempt: args.attempt,
        offset: args.offset,
        size: args.size,
        connIds: Array.from(args.connIds),
      }),
      { debugOnly: true },
    );
  };

  const logFileTransferChunkAck = (args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
  }) => {
    runtime.logInfo(
      'file-transfer-chunk-ack',
      JSON.stringify({
        bridge: runtime.bridgeId,
        transferId: args.transferId,
        accountId: args.accountId,
        chunkIndex: args.chunkIndex,
        attempt: args.attempt,
      }),
      { debugOnly: true },
    );
  };

  const logFileTransferChunkAckFail = (args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
    error: unknown;
  }) => {
    runtime.logWarn(
      'file-transfer-chunk-ack-fail',
      JSON.stringify({
        bridge: runtime.bridgeId,
        transferId: args.transferId,
        accountId: args.accountId,
        chunkIndex: args.chunkIndex,
        attempt: args.attempt,
        error: String((args.error as Error)?.message || args.error || ''),
      }),
      { debugOnly: true },
    );
  };

  const logFileTransferCompleteSend = (args: {
    transferId: string;
    accountId: string;
    connIds: Iterable<string>;
  }) => {
    runtime.logInfo(
      'file-transfer-complete-send',
      JSON.stringify({
        bridge: runtime.bridgeId,
        transferId: args.transferId,
        accountId: args.accountId,
        connIds: Array.from(args.connIds),
      }),
      { debugOnly: true },
    );
  };

  const logFileTransferCompleteAck = (args: {
    transferId: string;
    accountId: string;
    payload: { path: string };
  }) => {
    runtime.logInfo(
      'file-transfer-complete-ack',
      JSON.stringify({
        bridge: runtime.bridgeId,
        transferId: args.transferId,
        accountId: args.accountId,
        payload: args.payload,
      }),
      { debugOnly: true },
    );
  };

  const buildInitialFileSendTransferState = (args: {
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
  }) => ({
    transferId: args.transferId,
    accountId: args.normalizeAccountId(args.accountId),
    sessionKey: args.sessionKey,
    route: args.route,
    fileName: args.fileName,
    mimeType: args.mimeType || 'application/octet-stream',
    fileSize: args.fileSize,
    chunkSize: args.chunkSize,
    totalChunks: args.totalChunks,
    fileSha256: args.fileSha256,
    startedAt: runtime.now(),
    status: 'init',
    ownerConnId: args.ownerConnId,
    ownerClientId: args.ownerClientId,
    ackedChunks: new Set<number>(),
    failedChunks: new Map<number, string>(),
  });

  return {
    logFileChunkDiag,
    logFileTransferStart,
    logFileTransferChunkSend,
    logFileTransferChunkAck,
    logFileTransferChunkAckFail,
    logFileTransferCompleteSend,
    logFileTransferCompleteAck,
    buildInitialFileSendTransferState,
  };
}
