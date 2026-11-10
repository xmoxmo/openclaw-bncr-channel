import type {
  FileRecvTransferAbortedState,
  FileRecvTransferCompletedState,
  FileRecvTransferInitState,
  FileRecvTransferState,
  FileRecvTransferTransferringState,
} from '../core/types.ts';

export const BNCR_INBOUND_CHUNK_SIZE_LIMIT = 1024 * 1024;
export const BNCR_INBOUND_TOTAL_CHUNKS_LIMIT = 32_768;
export const BNCR_INBOUND_ACTIVE_TRANSFERS_PER_ACCOUNT = 4;
export const BNCR_INBOUND_ACTIVE_TRANSFERS_GLOBAL = 8;
export const BNCR_INBOUND_PENDING_OPERATIONS_PER_TRANSFER = 4;
export const BNCR_INBOUND_PENDING_INIT_OPERATIONS = 64;
export const BNCR_INBOUND_IDLE_TIMEOUT_MS = 5 * 60_000;
export const BNCR_INBOUND_TRANSFER_ID_MAX_LENGTH = 256;
export const BNCR_INBOUND_SESSION_KEY_MAX_LENGTH = 8_192;
export const BNCR_INBOUND_FILE_NAME_MAX_LENGTH = 1_024;
export const BNCR_INBOUND_MIME_TYPE_MAX_LENGTH = 512;
export const BNCR_INBOUND_ABORT_REASON_MAX_LENGTH = 512;
export const BNCR_INBOUND_ROUTE_FIELD_MAX_LENGTH = 512;

export function isValidInboundSha256(value: string): boolean {
  return value === '' || /^[a-fA-F0-9]{64}$/.test(value);
}

/** Keep account identity in the internal key without changing the wire transferId. */
export function buildInboundFileTransferKey(accountId: string, transferId: string): string {
  return JSON.stringify([accountId, transferId]);
}

export function isCompletedInboundTransfer(
  state: FileRecvTransferState,
): state is FileRecvTransferCompletedState {
  return state.status === 'completed';
}

export function isAbortedInboundTransfer(
  state: FileRecvTransferState,
): state is FileRecvTransferAbortedState {
  return state.status === 'aborted';
}

export function isActiveInboundTransfer(
  state: FileRecvTransferState,
): state is FileRecvTransferInitState | FileRecvTransferTransferringState {
  return state.status === 'init' || state.status === 'transferring';
}

function releaseInboundTransferChunkTracking(state: FileRecvTransferState): void {
  state.receivedChunks.clear();
  state.receivedChunkDigests.clear();
}

export function markInboundTransferCompleted(
  state: FileRecvTransferState,
  completedPath: string,
  terminalAt: number,
): FileRecvTransferCompletedState {
  const next = state as FileRecvTransferCompletedState;
  next.status = 'completed';
  next.completedPath = completedPath;
  next.terminalAt = terminalAt;
  next.stagingPath = undefined;
  releaseInboundTransferChunkTracking(next);
  return next;
}

export function markInboundTransferTransferring(
  state: FileRecvTransferInitState | FileRecvTransferTransferringState,
): FileRecvTransferTransferringState {
  const next = state as FileRecvTransferTransferringState;
  next.status = 'transferring';
  return next;
}

export function markInboundTransferAborted(
  state: FileRecvTransferState,
  error: string,
  terminalAt: number,
): FileRecvTransferAbortedState {
  const next = state as FileRecvTransferAbortedState;
  next.status = 'aborted';
  next.terminalAt = terminalAt;
  next.error = error;
  next.stagingPath = undefined;
  releaseInboundTransferChunkTracking(next);
  return next;
}

export function withInboundTransferLock<T>(
  state: FileRecvTransferState,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = state.operationTail ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.operationTail = current;
  return previous.then(operation).finally(release);
}

export function tryBeginInboundTransferOperation(state: FileRecvTransferState): boolean {
  const pending = state.pendingOperations ?? 0;
  if (pending >= BNCR_INBOUND_PENDING_OPERATIONS_PER_TRANSFER) return false;
  state.pendingOperations = pending + 1;
  return true;
}

export function endInboundTransferOperation(state: FileRecvTransferState): void {
  const pending = state.pendingOperations ?? 0;
  state.pendingOperations = Math.max(0, pending - 1);
}
