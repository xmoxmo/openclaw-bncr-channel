import {
  createBncrFileAckRuntime,
  type FileAckPayloadState,
  type FileAckWaiter,
} from './file-ack-runtime.ts';
import { createBncrFileTransferLogs } from './file-transfer-logs.ts';
import { createBncrFileTransferSend } from './file-transfer-send.ts';
import {
  type BncrFileTransferRouteDiagnostics,
  createBncrFileTransferSetup,
} from './file-transfer-setup.ts';

export function createBncrFileTransferRuntimeGroup(runtime: {
  bridgeId: string;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  clampFiniteNumber: (value: unknown, fallback: number, min?: number, max?: number) => number;
  fileAckTimeoutMs: number;
  maxEarlyFileAcks: number;
  fileAckWaiters: Map<string, FileAckWaiter>;
  earlyFileAcks: Map<string, FileAckPayloadState>;
  getFileAckOwnerInfo: (transferId: string) => Record<string, unknown>;
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
  broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => void;
  chunkEvent: string;
  completeEvent: string;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
}) {
  const fileAckRuntime = createBncrFileAckRuntime({
    bridgeId: runtime.bridgeId,
    now: runtime.now,
    asString: runtime.asString,
    clampFiniteNumber: (value, fallback, min, max) =>
      runtime.clampFiniteNumber(value, fallback, min ?? fallback, max ?? fallback),
    fileAckTimeoutMs: runtime.fileAckTimeoutMs,
    maxEarlyFileAcks: runtime.maxEarlyFileAcks,
    fileAckWaiters: runtime.fileAckWaiters,
    earlyFileAcks: runtime.earlyFileAcks,
    getFileAckOwnerInfo: runtime.getFileAckOwnerInfo,
    logInfo: runtime.logInfo,
    logWarn: runtime.logWarn,
  });

  const fileTransferLogs = createBncrFileTransferLogs({
    bridgeId: runtime.bridgeId,
    now: runtime.now,
    logInfo: (scope, message, options) => runtime.logInfo(scope, message, options),
    logWarn: (scope, message, options) => runtime.logWarn(scope, message, options),
  });

  const fileTransferSetup = createBncrFileTransferSetup({
    fileForceChunk: runtime.fileForceChunk,
    fileInlineThreshold: runtime.fileInlineThreshold,
    normalizeAccountId: runtime.normalizeAccountId,
    loadOutboundTransferMedia: runtime.loadOutboundTransferMedia,
    resolveOutboxPushOwner: runtime.resolveOutboxPushOwner,
    hasRecentInboundReachability: runtime.hasRecentInboundReachability,
    buildTransferRouteDiagnostics: runtime.buildTransferRouteDiagnostics,
    selectTransferConnIds: runtime.selectTransferConnIds,
    logFileChunkDiag: fileTransferLogs.logFileChunkDiag,
    logFileTransferStart: fileTransferLogs.logFileTransferStart,
    buildInitialFileSendTransferState: (args) =>
      fileTransferLogs.buildInitialFileSendTransferState({
        ...args,
        normalizeAccountId: runtime.normalizeAccountId,
      }),
  });

  const fileTransferSend = createBncrFileTransferSend({
    now: runtime.now,
    broadcastToConnIds: runtime.broadcastToConnIds,
    chunkEvent: runtime.chunkEvent,
    completeEvent: runtime.completeEvent,
    logFileTransferChunkSend: fileTransferLogs.logFileTransferChunkSend,
    logFileTransferCompleteSend: fileTransferLogs.logFileTransferCompleteSend,
  });

  return {
    fileAckRuntime,
    fileTransferLogs,
    fileTransferSetup,
    fileTransferSend,
  };
}
