import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import { getErrorMessage } from './error-message.ts';
import { authorizeInboundTransfer } from './file-inbound-auth.ts';
import type { BncrFileInboundRuntime } from './file-inbound-runtime.ts';
import {
  BNCR_INBOUND_TRANSFER_ID_MAX_LENGTH,
  endInboundTransferOperation,
  isAbortedInboundTransfer,
  isActiveInboundTransfer,
  isCompletedInboundTransfer,
  markInboundTransferAborted,
  markInboundTransferCompleted,
  tryBeginInboundTransferOperation,
  withInboundTransferLock,
} from './file-inbound-state.ts';
import { discardInboundStagingFile, validateInboundStagingFile } from './file-inbound-storage.ts';
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
    if (transferId.length > BNCR_INBOUND_TRANSFER_ID_MAX_LENGTH) {
      respond(false, { error: `transferId too long max=${BNCR_INBOUND_TRANSFER_ID_MAX_LENGTH}` });
      return;
    }

    const authorized = authorizeInboundTransfer({
      runtime,
      accountId,
      transferId,
      connId,
      clientId,
      event: 'file.complete',
    });
    if (!authorized.ok) {
      respond(false, { error: authorized.error });
      return;
    }
    const st = authorized.state;
    const staleObserved = runtime.observeLease('file.complete', params ?? {});
    if (isCompletedInboundTransfer(st) || isAbortedInboundTransfer(st)) {
      respond(true, {
        ok: true,
        transferId,
        status: st.status,
        ...(isCompletedInboundTransfer(st) ? { path: st.completedPath } : { error: st.error }),
        ignored: true,
        terminal: true,
        ...(staleObserved.stale ? { stale: true, staleAccepted: true } : {}),
      });
      return;
    }
    if (!isActiveInboundTransfer(st)) {
      respond(false, { error: 'transfer not active' });
      return;
    }
    if (!staleObserved.stale) {
      runtime.refreshAcceptedFileTransferLiveState({
        accountId,
        connId,
        clientId,
        context: gatewayContext.context,
      });
    }
    const currentBeforeQueue = runtime.fileRecvTransfers.get(authorized.key);
    if (!currentBeforeQueue || !Object.is(currentBeforeQueue, st)) {
      respond(false, { error: 'transfer not found' });
      return;
    }
    if (!tryBeginInboundTransferOperation(st)) {
      respond(false, { error: 'transfer busy' });
      return;
    }

    try {
      await withInboundTransferLock(st, async () => {
        const current = runtime.fileRecvTransfers.get(authorized.key);
        if (!current || !Object.is(current, st)) {
          respond(false, { error: 'transfer not found' });
          return;
        }
        if (isCompletedInboundTransfer(current) || isAbortedInboundTransfer(current)) {
          respond(true, {
            ok: true,
            transferId,
            status: current.status,
            ...(isCompletedInboundTransfer(current)
              ? { path: current.completedPath }
              : { error: current.error }),
            ignored: true,
            terminal: true,
            ...(staleObserved.stale ? { stale: true, staleAccepted: true } : {}),
          });
          return;
        }
        if (!isActiveInboundTransfer(current)) {
          respond(false, { error: 'transfer not active' });
          return;
        }

        try {
          if (current.receivedChunks.size < current.totalChunks) {
            throw new Error(
              `chunk not complete received=${current.receivedChunks.size} total=${current.totalChunks}`,
            );
          }
          if (current.receivedBytes !== current.fileSize) {
            throw new Error(
              `received byte mismatch expected=${current.fileSize} got=${current.receivedBytes}`,
            );
          }
          if (!current.stagingPath) throw new Error('transfer staging file is unavailable');

          const validated = await validateInboundStagingFile({
            stagingPath: current.stagingPath,
            expectedSize: current.fileSize,
            expectedSha256: current.fileSha256,
          });
          const saved = await runtime.saveInboundMediaStream({
            accountId,
            stagingPath: current.stagingPath,
            size: validated.size,
            mimeType: current.mimeType,
            fileName: current.fileName,
          });
          try {
            await discardInboundStagingFile(current.stagingPath);
          } catch (cleanupError) {
            runtime.logWarn(
              'file',
              `completed transfer staging cleanup failed: ${getErrorMessage(cleanupError, 'unknown error')}`,
            );
          }
          const completedState = markInboundTransferCompleted(current, saved.path, runtime.now());
          runtime.fileRecvTransfers.set(authorized.key, completedState);

          respond(
            true,
            staleObserved.stale
              ? {
                  ok: true,
                  transferId,
                  path: saved.path,
                  size: validated.size,
                  fileName: current.fileName,
                  mimeType: current.mimeType,
                  fileSha256: validated.sha256,
                  stale: true,
                  staleAccepted: true,
                }
              : {
                  ok: true,
                  transferId,
                  path: saved.path,
                  size: validated.size,
                  fileName: current.fileName,
                  mimeType: current.mimeType,
                  fileSha256: validated.sha256,
                },
          );
        } catch (error) {
          const stagingPath = current.stagingPath;
          try {
            await discardInboundStagingFile(stagingPath);
          } catch (cleanupError) {
            runtime.logWarn(
              'file',
              `failed transfer staging cleanup failed: ${getErrorMessage(cleanupError, 'unknown error')}`,
            );
          }
          const abortedState = markInboundTransferAborted(
            current,
            getErrorMessage(error, 'complete failed'),
            runtime.now(),
          );
          runtime.fileRecvTransfers.set(authorized.key, abortedState);
          respond(false, { error: abortedState.error });
        }
      });
    } finally {
      endInboundTransferOperation(st);
    }
  };
}
