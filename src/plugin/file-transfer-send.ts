import {
  buildFileTransferChunkPayload,
  buildFileTransferCompletePayload,
} from '../core/file-transfer-payloads.ts';

export type BncrFileTransferSendRuntime = {
  now: () => number;
  broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => void;
  chunkEvent: string;
  completeEvent: string;
  logFileTransferChunkSend: (args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
    offset: number;
    size: number;
    connIds: ReadonlySet<string>;
  }) => void;
  logFileTransferCompleteSend: (args: {
    transferId: string;
    accountId: string;
    connIds: ReadonlySet<string>;
  }) => void;
};

export function createBncrFileTransferSend(runtime: BncrFileTransferSendRuntime) {
  const sendChunk = (args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
    offset: number;
    size: number;
    chunkSha256: string;
    base64: string;
    connIds: ReadonlySet<string>;
  }) => {
    runtime.broadcastToConnIds(
      runtime.chunkEvent,
      buildFileTransferChunkPayload({
        transferId: args.transferId,
        chunkIndex: args.chunkIndex,
        offset: args.offset,
        size: args.size,
        chunkSha256: args.chunkSha256,
        base64: args.base64,
        ts: runtime.now(),
      }),
      args.connIds,
    );

    runtime.logFileTransferChunkSend({
      transferId: args.transferId,
      accountId: args.accountId,
      chunkIndex: args.chunkIndex,
      attempt: args.attempt,
      offset: args.offset,
      size: args.size,
      connIds: args.connIds,
    });
  };

  const sendComplete = (args: {
    transferId: string;
    accountId: string;
    connIds: ReadonlySet<string>;
  }) => {
    runtime.broadcastToConnIds(
      runtime.completeEvent,
      buildFileTransferCompletePayload({
        transferId: args.transferId,
        ts: runtime.now(),
      }),
      args.connIds,
    );

    runtime.logFileTransferCompleteSend({
      transferId: args.transferId,
      accountId: args.accountId,
      connIds: args.connIds,
    });
  };

  return {
    sendChunk,
    sendComplete,
  };
}
