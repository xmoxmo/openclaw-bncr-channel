import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

test('waitChunkAck uses file ack waiter instead of polling transfer state', async () => {
  const bridge = createBridge();

  try {
    bridge.fileSendTransfers.set('transfer-event-chunk', {
      transferId: 'transfer-event-chunk',
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
      status: 'init',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const waiter = bridge.waitChunkAck({
      transferId: 'transfer-event-chunk',
      chunkIndex: 0,
      timeoutMs: 1_000,
    });
    assert.equal(bridge.fileAckWaiters.size, 1);

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-event-chunk',
        stage: 'chunk',
        chunkIndex: 0,
        ok: true,
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    await waiter;
    assert.equal(bridge.fileAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('waitCompleteAck uses file ack waiter instead of polling transfer state', async () => {
  const bridge = createBridge();

  try {
    bridge.fileSendTransfers.set('transfer-event-complete', {
      transferId: 'transfer-event-complete',
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
      transferId: 'transfer-event-complete',
      timeoutMs: 1_000,
    });
    assert.equal(bridge.fileAckWaiters.size, 1);

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-event-complete',
        stage: 'complete',
        ok: true,
        path: '/tmp/demo.png',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(await waiter, { path: '/tmp/demo.png' });
    assert.equal(bridge.fileAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('waitForFileAck falls back to bounded timeout for invalid timeout input', async () => {
  const bridge = createBridge();

  try {
    const waiter = bridge.waitForFileAck({
      transferId: 'transfer-invalid-timeout',
      stage: 'chunk',
      chunkIndex: 0,
      timeoutMs: 'not-a-number',
    });
    const stored = bridge.fileAckWaiters.get('transfer-invalid-timeout|chunk|0');
    assert.ok(stored?.timer);

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-invalid-timeout',
        stage: 'chunk',
        chunkIndex: 0,
        ok: true,
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    await waiter;
    assert.equal(bridge.fileAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('file ack keys treat non-integer chunk indexes as stage-level acks', async () => {
  const bridge = createBridge();

  try {
    const waiter = bridge.waitForFileAck({
      transferId: 'transfer-decimal-chunk',
      stage: 'chunk',
      chunkIndex: 1.5,
      timeoutMs: 1_000,
    });

    assert.equal(bridge.fileAckWaiters.has('transfer-decimal-chunk|chunk|-'), true);
    assert.equal(bridge.fileAckWaiters.has('transfer-decimal-chunk|chunk|1.5'), false);

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-decimal-chunk',
        stage: 'chunk',
        chunkIndex: 1.5,
        ok: true,
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    await waiter;
    assert.equal(bridge.fileAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('waitForFileAck reuses duplicate waiter for the same transfer stage key', async () => {
  const bridge = createBridge();

  try {
    bridge.fileSendTransfers.set('transfer-event-duplicate', {
      transferId: 'transfer-event-duplicate',
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

    const waiter1 = bridge.waitCompleteAck({
      transferId: 'transfer-event-duplicate',
      timeoutMs: 1_000,
    });
    const waiter2 = bridge.waitCompleteAck({
      transferId: 'transfer-event-duplicate',
      timeoutMs: 1_000,
    });

    assert.equal(bridge.fileAckWaiters.size, 1);

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-event-duplicate',
        stage: 'complete',
        ok: true,
        path: '/tmp/demo-duplicate.png',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(await waiter1, { path: '/tmp/demo-duplicate.png' });
    assert.deepEqual(await waiter2, { path: '/tmp/demo-duplicate.png' });
    assert.equal(bridge.fileAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('file ack debug logs include transfer owner context', async () => {
  const logs = [];
  const bridge = createBridge();
  const originalLogInfo = bridge.logInfo.bind(bridge);
  bridge.logInfo = (scope, message, options) => {
    logs.push({ scope, message, options });
    return originalLogInfo(scope, message, options);
  };

  try {
    bridge.fileSendTransfers.set('transfer-owner-logs', {
      transferId: 'transfer-owner-logs',
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
      ownerConnId: 'conn-owner',
      ownerClientId: 'client-owner',
      status: 'transferring',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const waiter = bridge.waitChunkAck({
      transferId: 'transfer-owner-logs',
      chunkIndex: 0,
      timeoutMs: 1_000,
    });
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-owner-logs',
        stage: 'chunk',
        chunkIndex: 0,
        ok: true,
      },
      respond() {},
      client: { connId: 'conn-owner' },
      context: null,
    });

    await waiter;

    const waitLog = logs.find((item) => item.scope === 'file-ack-wait');
    const resolveLog = logs.find((item) => item.scope === 'file-ack-resolve');
    assert.equal(JSON.parse(waitLog.message).ownerConnId, 'conn-owner');
    assert.equal(JSON.parse(waitLog.message).ownerClientId, 'client-owner');
    assert.equal(JSON.parse(resolveLog.message).ownerConnId, 'conn-owner');
    assert.equal(JSON.parse(resolveLog.message).ownerClientId, 'client-owner');
  } finally {
    bridge.logInfo = originalLogInfo;
    cleanupBridge(bridge);
  }
});

test('handleFileAck failure rejects waiter and clears file ack waiter state', async () => {
  const bridge = createBridge();

  try {
    bridge.fileSendTransfers.set('transfer-event-fail', {
      transferId: 'transfer-event-fail',
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

    const waiter = bridge.waitCompleteAck({ transferId: 'transfer-event-fail', timeoutMs: 1_000 });
    assert.equal(bridge.fileAckWaiters.size, 1);

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-event-fail',
        stage: 'complete',
        ok: false,
        errorCode: 'ACK_FAILED',
        errorMessage: 'explicit fail ack',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    await assert.rejects(waiter, /explicit fail ack/);
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.fileSendTransfers.get('transfer-event-fail')?.status, 'aborted');
  } finally {
    cleanupBridge(bridge);
  }
});
