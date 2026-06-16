import { buildFileTransferInitPayload } from '../core/file-transfer-payloads.ts';
import type { BncrRoute, FileSendTransferState } from '../core/types.ts';
import { asSanitizedString, clampFiniteNumber } from '../core/value-sanitize.ts';
import type { createBncrFileAckRuntime } from './file-ack-runtime.ts';
import {
  abortChunkTransfer,
  ensureChunkAckPending,
  sendChunkWithRetry,
} from './file-transfer-orchestrator-chunk.ts';
import type { createBncrFileTransferSetup } from './file-transfer-setup.ts';

type PreparedOutboundTransfer = Awaited<
  ReturnType<ReturnType<typeof createBncrFileTransferSetup>['prepareOutboundTransfer']>
>;
type FileAckPayload = Awaited<
  ReturnType<ReturnType<typeof createBncrFileAckRuntime>['waitForFileAck']>
>;

const FILE_TRANSFER_ACK_TTL_MS = 30_000;

function getFileSendTransferForAck(
  fileSendTransfers: ReadonlyMap<string, FileSendTransferState>,
  transferId: string,
): FileSendTransferState {
  const state = fileSendTransfers.get(transferId);
  if (!state) throw new Error('transfer state missing');
  return state;
}

function getCompletedTransferPath(state?: FileSendTransferState): string | null {
  if (state?.status !== 'completed') return null;
  const path = asSanitizedString(state.completedPath || '').trim();
  return path || null;
}

function buildBase64TransferResult(prepared: {
  mimeType?: string;
  fileName?: string;
  mediaBase64?: string;
}) {
  return {
    mode: 'base64' as const,
    mimeType: prepared.mimeType,
    fileName: prepared.fileName,
    mediaBase64: prepared.mediaBase64,
  };
}

function buildChunkTransferResult(args: { mimeType: string; fileName: string; path?: string }) {
  return {
    mode: 'chunk' as const,
    mimeType: args.mimeType,
    fileName: args.fileName,
    path: args.path,
  };
}

function ensureTransferMimeType(mimeType: string | undefined, fileName: string): string {
  const value = asSanitizedString(mimeType || '').trim();
  if (value) return value;

  const lowerFileName = fileName.toLowerCase();
  if (lowerFileName.endsWith('.png')) return 'image/png';
  if (lowerFileName.endsWith('.jpg') || lowerFileName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerFileName.endsWith('.gif')) return 'image/gif';
  if (lowerFileName.endsWith('.webp')) return 'image/webp';
  if (lowerFileName.endsWith('.mp3')) return 'audio/mpeg';
  if (lowerFileName.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}

export type BncrFileTransferOrchestratorRuntime = {
  now: () => number;
  fileSendTransfers: Map<string, FileSendTransferState>;
  getGatewayContext: () => {
    broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => void;
  } | null;
  fileInitEvent: string;
  fileAbortEvent: string;
  prepareOutboundTransfer: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
    hasGatewayContext: boolean;
  }) => Promise<PreparedOutboundTransfer>;
  sendChunk: (args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
    offset: number;
    size: number;
    chunkSha256: string;
    base64: string;
    connIds: ReadonlySet<string>;
  }) => void;
  sendComplete: (args: {
    transferId: string;
    accountId: string;
    connIds: ReadonlySet<string>;
  }) => void;
  waitForFileAck: (params: {
    transferId: string;
    stage: string;
    chunkIndex?: number;
    timeoutMs: number;
  }) => Promise<FileAckPayload>;
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
  logFileTransferCompleteAck: (args: {
    transferId: string;
    accountId: string;
    payload: { path: string };
  }) => void;
};

export function createBncrFileTransferOrchestrator(runtime: BncrFileTransferOrchestratorRuntime) {
  const waitChunkAck = async (params: {
    transferId: string;
    chunkIndex: number;
    timeoutMs?: number;
  }): Promise<void> => {
    const { transferId, chunkIndex } = params;
    const st = getFileSendTransferForAck(runtime.fileSendTransfers, transferId);
    if (!ensureChunkAckPending({ state: st, chunkIndex })) return;

    await runtime.waitForFileAck({
      transferId,
      stage: 'chunk',
      chunkIndex,
      timeoutMs: clampFiniteNumber(params.timeoutMs, FILE_TRANSFER_ACK_TTL_MS, 1_000, 60_000),
    });
  };

  const waitCompleteAck = async (params: {
    transferId: string;
    timeoutMs?: number;
  }): Promise<{ path: string }> => {
    const { transferId } = params;
    const st = getFileSendTransferForAck(runtime.fileSendTransfers, transferId);
    if (st.status === 'aborted') throw new Error(st.error || 'transfer aborted');
    const completedPath = getCompletedTransferPath(st);
    if (completedPath) return { path: completedPath };

    const payload = await runtime.waitForFileAck({
      transferId,
      stage: 'complete',
      timeoutMs: clampFiniteNumber(params.timeoutMs, 60_000, 2_000, 120_000),
    });
    const updated = runtime.fileSendTransfers.get(transferId);
    const path = asSanitizedString(payload?.path || getCompletedTransferPath(updated) || '').trim();
    if (!path) throw new Error('complete ack missing path');
    return { path };
  };

  const finalizeChunkTransfer = async (params: {
    transferId: string;
    accountId: string;
    connIds: Set<string>;
    mimeType: string;
    fileName: string;
  }): Promise<{ mode: 'chunk'; mimeType: string; fileName: string; path?: string }> => {
    const { transferId, accountId, connIds, mimeType, fileName } = params;
    runtime.sendComplete({
      transferId,
      accountId,
      connIds,
    });

    const done = await waitCompleteAck({ transferId, timeoutMs: 60_000 });

    runtime.logFileTransferCompleteAck({
      transferId,
      accountId,
      payload: done,
    });

    return buildChunkTransferResult({ mimeType, fileName, path: done.path });
  };

  const transferMediaToBncrClient = async (params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
  }): Promise<{
    mode: 'base64' | 'chunk';
    mimeType?: string;
    fileName?: string;
    mediaBase64?: string;
    path?: string;
  }> => {
    const prepared = await runtime.prepareOutboundTransfer({
      accountId: params.accountId,
      sessionKey: params.sessionKey,
      route: params.route,
      mediaUrl: params.mediaUrl,
      mediaLocalRoots: params.mediaLocalRoots,
      hasGatewayContext: Boolean(runtime.getGatewayContext()),
    });

    if (prepared.mode === 'base64') {
      return buildBase64TransferResult(prepared);
    }

    const ctx = runtime.getGatewayContext();
    if (!ctx) throw new Error('gateway context unavailable');

    const {
      loaded,
      size,
      fileName,
      fileSha256,
      accountId,
      connIds,
      transferId,
      chunkSize,
      totalChunks,
      state,
    } = prepared;
    const mimeType = ensureTransferMimeType(prepared.mimeType, fileName);
    if (!connIds.size) throw new Error('no active bncr client for file chunk transfer');
    const st = state as FileSendTransferState;
    runtime.fileSendTransfers.set(transferId, st);

    ctx.broadcastToConnIds(
      runtime.fileInitEvent,
      buildFileTransferInitPayload({
        transferId,
        sessionKey: params.sessionKey,
        route: params.route,
        fileName,
        mimeType,
        fileSize: size,
        chunkSize,
        totalChunks,
        fileSha256,
        ts: runtime.now(),
      }),
      connIds,
    );

    for (let idx = 0; idx < totalChunks; idx++) {
      const start = idx * chunkSize;
      const end = Math.min(start + chunkSize, size);
      const slice = loaded.buffer.subarray(start, end);

      try {
        await sendChunkWithRetry({
          transferId,
          accountId,
          chunkIndex: idx,
          offset: start,
          slice,
          connIds,
          waitChunkAck,
          sendChunk: runtime.sendChunk,
          logFileTransferChunkAck: runtime.logFileTransferChunkAck,
          logFileTransferChunkAckFail: runtime.logFileTransferChunkAckFail,
        });
      } catch (err) {
        abortChunkTransfer({
          state: st,
          transferId,
          reason: err instanceof Error ? err.message : String(err),
          connIds,
          now: runtime.now,
          fileSendTransfers: runtime.fileSendTransfers,
          fileAbortEvent: runtime.fileAbortEvent,
          broadcastToConnIds: (event, payload, connIds) =>
            runtime.getGatewayContext()!.broadcastToConnIds(event, payload, connIds),
        });
      }
    }

    return finalizeChunkTransfer({
      transferId,
      accountId,
      connIds,
      mimeType,
      fileName,
    });
  };

  return {
    waitChunkAck,
    waitCompleteAck,
    transferMediaToBncrClient,
  };
}
