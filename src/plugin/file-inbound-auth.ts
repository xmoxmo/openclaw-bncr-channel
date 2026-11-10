import type { FileRecvTransferState } from '../core/types.ts';
import type { BncrFileInboundRuntime } from './file-inbound-runtime.ts';
import { buildInboundFileTransferKey } from './file-inbound-state.ts';

export type AuthorizedInboundTransfer =
  | {
      ok: true;
      key: string;
      state: FileRecvTransferState;
    }
  | {
      ok: false;
      error: 'transfer not found';
    };

/** Resolve and authorize before exposing terminal state or completed paths. */
export function authorizeInboundTransfer(args: {
  runtime: BncrFileInboundRuntime;
  accountId: string;
  transferId: string;
  connId: string;
  clientId?: string;
  event: 'file.chunk' | 'file.complete' | 'file.abort';
}): AuthorizedInboundTransfer {
  const accountId = args.runtime.normalizeAccountId(args.accountId);
  const key = buildInboundFileTransferKey(accountId, args.transferId);
  const state = args.runtime.fileRecvTransfers.get(key);
  if (!state || state.accountId !== accountId) {
    return { ok: false, error: 'transfer not found' };
  }
  if (
    !args.runtime.matchesTransferOwner({
      ownerConnId: state.ownerConnId,
      ownerClientId: state.ownerClientId,
      connId: args.connId,
      clientId: args.clientId,
    })
  ) {
    args.runtime.logWarn(
      'stale',
      `ignore kind=${args.event} accountId=${accountId} connId=${args.connId} clientId=${args.clientId || '-'} transferId=${args.transferId} reason=owner-mismatch ownerConnId=${state.ownerConnId || '-'} ownerClientId=${state.ownerClientId || '-'}`,
      { debugOnly: true },
    );
    return { ok: false, error: 'transfer not found' };
  }
  return { ok: true, key, state };
}
