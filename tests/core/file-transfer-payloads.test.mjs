import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFileTransferAbortPayload,
  buildFileTransferChunkPayload,
  buildFileTransferCompletePayload,
  buildFileTransferInitPayload,
} from '../../src/core/file-transfer-payloads.ts';

test('buildFileTransferInitPayload exposes route and file metadata without hidden time dependency', () => {
  assert.deepEqual(
    buildFileTransferInitPayload({
      transferId: 'transfer-1',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 123,
      chunkSize: 10,
      totalChunks: 13,
      fileSha256: 'abc123',
      ts: 42,
    }),
    {
      transferId: 'transfer-1',
      direction: 'oc2bncr',
      sessionKey: 'agent:orion:bncr:direct:demo',
      platform: 'tgBot',
      groupId: '-1001',
      userId: '10001',
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 123,
      chunkSize: 10,
      totalChunks: 13,
      fileSha256: 'abc123',
      ts: 42,
    },
  );
});

test('buildFileTransferChunkPayload preserves chunk frame fields', () => {
  assert.deepEqual(
    buildFileTransferChunkPayload({
      transferId: 'transfer-1',
      chunkIndex: 2,
      offset: 20,
      size: 10,
      chunkSha256: 'chunk-sha',
      base64: 'aGVsbG8=',
      ts: 43,
    }),
    {
      transferId: 'transfer-1',
      chunkIndex: 2,
      offset: 20,
      size: 10,
      chunkSha256: 'chunk-sha',
      base64: 'aGVsbG8=',
      ts: 43,
    },
  );
});

test('buildFileTransferAbortPayload and complete payload preserve terminal frame fields', () => {
  assert.deepEqual(
    buildFileTransferAbortPayload({ transferId: 'transfer-1', reason: 'chunk failed', ts: 44 }),
    { transferId: 'transfer-1', reason: 'chunk failed', ts: 44 },
  );
  assert.deepEqual(buildFileTransferCompletePayload({ transferId: 'transfer-1', ts: 45 }), {
    transferId: 'transfer-1',
    ts: 45,
  });
});
