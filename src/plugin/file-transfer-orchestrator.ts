import { buildFileTransferInitPayload } from '../core/file-transfer-payloads.ts';
import type { BncrRoute, FileSendTransferState } from '../core/types.ts';
import { asSanitizedString, clampFiniteNumber } from '../core/value-sanitize.ts';
import { resolveOutboundFileName } from './channel-utils.ts';
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
  base64?: string;
}) {
  return {
    mode: 'base64' as const,
    mimeType: prepared.mimeType,
    fileName: prepared.fileName,
    base64: prepared.base64,
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
  const HTTP_URL_RE = /^https?:\/\//i;

  /** Try HEAD for Content-Type; fall back to Range+sniff for magic bytes when unclear. */
  async function resolveRemoteMediaType(url: string): Promise<{ mimeType?: string }> {
    // 1) HEAD -> Content-Type
    let headerType = '';
    try {
      const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
      if (head.ok) {
        const raw = (head.headers.get('content-type') || '').trim().toLowerCase();
        const parsed = raw.split(';')[0]?.trim() || '';
        // Accept explicit types; reject octet-stream and generic application/*
        if (parsed && parsed !== 'application/octet-stream') {
          headerType = parsed;
        }
      }
    } catch {
      /* HEAD failed, fall through to Range sniff */
    }

    if (headerType) return { mimeType: headerType };

    // 2) Range GET -> first 512 bytes -> magic byte sniff
    try {
      const range = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-511' },
        signal: AbortSignal.timeout(10_000),
      });
      // Only accept 206 Partial Content; 200 (no Range support) or other statuses -> fall through
      if (range.status !== 206) return {};
      const buf = Buffer.from(await range.arrayBuffer());
      if (buf.length < 4) return {};

      const sniffed = sniffMimeFromMagic(buf);
      if (!sniffed) return {};
      return { mimeType: sniffed };
    } catch {
      return {};
    }
  }

  /** Minimal magic-byte MIME sniffer for the first ~512 bytes. */
  function sniffMimeFromMagic(buf: Buffer): string | undefined {
    const eq = (off: number, ...bytes: number[]) =>
      bytes.every((b, idx) => off + idx < buf.length && buf[off + idx] === b);

    // JPEG: FF D8 FF
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
      return 'image/jpeg';
    // PNG: 89 50 4E 47
    if (eq(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
    // GIF: 47 49 46 38
    if (eq(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
    // WEBP: RIFF .... WEBP
    if (eq(0, 0x52, 0x49, 0x46, 0x46) && buf.length >= 12 && eq(8, 0x57, 0x45, 0x42, 0x50))
      return 'image/webp';
    // BMP: 42 4D
    if (eq(0, 0x42, 0x4d)) return 'image/bmp';
    // MP4 / MOV / M4A: ftyp box
    if (eq(4, 0x66, 0x74, 0x79, 0x70) && buf.length >= 12) {
      const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
      if (brand === 'M4A ' || brand === 'mp42') return 'audio/mp4';
      return 'video/mp4';
    }
    // MP3: ID3 tag
    if (eq(0, 0x49, 0x44, 0x33)) return 'audio/mpeg';
    // MPEG audio sync word
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
    // OGG: 4F 67 67 53
    if (eq(0, 0x4f, 0x67, 0x67, 0x53)) return 'audio/ogg';
    // WAV: RIFF .... WAVE
    if (eq(0, 0x52, 0x49, 0x46, 0x46) && buf.length >= 12 && eq(8, 0x57, 0x41, 0x56, 0x45))
      return 'audio/wav';
    // FLAC: 66 4C 61 43
    if (eq(0, 0x66, 0x4c, 0x61, 0x43)) return 'audio/flac';
    // PDF: 25 50 44 46
    if (eq(0, 0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
    // WebM/Matroska: 1A 45 DF A3
    if (eq(0, 0x1a, 0x45, 0xdf, 0xa3)) {
      for (let i = 0; i < Math.min(buf.length, 200); i++) {
        if (buf[i] === 0xae) return 'video/webm';
      }
      return 'audio/webm';
    }
    return undefined;
  }

  const transferMediaToBncrClient = async (params: {
    downloadMedia?: boolean;
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
  }): Promise<{
    mode: 'base64' | 'chunk';
    mimeType?: string;
    fileName?: string;
    base64?: string;
    path?: string;
  }> => {
    // HTTP URL: skip download/chunk, pass URL through to client
    if (HTTP_URL_RE.test(params.mediaUrl) && !params.downloadMedia) {
      const { mimeType } = await resolveRemoteMediaType(params.mediaUrl);
      const fileName = resolveOutboundFileName({
        mediaUrl: params.mediaUrl,
        mimeType,
      });
      return {
        mode: 'base64' as const,
        mimeType,
        fileName,
      };
    }
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
