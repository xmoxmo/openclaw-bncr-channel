import { createHash } from 'node:crypto';
import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import { getErrorMessage } from './error-message.ts';
import type { BncrFileInboundRuntime } from './file-inbound-runtime.ts';
import {
  type BncrInboundFileChunkEntry,
  isAbortedInboundTransfer,
  isCompletedInboundTransfer,
  markInboundTransferAborted,
  markInboundTransferCompleted,
} from './file-inbound-state.ts';
import { buildBncrGatewayEventContext } from './gateway-event-context.ts';

export function createBncrFileInboundCompleteHandler(runtime: BncrFileInboundRuntime) {
  return async function handleFileComplete({
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
    if (!transferId) {
      respond(false, { error: 'transferId required' });
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

    const staleObserved = runtime.observeLease('file.complete', params ?? {});
    // #not-merged Intentionally duplicated across complete/chunk/abort.
    // Each handler emits a distinct logWarn message with its own event-kind
    // in the format string, and the surrounding logic diverges in more than
    // just the event name.  Merging would add parameter-gluing boilerplate
    // with no reduction in total LOC.  See also the sibling files.
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
          `ignore kind=file.complete accountId=${accountId} connId=${connId} clientId=${clientId || '-'} transferId=${transferId} reason=owner-mismatch ownerConnId=${st.ownerConnId || '-'} ownerClientId=${st.ownerClientId || '-'}`,
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
      if (st.receivedChunks.size < st.totalChunks) {
        throw new Error(
          `chunk not complete received=${st.receivedChunks.size} total=${st.totalChunks}`,
        );
      }

      const ordered = (Array.from(st.bufferByChunk.entries()) as BncrInboundFileChunkEntry[])
        .sort((a, b) => a[0] - b[0])
        .map((x) => x[1]);
      const merged = Buffer.concat(ordered);
      if (st.fileSize > 0 && merged.length !== st.fileSize) {
        throw new Error(`file size mismatch expected=${st.fileSize} got=${merged.length}`);
      }
      const digest = createHash('sha256').update(merged).digest('hex');
      if (st.fileSha256 && digest !== st.fileSha256) {
        throw new Error('file sha256 mismatch');
      }

      const saved = await runtime.saveInboundMediaBuffer({
        buffer: merged,
        mimeType: st.mimeType,
        fileName: st.fileName,
      });
      const completedState = markInboundTransferCompleted(st, saved.path, runtime.now());
      runtime.fileRecvTransfers.set(transferId, completedState);

      respond(
        true,
        staleObserved.stale
          ? {
              ok: true,
              transferId,
              path: saved.path,
              size: merged.length,
              fileName: st.fileName,
              mimeType: st.mimeType,
              fileSha256: digest,
              stale: true,
              staleAccepted: true,
            }
          : {
              ok: true,
              transferId,
              path: saved.path,
              size: merged.length,
              fileName: st.fileName,
              mimeType: st.mimeType,
              fileSha256: digest,
            },
      );
    } catch (error) {
      const abortedState = markInboundTransferAborted(
        st,
        getErrorMessage(error, 'complete failed'),
        runtime.now(),
      );
      runtime.fileRecvTransfers.set(transferId, abortedState);
      respond(false, { error: abortedState.error });
    }
  };
}
