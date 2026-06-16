import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { BncrFileInboundRuntime } from './file-inbound-runtime.ts';
import { buildBncrGatewayEventContext } from './gateway-event-context.ts';

export function createBncrFileInboundInitHandler(runtime: BncrFileInboundRuntime) {
  return async function handleFileInit({
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
    if (
      runtime.shouldIgnoreStaleEvent({
        kind: 'file.init',
        payload: params ?? {},
        accountId,
        connId,
        clientId,
      })
    ) {
      respond(true, { ok: true, stale: true, ignored: true });
      return;
    }
    runtime.refreshAcceptedFileTransferLiveState({
      accountId,
      connId,
      clientId,
      context: gatewayContext.context,
    });

    const transferId = runtime.asString(params?.transferId || '').trim();
    const sessionKey = runtime.asString(params?.sessionKey || '').trim();
    const fileName = runtime.asString(params?.fileName || '').trim() || 'file.bin';
    const mimeType = runtime.asString(params?.mimeType || '').trim() || 'application/octet-stream';
    const fileSize = runtime.finiteNonNegativeNumberOrNull(params?.fileSize);
    const chunkSize = runtime.finiteNonNegativeNumberOrNull(params?.chunkSize ?? 256 * 1024);
    const totalChunks = runtime.finiteNonNegativeNumberOrNull(params?.totalChunks);
    const fileSha256 = runtime.asString(params?.fileSha256 || '').trim();

    if (!transferId || !sessionKey || !fileSize || !chunkSize || !totalChunks) {
      respond(false, { error: 'transferId/sessionKey/fileSize/chunkSize/totalChunks required' });
      return;
    }
    if (fileSize > runtime.inboundFileTransferMaxBytes) {
      respond(false, {
        error: `fileSize too large size=${fileSize} max=${runtime.inboundFileTransferMaxBytes}`,
      });
      return;
    }
    if (totalChunks > runtime.inboundFileTransferMaxChunks) {
      respond(false, {
        error: `totalChunks too large total=${totalChunks} max=${runtime.inboundFileTransferMaxChunks}`,
      });
      return;
    }
    const expectedTotalChunks = Math.ceil(fileSize / chunkSize);
    if (totalChunks !== expectedTotalChunks) {
      respond(false, {
        error: `totalChunks mismatch total=${totalChunks} expected=${expectedTotalChunks}`,
      });
      return;
    }

    const normalized = runtime.normalizeStoredSessionKey(sessionKey);
    if (!normalized) {
      respond(false, { error: 'invalid sessionKey' });
      return;
    }

    const existing = runtime.fileRecvTransfers.get(transferId);
    if (existing) {
      respond(true, {
        ok: true,
        transferId,
        status: existing.status,
        duplicated: true,
      });
      return;
    }

    const route =
      runtime.parseRouteLike({
        platform: runtime.asString(params?.platform || normalized.route.platform),
        groupId: runtime.asString(params?.groupId || normalized.route.groupId),
        userId: runtime.asString(params?.userId || normalized.route.userId),
      }) || normalized.route;

    runtime.fileRecvTransfers.set(transferId, {
      transferId,
      accountId,
      sessionKey: normalized.sessionKey,
      route,
      fileName,
      mimeType,
      fileSize,
      chunkSize,
      totalChunks,
      fileSha256,
      startedAt: runtime.now(),
      status: 'init',
      bufferByChunk: new Map(),
      receivedChunks: new Set(),
      ownerConnId: connId,
      ownerClientId: clientId,
    });

    respond(true, {
      ok: true,
      transferId,
      status: 'init',
    });
  };
}
