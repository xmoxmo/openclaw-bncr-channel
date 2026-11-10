import { createHash } from 'node:crypto';
import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import { canonicalizeBase64, estimateBase64DecodedBytes } from '../core/base64.ts';
import { getErrorMessage } from './error-message.ts';
import { authorizeInboundTransfer } from './file-inbound-auth.ts';
import type { BncrFileInboundRuntime } from './file-inbound-runtime.ts';
import {
  BNCR_INBOUND_CHUNK_SIZE_LIMIT,
  BNCR_INBOUND_TRANSFER_ID_MAX_LENGTH,
  endInboundTransferOperation,
  isAbortedInboundTransfer,
  isActiveInboundTransfer,
  isCompletedInboundTransfer,
  isValidInboundSha256,
  markInboundTransferTransferring,
  tryBeginInboundTransferOperation,
  withInboundTransferLock,
} from './file-inbound-state.ts';
import { writeInboundChunkAtOffset } from './file-inbound-storage.ts';
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
    const size = runtime.finiteNonNegativeNumberOrNull(params?.size);
    const chunkSha256 = runtime
      .asString(params?.chunkSha256 || '')
      .trim()
      .toLowerCase();
    const base64 = runtime.asString(params?.base64 || '');

    if (!transferId || chunkIndex == null || !base64) {
      respond(false, { error: 'transferId/chunkIndex/base64 required' });
      return;
    }

    if (transferId.length > BNCR_INBOUND_TRANSFER_ID_MAX_LENGTH) {
      respond(false, { error: `transferId too long max=${BNCR_INBOUND_TRANSFER_ID_MAX_LENGTH}` });
      return;
    }
    if (!isValidInboundSha256(chunkSha256)) {
      respond(false, { error: 'chunkSha256 must be 64 hexadecimal characters when provided' });
      return;
    }

    if (!Number.isSafeInteger(chunkIndex) || !Number.isSafeInteger(offset)) {
      respond(false, { error: 'chunkIndex/offset must be safe integers' });
      return;
    }

    const authorized = authorizeInboundTransfer({
      runtime,
      accountId,
      transferId,
      connId,
      clientId,
      event: 'file.chunk',
    });
    if (!authorized.ok) {
      respond(false, { error: authorized.error });
      return;
    }
    const st = authorized.state;
    const staleObserved = runtime.observeLease('file.chunk', params ?? {});
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
        try {
          const current = runtime.fileRecvTransfers.get(authorized.key);
          if (!current || !Object.is(current, st)) throw new Error('transfer not found');
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
            throw new Error('transfer not active');
          }
          if (chunkIndex >= current.totalChunks) {
            throw new Error(
              `chunkIndex out of range index=${chunkIndex} total=${current.totalChunks}`,
            );
          }
          const expectedOffset = chunkIndex * current.chunkSize;
          if (offset !== expectedOffset) {
            throw new Error(`chunk offset mismatch expected=${expectedOffset} got=${offset}`);
          }
          const expectedSize =
            chunkIndex === current.totalChunks - 1
              ? current.fileSize - current.chunkSize * (current.totalChunks - 1)
              : current.chunkSize;
          if (size != null && size !== expectedSize) {
            throw new Error(`chunk size mismatch expected=${expectedSize} got=${size}`);
          }
          if (expectedSize <= 0 || expectedSize > BNCR_INBOUND_CHUNK_SIZE_LIMIT) {
            throw new Error(`invalid server chunk size expected=${expectedSize}`);
          }
          const maxEncodedLength = 4 * Math.ceil(expectedSize / 3) + 4096;
          if (base64.length > maxEncodedLength) {
            throw new Error(
              `chunk base64 too large encoded=${base64.length} max=${maxEncodedLength}`,
            );
          }
          const estimated = estimateBase64DecodedBytes(base64);
          if (estimated > expectedSize) {
            throw new Error(`chunk base64 too large estimated=${estimated} max=${expectedSize}`);
          }
          const canonical = canonicalizeBase64(base64);
          if (!canonical) throw new Error('chunk base64 is invalid');
          const buf = Buffer.from(canonical, 'base64');
          if (buf.length !== expectedSize) {
            throw new Error(`chunk size mismatch expected=${expectedSize} got=${buf.length}`);
          }
          const digest = createHash('sha256').update(buf).digest('hex');
          if (chunkSha256 && digest !== chunkSha256) throw new Error('chunk sha256 mismatch');
          const existingDigest = current.receivedChunkDigests.get(chunkIndex);
          if (existingDigest) {
            if (existingDigest !== digest) {
              throw new Error(`chunk ${chunkIndex} already received with different content`);
            }
          } else {
            if (!current.stagingPath) throw new Error('transfer staging file is unavailable');
            await writeInboundChunkAtOffset({
              stagingPath: current.stagingPath,
              offset,
              buffer: buf,
            });
            current.receivedChunkDigests.set(chunkIndex, digest);
            current.receivedChunks.add(chunkIndex);
            current.receivedBytes += buf.length;
            current.lastChunkAt = runtime.now();
            markInboundTransferTransferring(current);
          }

          respond(true, {
            ok: true,
            transferId,
            chunkIndex,
            offset,
            received: current.receivedChunks.size,
            totalChunks: current.totalChunks,
            duplicated: Boolean(existingDigest),
            ...(staleObserved.stale ? { stale: true, staleAccepted: true } : {}),
          });
        } catch (error) {
          respond(false, { error: getErrorMessage(error, 'chunk invalid') });
        }
      });
    } finally {
      endInboundTransferOperation(st);
    }
  };
}
