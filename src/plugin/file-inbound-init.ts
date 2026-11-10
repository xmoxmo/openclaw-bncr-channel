import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { BncrFileInboundRuntime } from './file-inbound-runtime.ts';
import {
  BNCR_INBOUND_ACTIVE_TRANSFERS_GLOBAL,
  BNCR_INBOUND_ACTIVE_TRANSFERS_PER_ACCOUNT,
  BNCR_INBOUND_CHUNK_SIZE_LIMIT,
  BNCR_INBOUND_FILE_NAME_MAX_LENGTH,
  BNCR_INBOUND_MIME_TYPE_MAX_LENGTH,
  BNCR_INBOUND_PENDING_INIT_OPERATIONS,
  BNCR_INBOUND_ROUTE_FIELD_MAX_LENGTH,
  BNCR_INBOUND_SESSION_KEY_MAX_LENGTH,
  BNCR_INBOUND_TOTAL_CHUNKS_LIMIT,
  BNCR_INBOUND_TRANSFER_ID_MAX_LENGTH,
  buildInboundFileTransferKey,
  isActiveInboundTransfer,
  isValidInboundSha256,
} from './file-inbound-state.ts';
import { createInboundStagingFile } from './file-inbound-storage.ts';
import { buildBncrGatewayEventContext } from './gateway-event-context.ts';

let inboundInitTail = Promise.resolve();
let inboundInitPending = 0;

function withInboundFileInitLock<T>(operation: () => Promise<T>): Promise<T> {
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = inboundInitTail.then(operation).finally(release);
  inboundInitTail = current;
  return result;
}

export function createBncrFileInboundInitHandler(runtime: BncrFileInboundRuntime) {
  return async function handleFileInit({
    params,
    respond,
    client,
    context,
  }: GatewayRequestHandlerOptions) {
    if (inboundInitPending >= BNCR_INBOUND_PENDING_INIT_OPERATIONS) {
      respond(false, { error: 'too many queued inbound file init requests' });
      return;
    }
    inboundInitPending += 1;
    try {
      return await withInboundFileInitLock(async () => {
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
        const mimeType =
          runtime.asString(params?.mimeType || '').trim() || 'application/octet-stream';
        const fileSize = runtime.finiteNonNegativeNumberOrNull(params?.fileSize);
        const chunkSize = runtime.finiteNonNegativeNumberOrNull(params?.chunkSize ?? 256 * 1024);
        const totalChunks = runtime.finiteNonNegativeNumberOrNull(params?.totalChunks);
        const fileSha256 = runtime
          .asString(params?.fileSha256 || '')
          .trim()
          .toLowerCase();
        const routeFromParams = runtime.parseRouteLike({
          platform: runtime.asString(params?.platform || '').trim(),
          groupId: runtime.asString(params?.groupId || '0').trim() || '0',
          userId: runtime.asString(params?.userId || '0').trim() || '0',
        });

        const logText = (value: string, max = 256) =>
          value.length > max ? `${value.slice(0, max)}...len=${value.length}` : value;

        const reject = (error: string) => {
          runtime.logWarn(
            'file',
            `file.init reject accountId=${accountId} connId=${connId} clientId=${clientId || '-'} transferId=${logText(transferId) || '-'} error=${error} sessionKey=${logText(sessionKey) || '-'} fileSize=${fileSize ?? 'null'} chunkSize=${chunkSize ?? 'null'} totalChunks=${totalChunks ?? 'null'}`,
          );
          respond(false, { error });
        };

        if (!transferId || !sessionKey || !fileSize || !chunkSize || !totalChunks) {
          reject('transferId/sessionKey/fileSize/chunkSize/totalChunks required');
          return;
        }
        if (transferId.length > BNCR_INBOUND_TRANSFER_ID_MAX_LENGTH) {
          reject(`transferId too long max=${BNCR_INBOUND_TRANSFER_ID_MAX_LENGTH}`);
          return;
        }
        if (sessionKey.length > BNCR_INBOUND_SESSION_KEY_MAX_LENGTH) {
          reject(`sessionKey too long max=${BNCR_INBOUND_SESSION_KEY_MAX_LENGTH}`);
          return;
        }
        if (fileName.length > BNCR_INBOUND_FILE_NAME_MAX_LENGTH) {
          reject(`fileName too long max=${BNCR_INBOUND_FILE_NAME_MAX_LENGTH}`);
          return;
        }
        if (mimeType.length > BNCR_INBOUND_MIME_TYPE_MAX_LENGTH) {
          reject(`mimeType too long max=${BNCR_INBOUND_MIME_TYPE_MAX_LENGTH}`);
          return;
        }
        if (!isValidInboundSha256(fileSha256)) {
          reject('fileSha256 must be 64 hexadecimal characters when provided');
          return;
        }
        if (
          !Number.isSafeInteger(fileSize) ||
          !Number.isSafeInteger(chunkSize) ||
          !Number.isSafeInteger(totalChunks)
        ) {
          reject('fileSize/chunkSize/totalChunks must be safe positive integers');
          return;
        }
        if (chunkSize > BNCR_INBOUND_CHUNK_SIZE_LIMIT) {
          reject(`chunkSize too large size=${chunkSize} max=${BNCR_INBOUND_CHUNK_SIZE_LIMIT}`);
          return;
        }
        if (totalChunks > BNCR_INBOUND_TOTAL_CHUNKS_LIMIT) {
          reject(
            `totalChunks too large total=${totalChunks} max=${BNCR_INBOUND_TOTAL_CHUNKS_LIMIT}`,
          );
          return;
        }
        const maxBytes = runtime.resolveInboundFileTransferMaxBytes(accountId);
        if (fileSize > maxBytes) {
          reject(`fileSize too large size=${fileSize} max=${maxBytes}`);
          return;
        }
        const expectedTotalChunks = Math.ceil(fileSize / chunkSize);
        if (totalChunks !== expectedTotalChunks) {
          reject(`totalChunks mismatch total=${totalChunks} expected=${expectedTotalChunks}`);
          return;
        }

        let normalized = runtime.normalizeStoredSessionKey(sessionKey);
        if (!normalized && routeFromParams) {
          normalized = {
            sessionKey: runtime.buildCanonicalSessionKey(routeFromParams),
            route: routeFromParams,
          };
        }
        if (!normalized) {
          reject('invalid sessionKey');
          return;
        }

        const route =
          runtime.parseRouteLike({
            platform: runtime.asString(params?.platform || normalized.route.platform),
            groupId: runtime.asString(params?.groupId || normalized.route.groupId),
            userId: runtime.asString(params?.userId || normalized.route.userId),
          }) || normalized.route;
        if (
          [route.platform, route.groupId, route.userId].some(
            (value) => value.length > BNCR_INBOUND_ROUTE_FIELD_MAX_LENGTH,
          )
        ) {
          reject(`route field too long max=${BNCR_INBOUND_ROUTE_FIELD_MAX_LENGTH}`);
          return;
        }

        const transferKey = buildInboundFileTransferKey(accountId, transferId);
        const existing = runtime.fileRecvTransfers.get(transferKey);
        if (existing) {
          if (
            existing.accountId !== accountId ||
            !runtime.matchesTransferOwner({
              ownerConnId: existing.ownerConnId,
              ownerClientId: existing.ownerClientId,
              connId,
              clientId,
            })
          ) {
            reject('transfer not found');
            return;
          }
          if (
            existing.sessionKey !== normalized.sessionKey ||
            existing.route.platform !== route.platform ||
            existing.route.groupId !== route.groupId ||
            existing.route.userId !== route.userId ||
            existing.fileName !== fileName ||
            existing.mimeType !== mimeType ||
            existing.fileSize !== fileSize ||
            existing.chunkSize !== chunkSize ||
            existing.totalChunks !== totalChunks ||
            existing.fileSha256 !== fileSha256
          ) {
            reject('transferId already used with different transfer parameters');
            return;
          }
          respond(true, {
            ok: true,
            transferId,
            status: existing.status,
            duplicated: true,
          });
          return;
        }

        let globalActive = 0;
        let accountActive = 0;
        let accountDeclaredBytes = 0;
        for (const state of runtime.fileRecvTransfers.values()) {
          if (!isActiveInboundTransfer(state)) continue;
          globalActive += 1;
          if (state.accountId === accountId) {
            accountActive += 1;
            accountDeclaredBytes += state.fileSize;
          }
        }
        if (accountActive >= BNCR_INBOUND_ACTIVE_TRANSFERS_PER_ACCOUNT) {
          reject(
            `too many active inbound transfers account=${accountId} active=${accountActive} max=${BNCR_INBOUND_ACTIVE_TRANSFERS_PER_ACCOUNT}`,
          );
          return;
        }
        if (globalActive >= BNCR_INBOUND_ACTIVE_TRANSFERS_GLOBAL) {
          reject(
            `too many active inbound transfers active=${globalActive} max=${BNCR_INBOUND_ACTIVE_TRANSFERS_GLOBAL}`,
          );
          return;
        }
        if (accountDeclaredBytes + fileSize > maxBytes) {
          reject(
            `account inbound transfer budget exceeded account=${accountId} declared=${accountDeclaredBytes + fileSize} max=${maxBytes}`,
          );
          return;
        }

        let stagingPath: string;
        try {
          stagingPath = await createInboundStagingFile();
        } catch (error) {
          reject(
            `staging unavailable: ${runtime.asString(error instanceof Error ? error.message : error)}`,
          );
          return;
        }

        runtime.fileRecvTransfers.set(transferKey, {
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
          receivedChunks: new Set(),
          receivedChunkDigests: new Map(),
          receivedBytes: 0,
          lastChunkAt: runtime.now(),
          stagingPath,
          operationTail: Promise.resolve(),
          ownerConnId: connId,
          ownerClientId: clientId,
        });

        respond(true, {
          ok: true,
          transferId,
          status: 'init',
        });
      });
    } finally {
      inboundInitPending = Math.max(0, inboundInitPending - 1);
    }
  };
}
