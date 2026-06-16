import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

test('transferMediaToBncrClient chunk mode records init transferring and completed states', async () => {
  const bridge = createBridge();
  const originalLoad = bridge.loadOutboundTransferMedia;
  const broadcasts = [];

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');
    bridge.loadOutboundTransferMedia = async () => ({
      loaded: {
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 7),
        contentType: 'application/octet-stream',
        fileName: 'large.bin',
      },
      size: 5 * 1024 * 1024 + 1,
      mimeType: 'application/octet-stream',
      fileName: 'large.bin',
    });
    bridge.gatewayContext = {
      broadcastToConnIds(event, payload, connIds) {
        broadcasts.push({ event, payload, connIds: Array.from(connIds) });
        if (event === 'plugin.bncr.file.chunk') {
          queueMicrotask(() => {
            bridge.handleFileAck({
              params: {
                accountId: 'Primary',
                clientId: 'client-a',
                transferId: payload.transferId,
                stage: 'chunk',
                chunkIndex: payload.chunkIndex,
                ok: true,
              },
              respond() {},
              client: { connId: 'conn-a' },
              context: bridge.gatewayContext,
            });
          });
        }
        if (event === 'plugin.bncr.file.complete') {
          queueMicrotask(() => {
            bridge.handleFileAck({
              params: {
                accountId: 'Primary',
                clientId: 'client-a',
                transferId: payload.transferId,
                stage: 'complete',
                ok: true,
                path: '/tmp/large.bin',
              },
              respond() {},
              client: { connId: 'conn-a' },
              context: bridge.gatewayContext,
            });
          });
        }
      },
    };

    const result = await bridge.transferMediaToBncrClient({
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      mediaUrl: 'file:///tmp/large.bin',
    });

    const init = broadcasts.find((call) => call.event === 'plugin.bncr.file.init');
    const chunks = broadcasts.filter((call) => call.event === 'plugin.bncr.file.chunk');
    const complete = broadcasts.find((call) => call.event === 'plugin.bncr.file.complete');
    assert.equal(result.mode, 'chunk');
    assert.equal(result.path, '/tmp/large.bin');
    assert.ok(init, 'init event should be broadcast');
    assert.equal(init.payload.totalChunks, 21);
    assert.equal(chunks.length, 21);
    assert.ok(complete, 'complete event should be broadcast');
    assert.equal(complete.payload.transferId, init.payload.transferId);
    assert.deepEqual(init.connIds, ['conn-a']);

    const state = bridge.fileSendTransfers.get(init.payload.transferId);
    assert.ok(state, 'send transfer state should remain for cleanup TTL');
    assert.equal(state.status, 'completed');
    assert.equal(state.completedPath, '/tmp/large.bin');
    assert.equal(state.ackedChunks.size, 21);
    assert.equal(state.failedChunks.size, 0);
    assert.equal(state.ownerConnId, 'conn-a');
    assert.equal(state.ownerClientId, 'client-a');
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    bridge.loadOutboundTransferMedia = originalLoad;
    cleanupBridge(bridge);
  }
});

test('transferMediaToBncrClient aborts chunk mode after retry exhaustion', async () => {
  const bridge = createBridge();
  const originalLoad = bridge.loadOutboundTransferMedia;
  const originalSleep = bridge.sleepMs;
  const broadcasts = [];

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');
    bridge.loadOutboundTransferMedia = async () => ({
      loaded: {
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 9),
        contentType: 'application/octet-stream',
        fileName: 'retry.bin',
      },
      size: 5 * 1024 * 1024 + 1,
      mimeType: 'application/octet-stream',
      fileName: 'retry.bin',
    });
    bridge.sleepMs = async () => {};
    bridge.gatewayContext = {
      broadcastToConnIds(event, payload, connIds) {
        broadcasts.push({ event, payload, connIds: Array.from(connIds) });
        if (event === 'plugin.bncr.file.chunk') {
          queueMicrotask(() => {
            bridge.handleFileAck({
              params: {
                accountId: 'Primary',
                clientId: 'client-a',
                transferId: payload.transferId,
                stage: 'chunk',
                chunkIndex: payload.chunkIndex,
                ok: false,
                errorCode: 'CHUNK_WRITE_FAILED',
                errorMessage: 'cannot write chunk',
              },
              respond() {},
              client: { connId: 'conn-a' },
              context: bridge.gatewayContext,
            });
          });
        }
      },
    };

    await assert.rejects(
      bridge.transferMediaToBncrClient({
        accountId: 'Primary',
        sessionKey: 'agent:orion:bncr:direct:demo',
        route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
        mediaUrl: 'file:///tmp/retry.bin',
      }),
      /CHUNK_WRITE_FAILED:cannot write chunk/,
    );

    const init = broadcasts.find((call) => call.event === 'plugin.bncr.file.init');
    const chunks = broadcasts.filter((call) => call.event === 'plugin.bncr.file.chunk');
    const abort = broadcasts.find((call) => call.event === 'plugin.bncr.file.abort');
    const complete = broadcasts.find((call) => call.event === 'plugin.bncr.file.complete');
    assert.ok(init, 'init event should be broadcast before retries');
    assert.equal(chunks.length, 3, 'first chunk should be retried three times before abort');
    assert.ok(chunks.every((call) => call.payload.transferId === init.payload.transferId));
    assert.ok(chunks.every((call) => call.payload.chunkIndex === 0));
    assert.ok(abort, 'abort event should be broadcast after retry exhaustion');
    assert.equal(abort.payload.transferId, init.payload.transferId);
    assert.match(abort.payload.reason, /CHUNK_WRITE_FAILED:cannot write chunk/);
    assert.equal(complete, undefined);

    const state = bridge.fileSendTransfers.get(init.payload.transferId);
    assert.ok(state, 'aborted send transfer state should remain for cleanup TTL');
    assert.equal(state.status, 'aborted');
    assert.match(state.error, /CHUNK_WRITE_FAILED:cannot write chunk/);
    assert.equal(state.failedChunks.get(0), 'CHUNK_WRITE_FAILED:cannot write chunk');
    assert.equal(state.ackedChunks.size, 0);
    assert.ok(typeof state.terminalAt === 'number');
    assert.equal(state.ownerConnId, 'conn-a');
    assert.equal(state.ownerClientId, 'client-a');
    assert.equal(bridge.fileAckWaiters.size, 0);
  } finally {
    bridge.loadOutboundTransferMedia = originalLoad;
    bridge.sleepMs = originalSleep;
    cleanupBridge(bridge);
  }
});

test('file transfer adopt only allows current outbound owner', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:owner', {
      accountId: 'Primary',
      connId: 'conn-owner',
      clientId: 'owner',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 10_000,
    });
    bridge.connections.set('Primary:other', {
      accountId: 'Primary',
      connId: 'conn-other',
      clientId: 'other',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 500,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: 0,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:owner');
    const transfer = { ownerConnId: undefined, ownerClientId: undefined };
    assert.equal(
      bridge.tryAdoptTransferOwner({
        accountId: 'Primary',
        transfer,
        connId: 'conn-other',
        clientId: 'other',
      }),
      false,
    );
    assert.equal(
      bridge.tryAdoptTransferOwner({
        accountId: 'Primary',
        transfer,
        connId: 'conn-owner',
        clientId: 'owner',
      }),
      false,
    );
  } finally {
    cleanupBridge(bridge);
  }
});
