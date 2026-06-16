import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

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

test('handleFileAck adopts stale transfer owner when recent inbound reachability still matches the sender', async () => {
  const bridge = createBridge();
  const now = Date.now();
  const originalObserveLease = bridge.observeLease;

  try {
    bridge.observeLease = (...args) => ({
      ...originalObserveLease.call(bridge, ...args),
      stale: true,
    });
    bridge.lastInboundByAccount.set('Primary', now);
    bridge.lastActivityByAccount.set('Primary', now);
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-new-owner',
      clientId: 'client-a',
      connectedAt: now,
      lastSeenAt: now,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary::client-a');
    bridge.fileSendTransfers.set('transfer-stale-adopt', {
      transferId: 'transfer-stale-adopt',
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
      ownerConnId: 'conn-old-owner',
      ownerClientId: 'client-old',
    });

    let respondPayload = null;
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'transfer-stale-adopt',
        stage: 'chunk',
        chunkIndex: 0,
        ok: true,
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-new-owner' },
      context: null,
    });

    assert.equal(respondPayload.ok, true);
    assert.equal(respondPayload.payload.ok, true);
    assert.equal(respondPayload.payload.stale, true);
    assert.equal(respondPayload.payload.staleAccepted, true);
    const st = bridge.fileSendTransfers.get('transfer-stale-adopt');
    assert.equal(st.ownerConnId, 'conn-new-owner');
    assert.equal(st.ownerClientId, 'client-a');
    assert.equal(st.status, 'transferring');
    assert.equal(st.ackedChunks.has(0), true);
  } finally {
    bridge.observeLease = originalObserveLease;
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
