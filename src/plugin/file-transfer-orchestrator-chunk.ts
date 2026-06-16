import { createHash } from 'node:crypto';
import { buildFileTransferAbortPayload } from '../core/file-transfer-payloads.ts';
import type { FileSendTransferState } from '../core/types.ts';
import { clampFiniteNumber } from '../core/value-sanitize.ts';
import { getErrorMessage } from './error-message.ts';

const FILE_TRANSFER_ACK_TTL_MS = 30_000;
const INTERNAL_SLEEP_MAX_MS = 120_000;

async function sleepFileTransferMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) =>
    setTimeout(resolve, clampFiniteNumber(ms, 0, 0, INTERNAL_SLEEP_MAX_MS)),
  );
}

export function ensureChunkAckPending(args: {
  state: FileSendTransferState;
  chunkIndex: number;
}): boolean {
  const { state, chunkIndex } = args;
  if (state.failedChunks.has(chunkIndex)) {
    throw new Error(state.failedChunks.get(chunkIndex) || `chunk ${chunkIndex} failed`);
  }
  return !state.ackedChunks.has(chunkIndex);
}

export async function sendChunkWithRetry(args: {
  transferId: string;
  accountId: string;
  chunkIndex: number;
  offset: number;
  slice: Buffer;
  connIds: Set<string>;
  waitChunkAck: (params: {
    transferId: string;
    chunkIndex: number;
    timeoutMs?: number;
  }) => Promise<void>;
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
}): Promise<void> {
  const { transferId, accountId, chunkIndex, offset, slice, connIds } = args;
  const chunkSha256 = createHash('sha256').update(slice).digest('hex');

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    args.sendChunk({
      transferId,
      accountId,
      chunkIndex,
      attempt,
      offset,
      size: slice.byteLength,
      chunkSha256,
      base64: slice.toString('base64'),
      connIds,
    });

    try {
      await args.waitChunkAck({
        transferId,
        chunkIndex,
        timeoutMs: FILE_TRANSFER_ACK_TTL_MS,
      });
      args.logFileTransferChunkAck({
        transferId,
        accountId,
        chunkIndex,
        attempt,
      });
      return;
    } catch (err) {
      lastErr = err;
      args.logFileTransferChunkAckFail({
        transferId,
        accountId,
        chunkIndex,
        attempt,
        error: err,
      });
      await sleepFileTransferMs(150 * attempt);
    }
  }

  throw new Error(getErrorMessage(lastErr, `chunk-${chunkIndex}-failed`));
}

export function abortChunkTransfer(args: {
  state: FileSendTransferState;
  transferId: string;
  reason: string;
  connIds: Set<string>;
  now: () => number;
  fileSendTransfers: Map<string, FileSendTransferState>;
  fileAbortEvent: string;
  broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => void;
}): never {
  const { state, transferId, reason, connIds } = args;
  state.status = 'aborted';
  state.terminalAt = args.now();
  state.error = reason;
  args.fileSendTransfers.set(transferId, state);
  args.broadcastToConnIds(
    args.fileAbortEvent,
    buildFileTransferAbortPayload({
      transferId,
      reason,
      ts: args.now(),
    }),
    connIds,
  );
  throw new Error(reason);
}
