import { createHash } from 'node:crypto';
import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import { getErrorMessage } from './error-message.ts';
import type { BncrFileInboundRuntime } from './file-inbound-runtime.ts';
import {
  isAbortedInboundTransfer,
  isActiveInboundTransfer,
  isCompletedInboundTransfer,
  markInboundTransferTransferring,
} from './file-inbound-state.ts';
import { buildBncrGatewayEventContext } from './gateway-event-context.ts';

export function createBncrFileInboundChunkHandler(runtime: BncrFileInboundRuntime) {
  return async function handleFileChunk({
    params,
    respond,
    client,
    context,
  }: GatewayRequestHandlerOptions) {
    const gatewayContext = buildBncrGatewayEventContext({
      params,
      client,
      context,
      asString: runtime.asString,
      normalizeAccountId: runtime.normalizeAccountId,
      now: runtime.now,
    });
    const { accountId, connId, clientId } = gatewayContext;

    const transferId = runtime.asString(params?.transferId || '').trim();
    const chunkIndex = runtime.finiteNonNegativeNumberOrNull(params?.chunkIndex);
    const offset = runtime.finiteNonNegativeNumberOrNull(params?.offset ?? 0);
    const size = runtime.finiteNonNegativeNumberOrNull(params?.size ?? 0);
    const chunkSha256 = runtime.asString(params?.chunkSha256 || '').trim();
    const base64 = runtime.asString(params?.base64 || '');

    if (!transferId || chunkIndex == null || !base64) {
      respond(false, { error: 'transferId/chunkIndex/base64 required' });
      return;
    }

    const st = runtime.fileRecvTransfers.get(transferId);
    if (!st) {
      respond(false, { error: 'transfer not found' });
      return;
    }
    if (isCompletedInboundTransfer(st)) {
      respond(true, {
        ok: true,
        transferId,
        status: 'completed',
        path: st.completedPath,
        ignored: true,
        terminal: true,
      });
      return;
    }
    if (isAbortedInboundTransfer(st)) {
      respond(true, {
        ok: true,
        transferId,
        status: 'aborted',
        error: st.error,
        ignored: true,
        terminal: true,
      });
      return;
    }
    if (!isActiveInboundTransfer(st)) {
      respond(false, { error: 'transfer not active' });
      return;
    }
    if (chunkIndex >= st.totalChunks) {
      respond(false, {
        error: `chunkIndex out of range index=${chunkIndex} total=${st.totalChunks}`,
      });
      return;
    }

    const staleObserved = runtime.observeLease('file.chunk', params ?? {});
    if (staleObserved.stale) {
      if (
        !runtime.matchesTransferOwner({
          ownerConnId: st.ownerConnId,
          ownerClientId: st.ownerClientId,
          connId,
          clientId,
        })
      ) {
        runtime.logWarn(
          'stale',
          `ignore kind=file.chunk accountId=${accountId} connId=${connId} clientId=${clientId || '-'} transferId=${transferId} reason=owner-mismatch ownerConnId=${st.ownerConnId || '-'} ownerClientId=${st.ownerClientId || '-'}`,
          { debugOnly: true },
        );
        respond(true, { ok: true, stale: true, ignored: true });
        return;
      }
    } else {
      runtime.refreshAcceptedFileTransferLiveState({
        accountId,
        connId,
        clientId,
        context: gatewayContext.context,
      });
    }

    try {
      const buf = Buffer.from(base64, 'base64');
      if (size != null && size > 0 && buf.length !== size) {
        throw new Error(`chunk size mismatch expected=${size} got=${buf.length}`);
      }
      if (chunkSha256) {
        const digest = createHash('sha256').update(buf).digest('hex');
        if (digest !== chunkSha256) throw new Error('chunk sha256 mismatch');
      }
      st.bufferByChunk.set(chunkIndex, buf);
      st.receivedChunks.add(chunkIndex);
      runtime.fileRecvTransfers.set(transferId, markInboundTransferTransferring(st));

      respond(
        true,
        staleObserved.stale
          ? {
              ok: true,
              transferId,
              chunkIndex,
              offset,
              received: st.receivedChunks.size,
              totalChunks: st.totalChunks,
              stale: true,
              staleAccepted: true,
            }
          : {
              ok: true,
              transferId,
              chunkIndex,
              offset,
              received: st.receivedChunks.size,
              totalChunks: st.totalChunks,
            },
      );
    } catch (error) {
      respond(false, { error: getErrorMessage(error, 'chunk invalid') });
    }
  };
}
