import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge } from './helpers/bncr-bridge.mjs';

test('handleFileInit rejects oversized and inconsistent transfer declarations without creating state', async () => {
  const bridge = createBridge();
  const validSessionKey = `agent:orion:bncr:direct:${Buffer.from('tgBot:0:10001').toString('hex')}`;

  try {
    const invalidCases = [
      {
        name: 'oversized fileSize',
        transferId: 'recv-init-oversized',
        fileSize: 50 * 1024 * 1024 + 1,
        chunkSize: 256 * 1024,
        totalChunks: 201,
        error: /fileSize too large/,
      },
      {
        name: 'inconsistent totalChunks',
        transferId: 'recv-init-inconsistent',
        fileSize: 5,
        chunkSize: 2,
        totalChunks: 2,
        error: /totalChunks mismatch/,
      },
      {
        name: 'excessive totalChunks',
        transferId: 'recv-init-too-many-chunks',
        fileSize: 4097,
        chunkSize: 1,
        totalChunks: 4097,
        error: /totalChunks too large/,
      },
    ];

    for (const item of invalidCases) {
      let respondPayload = null;
      await bridge.handleFileInit({
        params: {
          accountId: 'Primary',
          clientId: 'client-a',
          transferId: item.transferId,
          sessionKey: validSessionKey,
          platform: 'tgBot',
          groupId: '0',
          userId: '10001',
          fileName: `${item.name}.txt`,
          mimeType: 'text/plain',
          fileSize: item.fileSize,
          chunkSize: item.chunkSize,
          totalChunks: item.totalChunks,
        },
        respond(ok, payload) {
          respondPayload = { ok, payload };
        },
        client: { connId: 'conn-1' },
        context: null,
      });

      assert.equal(respondPayload.ok, false, item.name);
      assert.match(respondPayload.payload.error, item.error, item.name);
      assert.equal(bridge.fileRecvTransfers.has(item.transferId), false, item.name);
    }
  } finally {
    cleanupBridge(bridge);
  }
});

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

test('handleFileComplete aborts inbound transfer when chunks are missing', async () => {
  const bridge = createBridge();

  try {
    bridge.fileRecvTransfers.set('recv-complete-missing-chunk', {
      transferId: 'recv-complete-missing-chunk',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'missing-chunk.txt',
      mimeType: 'text/plain',
      fileSize: 10,
      chunkSize: 5,
      totalChunks: 2,
      fileSha256: '',
      startedAt: Date.now() - 1_000,
      status: 'transferring',
      bufferByChunk: new Map([[0, Buffer.from('hello')]]),
      receivedChunks: new Set([0]),
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileComplete({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-complete-missing-chunk',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, false);
    assert.match(respondPayload.payload.error, /chunk not complete received=1 total=2/);
    const st = bridge.fileRecvTransfers.get('recv-complete-missing-chunk');
    assert.equal(st.status, 'aborted');
    assert.match(st.error, /chunk not complete received=1 total=2/);
    assert.equal(typeof st.terminalAt, 'number');
    assert.equal(st.completedPath, undefined);
    assert.equal(st.receivedChunks.size, 1);
    assert.equal(st.bufferByChunk.get(0).toString(), 'hello');
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileComplete aborts inbound transfer on sha256 mismatch', async () => {
  const bridge = createBridge();

  try {
    bridge.fileRecvTransfers.set('recv-complete-sha-mismatch', {
      transferId: 'recv-complete-sha-mismatch',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'sha-mismatch.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
      fileSha256: '0000000000000000000000000000000000000000000000000000000000000000',
      startedAt: Date.now() - 1_000,
      status: 'transferring',
      bufferByChunk: new Map([[0, Buffer.from('hello')]]),
      receivedChunks: new Set([0]),
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileComplete({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-complete-sha-mismatch',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, false);
    assert.match(respondPayload.payload.error, /file sha256 mismatch/);
    const st = bridge.fileRecvTransfers.get('recv-complete-sha-mismatch');
    assert.equal(st.status, 'aborted');
    assert.equal(st.error, 'file sha256 mismatch');
    assert.equal(typeof st.terminalAt, 'number');
    assert.equal(st.completedPath, undefined);
    assert.equal(st.receivedChunks.size, 1);
    assert.equal(st.bufferByChunk.get(0).toString(), 'hello');
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

test('handleFileAbort ignores abort after inbound transfer is completed', async () => {
  const bridge = createBridge();

  try {
    bridge.fileRecvTransfers.set('recv-completed-late-abort', {
      transferId: 'recv-completed-late-abort',
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
    await bridge.handleFileAbort({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-completed-late-abort',
        reason: 'late abort should not override completed',
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
    const st = bridge.fileRecvTransfers.get('recv-completed-late-abort');
    assert.equal(st.status, 'completed');
    assert.equal(st.completedPath, '/tmp/completed-demo.txt');
    assert.equal(st.error, undefined);
  } finally {
    cleanupBridge(bridge);
  }
});
