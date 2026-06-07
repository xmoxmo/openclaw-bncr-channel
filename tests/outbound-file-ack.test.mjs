import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge } from './helpers/bncr-bridge.mjs';

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

test('handleFileAck ignores chunk ack mutation after outbound transfer is completed', async () => {
  const bridge = createBridge();

  try {
    bridge.fileSendTransfers.set('transfer-ack-completed-late-chunk', {
      transferId: 'transfer-ack-completed-late-chunk',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set([0]),
      failedChunks: new Map(),
      status: 'completed',
      completedPath: '/tmp/completed.png',
      terminalAt: Date.now() - 500,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'transfer-ack-completed-late-chunk',
        stage: 'chunk',
        chunkIndex: 0,
        ok: false,
        errorCode: 'LATE_CHUNK_FAIL',
        errorMessage: 'should stay completed',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, true);
    assert.equal(respondPayload.payload.state, 'completed');
    assert.equal(respondPayload.payload.ignored, true);
    assert.equal(respondPayload.payload.terminal, true);
    const st = bridge.fileSendTransfers.get('transfer-ack-completed-late-chunk');
    assert.equal(st.status, 'completed');
    assert.equal(st.completedPath, '/tmp/completed.png');
    assert.equal(st.failedChunks.size, 0);
    assert.equal(st.error, undefined);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileAck ignores complete ok mutation after outbound transfer is aborted', async () => {
  const bridge = createBridge();

  try {
    bridge.fileSendTransfers.set('transfer-ack-aborted-late-complete', {
      transferId: 'transfer-ack-aborted-late-complete',
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
      failedChunks: new Map([[0, 'CHUNK_FAILED:original']]),
      status: 'aborted',
      error: 'CHUNK_FAILED:original',
      terminalAt: Date.now() - 500,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'transfer-ack-aborted-late-complete',
        stage: 'complete',
        ok: true,
        path: '/tmp/late-complete.png',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, true);
    assert.equal(respondPayload.payload.state, 'aborted');
    assert.equal(respondPayload.payload.ignored, true);
    assert.equal(respondPayload.payload.terminal, true);
    const st = bridge.fileSendTransfers.get('transfer-ack-aborted-late-complete');
    assert.equal(st.status, 'aborted');
    assert.equal(st.completedPath, undefined);
    assert.equal(st.error, 'CHUNK_FAILED:original');
    assert.equal(st.failedChunks.get(0), 'CHUNK_FAILED:original');
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileAck reports stale terminal completed ack as ignored without staleAccepted', async () => {
  const bridge = createBridge();
  const originalObserveLease = bridge.observeLease;

  try {
    bridge.observeLease = (...args) => ({
      ...originalObserveLease.call(bridge, ...args),
      stale: true,
    });
    bridge.fileSendTransfers.set('transfer-ack-stale-terminal-completed', {
      transferId: 'transfer-ack-stale-terminal-completed',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set([0]),
      failedChunks: new Map(),
      status: 'completed',
      completedPath: '/tmp/completed.png',
      terminalAt: Date.now() - 500,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
      ownerConnId: 'conn-owner',
      ownerClientId: 'owner',
    });

    let respondPayload = null;
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        clientId: 'other',
        transferId: 'transfer-ack-stale-terminal-completed',
        stage: 'chunk',
        chunkIndex: 0,
        ok: false,
        errorCode: 'STALE_LATE_CHUNK',
        errorMessage: 'should stay terminal ignored',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-other' },
      context: null,
    });

    assert.equal(respondPayload.ok, true);
    assert.equal(respondPayload.payload.state, 'completed');
    assert.equal(respondPayload.payload.stale, true);
    assert.equal(respondPayload.payload.ignored, true);
    assert.equal(respondPayload.payload.terminal, true);
    assert.equal('staleAccepted' in respondPayload.payload, false);
    const st = bridge.fileSendTransfers.get('transfer-ack-stale-terminal-completed');
    assert.equal(st.status, 'completed');
    assert.equal(st.completedPath, '/tmp/completed.png');
    assert.equal(st.ownerConnId, 'conn-owner');
    assert.equal(st.ownerClientId, 'owner');
    assert.equal(st.failedChunks.size, 0);
    assert.equal(st.error, undefined);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    bridge.observeLease = originalObserveLease;
    cleanupBridge(bridge);
  }
});

test('handleFileAck reports stale terminal aborted ack as ignored without staleAccepted', async () => {
  const bridge = createBridge();
  const originalObserveLease = bridge.observeLease;

  try {
    bridge.observeLease = (...args) => ({
      ...originalObserveLease.call(bridge, ...args),
      stale: true,
    });
    bridge.fileSendTransfers.set('transfer-ack-stale-terminal-aborted', {
      transferId: 'transfer-ack-stale-terminal-aborted',
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
      failedChunks: new Map([[0, 'CHUNK_FAILED:original']]),
      status: 'aborted',
      error: 'CHUNK_FAILED:original',
      terminalAt: Date.now() - 500,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
      ownerConnId: 'conn-owner',
      ownerClientId: 'owner',
    });

    let respondPayload = null;
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        clientId: 'other',
        transferId: 'transfer-ack-stale-terminal-aborted',
        stage: 'complete',
        ok: true,
        path: '/tmp/stale-late-complete.png',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-other' },
      context: null,
    });

    assert.equal(respondPayload.ok, true);
    assert.equal(respondPayload.payload.state, 'aborted');
    assert.equal(respondPayload.payload.stale, true);
    assert.equal(respondPayload.payload.ignored, true);
    assert.equal(respondPayload.payload.terminal, true);
    assert.equal('staleAccepted' in respondPayload.payload, false);
    const st = bridge.fileSendTransfers.get('transfer-ack-stale-terminal-aborted');
    assert.equal(st.status, 'aborted');
    assert.equal(st.completedPath, undefined);
    assert.equal(st.error, 'CHUNK_FAILED:original');
    assert.equal(st.failedChunks.get(0), 'CHUNK_FAILED:original');
    assert.equal(st.ownerConnId, 'conn-owner');
    assert.equal(st.ownerClientId, 'owner');
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    bridge.observeLease = originalObserveLease;
    cleanupBridge(bridge);
  }
});

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

test('shutdown rejects file ack waiters and clears cached early file ack state', async () => {
  const bridge = createBridge();

  try {
    bridge.fileSendTransfers.set('transfer-event-shutdown', {
      transferId: 'transfer-event-shutdown',
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
      transferId: 'transfer-event-shutdown',
      timeoutMs: 1_000,
    });
    bridge.earlyFileAcks.set('transfer-event-shutdown|complete|-', {
      payload: {
        ok: false,
        transferId: 'transfer-event-shutdown',
        stage: 'complete',
        errorMessage: 'cached before shutdown',
      },
      ok: false,
      at: Date.now(),
    });

    assert.equal(bridge.fileAckWaiters.size, 1);
    assert.equal(bridge.earlyFileAcks.size, 1);

    bridge.shutdown();

    await assert.rejects(waiter, /shutdown/);
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('stopService rejects file ack waiters and clears cached early file ack state', async () => {
  const bridge = createBridge();

  try {
    bridge.fileSendTransfers.set('transfer-event-stop-service', {
      transferId: 'transfer-event-stop-service',
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
      transferId: 'transfer-event-stop-service',
      timeoutMs: 1_000,
    });
    bridge.earlyFileAcks.set('transfer-event-stop-service|complete|-', {
      payload: {
        ok: false,
        transferId: 'transfer-event-stop-service',
        stage: 'complete',
        errorMessage: 'cached before stop',
      },
      ok: false,
      at: Date.now(),
    });

    assert.equal(bridge.fileAckWaiters.size, 1);
    assert.equal(bridge.earlyFileAcks.size, 1);

    await bridge.stopService();

    await assert.rejects(waiter, /service stopped/);
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});
