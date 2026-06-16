import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

test('handleFileChunk rejects invalid numeric chunk inputs without mutating transfer state', async () => {
  const bridge = createBridge();

  try {
    bridge.fileRecvTransfers.set('recv-invalid-chunk', {
      transferId: 'recv-invalid-chunk',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
      fileSha256: '',
      startedAt: Date.now(),
      status: 'init',
      bufferByChunk: new Map(),
      receivedChunks: new Set(),
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileChunk({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-invalid-chunk',
        chunkIndex: 'not-a-number',
        offset: 0,
        size: 5,
        base64: Buffer.from('hello').toString('base64'),
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, false);
    assert.match(respondPayload.payload.error, /chunkIndex/);
    const st = bridge.fileRecvTransfers.get('recv-invalid-chunk');
    assert.equal(st.receivedChunks.size, 0);
    assert.equal(st.bufferByChunk.size, 0);
    assert.equal(st.status, 'init');
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileChunk rejects out-of-range chunk indexes without mutating transfer state', async () => {
  const bridge = createBridge();

  try {
    bridge.fileRecvTransfers.set('recv-out-of-range-chunk', {
      transferId: 'recv-out-of-range-chunk',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
      fileSha256: '',
      startedAt: Date.now(),
      status: 'init',
      bufferByChunk: new Map(),
      receivedChunks: new Set(),
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileChunk({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-out-of-range-chunk',
        chunkIndex: 1,
        offset: 5,
        size: 5,
        base64: Buffer.from('hello').toString('base64'),
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, false);
    assert.match(respondPayload.payload.error, /chunkIndex out of range/);
    const st = bridge.fileRecvTransfers.get('recv-out-of-range-chunk');
    assert.equal(st.receivedChunks.size, 0);
    assert.equal(st.bufferByChunk.size, 0);
    assert.equal(st.status, 'init');
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileChunk ignores chunks after inbound transfer is completed', async () => {
  const bridge = createBridge();

  try {
    bridge.fileRecvTransfers.set('recv-completed-late-chunk', {
      transferId: 'recv-completed-late-chunk',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
      fileSha256: '',
      startedAt: Date.now() - 1_000,
      terminalAt: Date.now() - 500,
      completedPath: '/tmp/completed-demo.txt',
      status: 'completed',
      bufferByChunk: new Map([[0, Buffer.from('hello')]]),
      receivedChunks: new Set([0]),
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileChunk({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-completed-late-chunk',
        chunkIndex: 0,
        offset: 0,
        size: 4,
        base64: Buffer.from('oops').toString('base64'),
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, true);
    assert.equal(respondPayload.payload.status, 'completed');
    assert.equal(respondPayload.payload.ignored, true);
    assert.equal(respondPayload.payload.terminal, true);
    const st = bridge.fileRecvTransfers.get('recv-completed-late-chunk');
    assert.equal(st.status, 'completed');
    assert.equal(st.completedPath, '/tmp/completed-demo.txt');
    assert.equal(st.bufferByChunk.get(0).toString(), 'hello');
    assert.equal(st.receivedChunks.size, 1);
  } finally {
    cleanupBridge(bridge);
  }
});
