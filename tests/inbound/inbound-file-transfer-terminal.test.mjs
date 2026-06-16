import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

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

test('terminal aborted inbound transfer ignores later chunk complete and abort without rewriting state', async () => {
  const bridge = createBridge();

  try {
    bridge.fileRecvTransfers.set('recv-aborted-terminal', {
      transferId: 'recv-aborted-terminal',
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
      status: 'aborted',
      error: 'already aborted',
      bufferByChunk: new Map([[0, Buffer.from('hello')]]),
      receivedChunks: new Set([0]),
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let chunkPayload = null;
    await bridge.handleFileChunk({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-aborted-terminal',
        chunkIndex: 0,
        offset: 0,
        size: 4,
        base64: Buffer.from('oops').toString('base64'),
      },
      respond(ok, payload) {
        chunkPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(chunkPayload.ok, true);
    assert.equal(chunkPayload.payload.status, 'aborted');
    assert.equal(chunkPayload.payload.error, 'already aborted');
    assert.equal(chunkPayload.payload.ignored, true);
    assert.equal(chunkPayload.payload.terminal, true);

    let completePayload = null;
    await bridge.handleFileComplete({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-aborted-terminal',
      },
      respond(ok, payload) {
        completePayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(completePayload.ok, true);
    assert.equal(completePayload.payload.status, 'aborted');
    assert.equal(completePayload.payload.error, 'already aborted');
    assert.equal(completePayload.payload.ignored, true);
    assert.equal(completePayload.payload.terminal, true);

    let abortPayload = null;
    await bridge.handleFileAbort({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-aborted-terminal',
        reason: 'should not override',
      },
      respond(ok, payload) {
        abortPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(abortPayload.ok, true);
    assert.equal(abortPayload.payload.status, 'aborted');
    assert.equal(abortPayload.payload.error, 'already aborted');
    assert.equal(abortPayload.payload.ignored, true);
    assert.equal(abortPayload.payload.terminal, true);

    const st = bridge.fileRecvTransfers.get('recv-aborted-terminal');
    assert.equal(st.status, 'aborted');
    assert.equal(st.error, 'already aborted');
    assert.equal(st.bufferByChunk.get(0).toString(), 'hello');
    assert.equal(st.receivedChunks.size, 1);
  } finally {
    cleanupBridge(bridge);
  }
});
