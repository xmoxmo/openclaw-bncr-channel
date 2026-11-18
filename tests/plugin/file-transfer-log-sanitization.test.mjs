import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrFileTransferLogs } from '../../src/plugin/file-transfer-logs.ts';

test('file transfer debug logs summarize media, paths, filenames, and errors', () => {
  const logs = [];
  const transferLogs = createBncrFileTransferLogs({
    bridgeId: 'bridge-1',
    now: () => 1,
    logInfo(scope, message, options) {
      logs.push({ level: 'info', scope, message, options });
    },
    logWarn(scope, message, options) {
      logs.push({ level: 'warn', scope, message, options });
    },
  });

  transferLogs.logFileTransferStart({
    transferId: 'transfer-1',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    mediaUrl: 'https://cdn.example.test/private/video.mp4?token=secret-token',
    fileName: '/private/workspace/video.mp4?sig=secret-sig',
    mimeType: 'video/mp4',
    fileSize: 1024,
    chunkSize: 256,
    totalChunks: 4,
    connIds: ['conn-1'],
  });
  transferLogs.logFileTransferChunkAckFail({
    transferId: 'transfer-1',
    accountId: 'Primary',
    chunkIndex: 0,
    attempt: 1,
    error: new Error('GET https://cdn.example.test/private/video.mp4?token=secret-token failed'),
  });
  transferLogs.logFileTransferCompleteAck({
    transferId: 'transfer-1',
    accountId: 'Primary',
    payload: { path: '/private/workspace/video.mp4?sig=secret-sig' },
  });

  assert.equal(logs.length, 3);
  assert.equal(
    logs.every((item) => item.options?.debugOnly === true),
    true,
  );
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(
    serialized,
    /cdn\.example\.test|private\/workspace|secret-token|secret-sig|\/private\//,
  );
  const startPayload = JSON.parse(logs[0].message.slice(logs[0].message.indexOf(' ') + 1));
  assert.equal(startPayload.mediaUrl.basename, 'video.mp4');
  assert.equal(startPayload.mediaUrl.scheme, 'https');
  assert.equal(startPayload.fileName.basename, 'video.mp4');
  const failurePayload = JSON.parse(logs[1].message.slice(logs[1].message.indexOf(' ') + 1));
  assert.equal('preview' in failurePayload.error, false);
});
