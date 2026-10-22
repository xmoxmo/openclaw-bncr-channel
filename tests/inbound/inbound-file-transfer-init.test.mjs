import assert from 'node:assert/strict';
import test from 'node:test';

import { fallbackBncrMediaMaxBytes } from '../../src/openclaw/media-limit-runtime.ts';
import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

test('handleFileInit rejects oversized and inconsistent transfer declarations without creating state', async () => {
  const bridge = createBridge();
  const validSessionKey = `agent:orion:bncr:direct:${Buffer.from('tgBot:0:10001').toString('hex')}`;

  try {
    const invalidCases = [
      {
        name: 'above configured 2 GiB limit',
        transferId: 'recv-init-above-config-limit',
        fileSize: fallbackBncrMediaMaxBytes() + 1,
        chunkSize: 256 * 1024,
        totalChunks: Math.ceil((fallbackBncrMediaMaxBytes() + 1) / (256 * 1024)),
        error: /fileSize too large/,
      },
      {
        name: 'zero-byte file',
        transferId: 'recv-init-zero-byte',
        fileSize: 0,
        chunkSize: 256 * 1024,
        totalChunks: 0,
        error: /transferId\/sessionKey\/fileSize\/chunkSize\/totalChunks required/,
      },
      {
        name: 'inconsistent totalChunks',
        transferId: 'recv-init-inconsistent',
        fileSize: 5,
        chunkSize: 2,
        totalChunks: 2,
        error: /totalChunks mismatch/,
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

test('handleFileInit accepts declarations above the former 50 MiB and chunk caps', async () => {
  const bridge = createBridge();
  const validSessionKey = `agent:orion:bncr:direct:${Buffer.from('tgBot:0:10001').toString('hex')}`;

  try {
    const cases = [
      {
        transferId: 'recv-init-above-old-byte-cap',
        fileSize: 50 * 1024 * 1024 + 1,
        chunkSize: 256 * 1024,
        totalChunks: 201,
      },
      {
        transferId: 'recv-init-above-old-chunk-cap',
        fileSize: 4097,
        chunkSize: 1,
        totalChunks: 4097,
      },
    ];

    for (const item of cases) {
      let respondPayload = null;
      await bridge.handleFileInit({
        params: {
          accountId: 'Primary',
          clientId: 'client-a',
          sessionKey: validSessionKey,
          platform: 'tgBot',
          groupId: '0',
          userId: '10001',
          fileName: `${item.transferId}.bin`,
          mimeType: 'application/octet-stream',
          ...item,
        },
        respond(ok, payload) {
          respondPayload = { ok, payload };
        },
        client: { connId: 'conn-1' },
        context: null,
      });

      assert.equal(respondPayload.ok, true, item.transferId);
      assert.equal(respondPayload.payload.ok, true, item.transferId);
      assert.equal(bridge.fileRecvTransfers.has(item.transferId), true, item.transferId);
    }
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileInit accepts hex-only sessionKey when route fields are present and normalizes to canonical sessionKey', async () => {
  const bridge = createBridge();

  try {
    let respondPayload = null;
    await bridge.handleFileInit({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-init-hex-only',
        sessionKey: Buffer.from('tgBot:-5212885824:0', 'utf8').toString('hex'),
        platform: 'tgBot',
        groupId: '-5212885824',
        userId: '0',
        fileName: 'hex-only.jpg',
        mimeType: 'image/jpeg',
        fileSize: 51109,
        chunkSize: 262144,
        totalChunks: 1,
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, true);
    assert.equal(respondPayload.payload.ok, true);
    const state = bridge.fileRecvTransfers.get('recv-init-hex-only');
    assert.ok(state);
    assert.equal(state.route.platform, 'tgBot');
    assert.equal(state.route.groupId, '-5212885824');
    assert.equal(state.route.userId, '0');
    assert.equal(
      state.sessionKey,
      `agent:main:bncr:group:${Buffer.from('tgBot:-5212885824', 'utf8').toString('hex')}`,
    );
  } finally {
    cleanupBridge(bridge);
  }
});
