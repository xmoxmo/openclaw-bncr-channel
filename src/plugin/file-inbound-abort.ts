import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { BncrFileInboundRuntime } from './file-inbound-runtime.ts';
import {
  isAbortedInboundTransfer,
  isCompletedInboundTransfer,
  markInboundTransferAborted,
} from './file-inbound-state.ts';
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

    const st = runtime.fileRecvTransfers.get(transferId);
    if (!st) {
      respond(true, { ok: true, transferId, message: 'not-found' });
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

    const staleObserved = runtime.observeLease('file.abort', params ?? {});
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
          `ignore kind=file.abort accountId=${accountId} connId=${connId} clientId=${clientId || '-'} transferId=${transferId} reason=owner-mismatch ownerConnId=${st.ownerConnId || '-'} ownerClientId=${st.ownerClientId || '-'}`,
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

    const abortedState = markInboundTransferAborted(
      st,
      runtime.asString(params?.reason || 'aborted'),
      runtime.now(),
    );
    runtime.fileRecvTransfers.set(transferId, abortedState);

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
  };
}
