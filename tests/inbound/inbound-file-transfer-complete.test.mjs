import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

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
