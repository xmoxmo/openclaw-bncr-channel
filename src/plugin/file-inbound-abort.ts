import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import { authorizeInboundTransfer } from './file-inbound-auth.ts';
import type { BncrFileInboundRuntime } from './file-inbound-runtime.ts';
import {
  BNCR_INBOUND_ABORT_REASON_MAX_LENGTH,
  BNCR_INBOUND_TRANSFER_ID_MAX_LENGTH,
  endInboundTransferOperation,
  isAbortedInboundTransfer,
  isActiveInboundTransfer,
  isCompletedInboundTransfer,
  markInboundTransferAborted,
  tryBeginInboundTransferOperation,
  withInboundTransferLock,
} from './file-inbound-state.ts';
import { discardInboundStagingFile } from './file-inbound-storage.ts';
import { buildBncrGatewayEventContext } from './gateway-event-context.ts';

export function createBncrFileInboundAbortHandler(runtime: BncrFileInboundRuntime) {
  return async function handleFileAbort({
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
    const reason = runtime.asString(params?.reason || 'aborted').trim() || 'aborted';
    if (reason.length > BNCR_INBOUND_ABORT_REASON_MAX_LENGTH) {
      respond(false, {
        error: `abort reason too long max=${BNCR_INBOUND_ABORT_REASON_MAX_LENGTH}`,
      });
      return;
    }

    const authorized = authorizeInboundTransfer({
      runtime,
      accountId,
      transferId,
      connId,
      clientId,
      event: 'file.abort',
    });
    if (!authorized.ok) {
      respond(false, { error: authorized.error });
      return;
    }
    const st = authorized.state;
    const staleObserved = runtime.observeLease('file.abort', params ?? {});
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
          await discardInboundStagingFile(current.stagingPath);
        } catch (cleanupError) {
          runtime.logWarn(
            'file',
            `aborted transfer staging cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
        const abortedState = markInboundTransferAborted(current, reason, runtime.now());
        runtime.fileRecvTransfers.set(authorized.key, abortedState);
        respond(
          true,
          staleObserved.stale
            ? {
                ok: true,
                transferId,
                status: 'aborted',
                stale: true,
                staleAccepted: true,
              }
            : {
                ok: true,
                transferId,
                status: 'aborted',
              },
        );
      });
    } finally {
      endInboundTransferOperation(st);
    }
  };
}
