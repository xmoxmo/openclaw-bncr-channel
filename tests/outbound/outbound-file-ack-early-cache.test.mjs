import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

test('early cached complete file ack resolves later waiter immediately', async () => {
  const bridge = createBridge();

  try {
    bridge.fileSendTransfers.set('transfer-event-early-complete', {
      transferId: 'transfer-event-early-complete',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      status: 'transferring',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-event-early-complete',
        stage: 'complete',
        ok: true,
        path: '/tmp/early-complete.png',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 1);
    assert.equal(
      bridge.fileSendTransfers.get('transfer-event-early-complete')?.status,
      'completed',
    );
    assert.equal(
      bridge.fileSendTransfers.get('transfer-event-early-complete')?.completedPath,
      '/tmp/early-complete.png',
    );

    bridge.fileSendTransfers.get('transfer-event-early-complete').status = 'transferring';
    bridge.fileSendTransfers.get('transfer-event-early-complete').completedPath = undefined;

    const result = await bridge.waitCompleteAck({
      transferId: 'transfer-event-early-complete',
      timeoutMs: 1_000,
    });
    assert.deepEqual(result, { path: '/tmp/early-complete.png' });
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('early cached failed file ack rejects later waiter immediately', async () => {
  const bridge = createBridge();

  try {
    bridge.fileSendTransfers.set('transfer-event-early-fail', {
      transferId: 'transfer-event-early-fail',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      status: 'transferring',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-event-early-fail',
        stage: 'complete',
        ok: false,
        errorCode: 'EARLY_FAIL',
        errorMessage: 'cached fail ack',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    bridge.fileSendTransfers.get('transfer-event-early-fail').status = 'transferring';
    bridge.fileSendTransfers.get('transfer-event-early-fail').error = undefined;

    assert.equal(bridge.fileAckWaiters.size, 0);
    await assert.rejects(
      bridge.waitCompleteAck({ transferId: 'transfer-event-early-fail', timeoutMs: 1_000 }),
      /cached fail ack/,
    );
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('early file ack cache keeps bounded newest entries', async () => {
  const bridge = createBridge();

  try {
    for (let i = 0; i < 1005; i++) {
      bridge.resolveFileAck({
        transferId: `transfer-early-${i}`,
        stage: 'complete',
        payload: { ok: true, transferId: `transfer-early-${i}` },
        ok: true,
      });
    }

    assert.equal(bridge.earlyFileAcks.size, 1000);
    assert.equal(bridge.earlyFileAcks.has('transfer-early-0|complete|-'), false);
    assert.equal(bridge.earlyFileAcks.has('transfer-early-4|complete|-'), false);
    assert.equal(bridge.earlyFileAcks.has('transfer-early-5|complete|-'), true);
    assert.equal(bridge.earlyFileAcks.has('transfer-early-1004|complete|-'), true);
  } finally {
    cleanupBridge(bridge);
  }
});

test('file ack for unknown transferId does not pollute early ack cache or later waiter', async () => {
  const bridge = createBridge();

  try {
    let respondPayload = null;
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-unknown-before-waiter',
        stage: 'complete',
        ok: true,
        path: '/tmp/unknown-before-waiter.png',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, false);
    assert.match(respondPayload.payload.error, /transferId/i);
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 0);
    assert.equal(bridge.earlyFileAcks.has('transfer-unknown-before-waiter|complete|-'), false);

    await assert.rejects(
      bridge.waitCompleteAck({
        transferId: 'transfer-unknown-before-waiter',
        timeoutMs: 20,
      }),
      /transfer state missing/,
    );
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('file ack with unknown stage does not cache or wake valid stage waiter', async () => {
  const bridge = createBridge();

  try {
    bridge.fileSendTransfers.set('transfer-unknown-stage', {
      transferId: 'transfer-unknown-stage',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      status: 'transferring',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const waiter = bridge.waitCompleteAck({
      transferId: 'transfer-unknown-stage',
      timeoutMs: 1_000,
    });
    assert.equal(bridge.fileAckWaiters.size, 1);

    let respondPayload = null;
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-unknown-stage',
        stage: 'done',
        ok: true,
        path: '/tmp/unknown-stage.png',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, false);
    assert.match(respondPayload.payload.error, /stage/i);
    assert.equal(bridge.fileAckWaiters.size, 1);
    assert.equal(bridge.earlyFileAcks.size, 0);
    assert.equal(bridge.earlyFileAcks.has('transfer-unknown-stage|done|-'), false);

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-unknown-stage',
        stage: 'complete',
        ok: true,
        path: '/tmp/valid-stage.png',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(await waiter, { path: '/tmp/valid-stage.png' });
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});
