import type {
  FileRecvTransferAbortedState,
  FileRecvTransferCompletedState,
  FileRecvTransferInitState,
  FileRecvTransferState,
  FileRecvTransferTransferringState,
} from '../core/types.ts';

export type BncrInboundFileChunkEntry = [number, Buffer];

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

export function markInboundTransferCompleted(
  state: FileRecvTransferState,
  completedPath: string,
  terminalAt: number,
): FileRecvTransferCompletedState {
  return {
    ...state,
    status: 'completed',
    completedPath,
    terminalAt,
  };
}

export function markInboundTransferTransferring(
  state: FileRecvTransferInitState | FileRecvTransferTransferringState,
): FileRecvTransferTransferringState {
  return {
    ...state,
    status: 'transferring',
  };
}

export function markInboundTransferAborted(
  state: FileRecvTransferState,
  error: string,
  terminalAt: number,
): FileRecvTransferAbortedState {
  return {
    ...state,
    status: 'aborted',
    terminalAt,
    error,
  };
}
