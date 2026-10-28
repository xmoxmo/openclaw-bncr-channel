import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrMediaOrchestratorsRuntimeGroup } from '../../src/plugin/media-orchestrators-runtime-group.ts';

function createRuntime() {
  const calls = { enqueueOutbound: [], rememberRecentMediaSend: [] };
  const runtime = {
    now: () => 10_000,
    asString: (value, fallback = '') =>
      typeof value === 'string' ? value : value == null ? fallback : String(value),
    fileSendTransfers: new Map(),
    getGatewayContext: () => null,
    fileInitEvent: 'file.init',
    fileAbortEvent: 'file.abort',
    async prepareOutboundTransfer() {
      return { mode: 'base64', mimeType: 'image/png', fileName: 'a.png', base64: 'Zm9v' };
    },
    sendChunk() {},
    sendComplete() {},
    async waitForFileAck() {
      return { path: '/tmp/a.png' };
    },
    logFileTransferChunkAck() {},
    logFileTransferChunkAckFail() {},
    logFileTransferCompleteAck() {},
    logInfo() {},
    logEnqueueFromReply() {},
    enqueueOutbound(entry) {
      calls.enqueueOutbound.push(entry);
    },
    buildOutboxEntry(args) {
      const isMedia = args.transferMode === 'media';
      const message = isMedia
        ? { mediaUrl: args.mediaUrl, msg: args.msg, transferMode: 'media' }
        : { msg: args.msg };
      // Mirror production buildOutboxEntry: extra fields are spread after msg,
      // so extra.msg overrides the body.
      if (args.extra) Object.assign(message, args.extra);
      const entry = {
        messageId: isMedia
          ? `file-${calls.enqueueOutbound.length + 1}`
          : `text-${calls.enqueueOutbound.length + 1}`,
        retryCount: 0,
        nextAttemptAt: 1,
        createdAt: 1,
        payload: { message },
        ...args,
      };
      return entry;
    },
    rememberRecentMediaSend(args) {
      calls.rememberRecentMediaSend.push(args);
    },
    tryBuildMediaDedupeFallback() {
      return null;
    },
  };
  return { runtime, calls };
}

test('media orchestrators runtime group exposes base64 transfer and reply enqueue helpers', async () => {
  const { runtime, calls } = createRuntime();
  const group = createBncrMediaOrchestratorsRuntimeGroup(runtime);

  const result = await group.fileTransferOrchestrator.transferMediaToBncrClient({
    accountId: 'Primary',
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    mediaUrl: '/tmp/a.png',
  });
  await group.replyMediaOrchestrator.enqueueFromReply({
    accountId: 'Primary',
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: 'hello', mediaUrl: '/tmp/a.png', replyToId: 'mid-1' },
  });

  assert.deepEqual(result, {
    mode: 'base64',
    mimeType: 'image/png',
    fileName: 'a.png',
    base64: 'Zm9v',
  });
  assert.equal(calls.enqueueOutbound.length, 1);
  assert.equal(calls.rememberRecentMediaSend.length, 1);
});

test('reply media orchestrator forwards extra metadata into file-transfer entry without retaining caller object', async () => {
  const { runtime, calls } = createRuntime();
  const group = createBncrMediaOrchestratorsRuntimeGroup(runtime);
  const extra = { parse_mode: 'MarkdownV2', protect_content: true };

  await group.replyMediaOrchestrator.enqueueFromReply({
    accountId: 'Primary',
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: 'hello', mediaUrl: '/tmp/a.png', extra },
  });

  const [entry] = calls.enqueueOutbound;
  assert.deepEqual(entry.extra, extra);
  assert.notEqual(entry.extra, extra);

  extra.parse_mode = 'HTML';
  assert.equal(entry.extra.parse_mode, 'MarkdownV2');
});

test('reply media orchestrator suppresses NO_REPLY FROM AGENT text without enqueuing', async () => {
  const { runtime, calls } = createRuntime();
  const group = createBncrMediaOrchestratorsRuntimeGroup(runtime);

  await group.replyMediaOrchestrator.enqueueFromReply({
    accountId: 'Primary',
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: 'NO_REPLY FROM AGENT' },
  });

  assert.equal(calls.enqueueOutbound.length, 0);
});

test('reply media orchestrator suppresses middle standalone NO_REPLY FROM AGENT line', async () => {
  const { runtime, calls } = createRuntime();
  const group = createBncrMediaOrchestratorsRuntimeGroup(runtime);

  await group.replyMediaOrchestrator.enqueueFromReply({
    accountId: 'Primary',
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: '好的\nNO_REPLY FROM AGENT\n再见' },
  });

  assert.equal(calls.enqueueOutbound.length, 0);
});

test('reply media orchestrator sends media but strips a NO_REPLY FROM AGENT caption', async () => {
  const { runtime, calls } = createRuntime();
  const group = createBncrMediaOrchestratorsRuntimeGroup(runtime);

  await group.replyMediaOrchestrator.enqueueFromReply({
    accountId: 'Primary',
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: 'NO_REPLY FROM AGENT', mediaUrl: '/tmp/a.png' },
  });

  assert.equal(calls.enqueueOutbound.length, 1);
  assert.equal(calls.enqueueOutbound[0].payload.message.msg, '');
  assert.equal(calls.enqueueOutbound[0].payload.message.mediaUrl, '/tmp/a.png');
});

test('reply media orchestrator keeps a normal caption on media sends', async () => {
  const { runtime, calls } = createRuntime();
  const group = createBncrMediaOrchestratorsRuntimeGroup(runtime);

  await group.replyMediaOrchestrator.enqueueFromReply({
    accountId: 'Primary',
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: '看这张图', mediaUrl: '/tmp/a.png' },
  });

  assert.equal(calls.enqueueOutbound.length, 1);
  assert.equal(calls.enqueueOutbound[0].payload.message.msg, '看这张图');
});

test('reply media orchestrator suppresses NO_REPLY FROM AGENT regardless of reply mode', async () => {
  const { runtime, calls } = createRuntime();
  const group = createBncrMediaOrchestratorsRuntimeGroup(runtime);

  await group.replyMediaOrchestrator.enqueueFromReply({
    accountId: 'Primary',
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: 'NO_REPLY FROM AGENT' },
  });

  assert.equal(calls.enqueueOutbound.length, 0);
});

test('reply media orchestrator keeps a real body even when extra.msg is the marker', async () => {
  const { runtime, calls } = createRuntime();
  const group = createBncrMediaOrchestratorsRuntimeGroup(runtime);

  await group.replyMediaOrchestrator.enqueueFromReply({
    accountId: 'Primary',
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: '真实内容', extra: { msg: 'NO_REPLY FROM AGENT' } },
  });

  assert.equal(calls.enqueueOutbound.length, 1);
  assert.equal(calls.enqueueOutbound[0].payload.message.msg, '真实内容');
});

test('reply media orchestrator keeps a real extra.msg body when the text is the marker', async () => {
  const { runtime, calls } = createRuntime();
  const group = createBncrMediaOrchestratorsRuntimeGroup(runtime);

  await group.replyMediaOrchestrator.enqueueFromReply({
    accountId: 'Primary',
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: 'NO_REPLY FROM AGENT', extra: { msg: '真实内容' } },
  });

  assert.equal(calls.enqueueOutbound.length, 1);
  assert.equal(calls.enqueueOutbound[0].payload.message.msg, '真实内容');
});

test('reply media orchestrator drops an empty body whose extra.msg is the marker', async () => {
  const { runtime, calls } = createRuntime();
  const group = createBncrMediaOrchestratorsRuntimeGroup(runtime);

  await group.replyMediaOrchestrator.enqueueFromReply({
    accountId: 'Primary',
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: '', extra: { msg: 'NO_REPLY FROM AGENT' } },
  });

  assert.equal(calls.enqueueOutbound.length, 0);
});
