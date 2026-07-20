import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBncrMediaOutboundFrame,
  resolveBncrOutboundMessageType,
} from '../../src/messaging/outbound/media.ts';
import {
  isOpenClawRemoteHttpMediaUrl,
  loadOpenClawWebMedia,
} from '../../src/openclaw/media-runtime.ts';
import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

test('loadOpenClawWebMedia prefers channel readRemoteMediaBuffer for remote http media', async () => {
  const calls = [];
  const loaded = await loadOpenClawWebMedia(
    {
      runtime: {
        media: {
          async loadWebMedia() {
            calls.push('loadWebMedia');
            throw new Error('should not use loadWebMedia for remote URL');
          },
        },
        channel: {
          media: {
            async readRemoteMediaBuffer(options) {
              calls.push(['readRemoteMediaBuffer', options]);
              return {
                buffer: Buffer.from('remote'),
                contentType: 'image/png',
                fileName: 'remote.png',
              };
            },
          },
        },
      },
    },
    'https://example.com/remote.png',
    { localRoots: ['/tmp'], maxBytes: 1234 },
  );

  assert.deepEqual(calls, [
    ['readRemoteMediaBuffer', { url: 'https://example.com/remote.png', maxBytes: 1234 }],
  ]);
  assert.equal(loaded.buffer.toString(), 'remote');
  assert.equal(loaded.contentType, 'image/png');
  assert.equal(loaded.fileName, 'remote.png');
});

test('isOpenClawRemoteHttpMediaUrl only treats http and https URLs as remote fetch media', () => {
  assert.equal(isOpenClawRemoteHttpMediaUrl('https://example.com/a.png'), true);
  assert.equal(isOpenClawRemoteHttpMediaUrl(' HTTP://example.com/a.png '), true);
  assert.equal(isOpenClawRemoteHttpMediaUrl('/tmp/a.png'), false);
  assert.equal(isOpenClawRemoteHttpMediaUrl('file:///tmp/a.png'), false);
  assert.equal(isOpenClawRemoteHttpMediaUrl('data:image/png;base64,abc'), false);
  assert.equal(isOpenClawRemoteHttpMediaUrl('media://inbound/demo'), false);
});

test('loadOpenClawWebMedia keeps local media paths on runtime loadWebMedia path', async () => {
  const calls = [];
  const loaded = await loadOpenClawWebMedia(
    {
      runtime: {
        media: {
          async loadWebMedia(mediaUrl, options) {
            calls.push(['loadWebMedia', mediaUrl, options]);
            return { buffer: Buffer.from('local'), contentType: 'audio/ogg' };
          },
        },
        channel: {
          media: {
            async readRemoteMediaBuffer() {
              calls.push('readRemoteMediaBuffer');
              throw new Error('should not use remote reader for local path');
            },
          },
        },
      },
    },
    '/tmp/voice.ogg',
    { localRoots: ['/tmp'], maxBytes: 5678 },
  );

  assert.deepEqual(calls, [
    ['loadWebMedia', '/tmp/voice.ogg', { localRoots: ['/tmp'], maxBytes: 5678 }],
  ]);
  assert.equal(loaded.buffer.toString(), 'local');
  assert.equal(loaded.contentType, 'audio/ogg');
});

test('keeps standard hinted type when supported', () => {
  assert.equal(
    resolveBncrOutboundMessageType({
      hintedType: 'voice',
      mimeType: 'audio/ogg',
      hasPayload: true,
    }),
    'voice',
  );
});

test('voice hinted non-audio is still voice (asVoice highest priority)', () => {
  assert.equal(
    resolveBncrOutboundMessageType({
      hintedType: 'voice',
      mimeType: 'application/pdf',
      hasPayload: true,
    }),
    'voice',
  );
});

test('falls back to audio by mime major type when hinted type is unsupported', () => {
  assert.equal(
    resolveBncrOutboundMessageType({
      hintedType: 'weird',
      mimeType: 'audio/mpeg',
      hasPayload: true,
    }),
    'audio',
  );
});

test('forces text payload attachments to file when mime major type is text', () => {
  assert.equal(
    resolveBncrOutboundMessageType({
      hintedType: 'text',
      mimeType: 'text/javascript',
      hasPayload: true,
    }),
    'file',
  );
});

test('falls back to file for unknown mime major type', () => {
  assert.equal(
    resolveBncrOutboundMessageType({
      hintedType: 'unknown',
      mimeType: 'application/pdf',
      hasPayload: true,
    }),
    'file',
  );
});

test('buildBncrMediaOutboundFrame writes resolved type and path', () => {
  const frame = buildBncrMediaOutboundFrame({
    messageId: 'm1',
    sessionKey: 'agent:main:bncr:direct:abc',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    media: { mode: 'chunk', mimeType: 'audio/mpeg', path: '/tmp/a.mp3' },
    mediaUrl: '',
    mediaMsg: 'hi',
    fileName: 'a.mp3',
    now: 1,
  });

  assert.equal(frame.message.type, 'audio');
  assert.equal(frame.message.path, '/tmp/a.mp3');
  assert.equal(frame.message.fileName, 'a.mp3');
});

test('buildBncrMediaOutboundFrame lets extra type/msg override resolved media fields (appmsg card)', () => {
  const frame = buildBncrMediaOutboundFrame({
    messageId: 'm-appmsg',
    sessionKey: 'agent:main:bncr:group:demo',
    route: { platform: 'GewePlus', groupId: 'g1', userId: '0' },
    media: { mode: 'base64', mimeType: 'image/jpeg' },
    mediaUrl: 'http://thumb.example/cover.jpg',
    mediaMsg: 'caption-should-lose',
    fileName: 'cover.jpg',
    hintedType: 'appmsg',
    extra: {
      type: 'appmsg',
      msg: '<appmsg><title>song</title></appmsg>',
      path: 'http://thumb.example/cover.jpg',
    },
    now: 3,
  });

  assert.equal(frame.message.type, 'appmsg');
  assert.equal(frame.message.msg, '<appmsg><title>song</title></appmsg>');
  assert.equal(frame.message.path, 'http://thumb.example/cover.jpg');
  assert.equal(frame.message.extra, undefined);
});

test('buildBncrMediaOutboundFrame preserves extra metadata as a shallow copy', () => {
  const extra = { parse_mode: 'MarkdownV2', disable_preview: true };
  const frame = buildBncrMediaOutboundFrame({
    messageId: 'm2',
    sessionKey: 'agent:main:bncr:direct:def',
    route: { platform: 'tgBot', groupId: '0', userId: '10002' },
    media: { mode: 'base64', mimeType: 'image/png', mediaBase64: 'Zm9v' },
    mediaUrl: '/tmp/a.png',
    mediaMsg: 'caption',
    fileName: 'a.png',
    extra,
    now: 2,
  });

  assert.deepEqual(frame.message.parse_mode, 'MarkdownV2');
  assert.deepEqual(frame.message.disable_preview, true);
  assert.equal(frame.message.extra, undefined);
});

test('channelSendMedia enqueues file-transfer outbox entry with voice metadata', async () => {
  const bridge = createBridge();
  bridge.canonicalAgentId = 'orion';

  const route = { platform: 'tgBot', groupId: '-1001', userId: '10001' };
  bridge.resolveVerifiedTarget = () => ({
    accountId: 'Primary',
    route,
    sessionKey: 'agent:orion:bncr:direct:demo',
    displayScope: 'Bncr:tgBot:-1001:10001',
  });

  try {
    await bridge.channelSendMedia({
      accountId: 'Primary',
      to: 'Bncr:tgBot:-1001:10001',
      text: 'voice test',
      mediaUrl: '/tmp/voice.ogg',
      asVoice: true,
    });

    assert.equal(bridge.outbox.size, 1);
    const [entry] = bridge.outbox.values();
    assert.equal(entry.accountId, 'Primary');
    assert.equal(entry.route.platform, 'tgBot');
    assert.equal(entry.payload.message?.transferMode, 'media');
    assert.equal(entry.payload.message?.mediaUrl, '/tmp/voice.ogg');
    assert.equal(entry.payload.message?.msg, 'voice test');
    assert.equal(entry.payload.message?.asVoice, true);
    // finalEvent no longer stored in new message format
  } finally {
    cleanupBridge(bridge);
  }
});

test('channelSendMedia stores replyToId on file-transfer metadata', async () => {
  const bridge = createBridge();
  bridge.canonicalAgentId = 'orion';

  bridge.resolveVerifiedTarget = () => ({
    accountId: 'Primary',
    route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
    sessionKey: 'agent:orion:bncr:direct:demo',
    displayScope: 'Bncr:tgBot:-1001:10001',
  });

  try {
    await bridge.channelSendMedia({
      accountId: 'Primary',
      to: 'Bncr:tgBot:-1001:10001',
      text: 'image reply',
      mediaUrl: '/tmp/a.png',
      type: 'image',
      replyToId: 'reply-123',
    });

    const [entry] = bridge.outbox.values();
    assert.equal(entry.payload.replyToId, 'reply-123');
    assert.equal(entry.payload.message?.transferMode, 'media');
    assert.equal(entry.payload.message?.mediaUrl, '/tmp/a.png');
    assert.equal(entry.payload.message?.msg, 'image reply');
    assert.equal(entry.payload.message?.type, 'image');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channelSendMedia strips replyToId for tool file-transfer metadata', async () => {
  const bridge = createBridge();
  bridge.canonicalAgentId = 'orion';

  bridge.resolveVerifiedTarget = () => ({
    accountId: 'Primary',
    route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
    sessionKey: 'agent:orion:bncr:direct:demo',
    displayScope: 'Bncr:tgBot:-1001:10001',
  });

  try {
    await bridge.channelSendMedia({
      accountId: 'Primary',
      to: 'Bncr:tgBot:-1001:10001',
      text: 'tool image reply',
      mediaUrl: '/tmp/tool.png',
      kind: 'tool',
      replyToId: 'reply-tool-123',
    });

    const [entry] = bridge.outbox.values();
    assert.equal(entry.payload.replyToId, undefined);
    assert.equal(entry.payload.message?.kind, 'tool');
    assert.equal(entry.payload.message?.mediaUrl, '/tmp/tool.png');
  } finally {
    cleanupBridge(bridge);
  }
});

test('file-transfer waits until final push is emitted before waiting for message ack', async () => {
  const bridge = createBridge();
  bridge.canonicalAgentId = 'orion';

  const order = [];
  bridge.gatewayContext = {
    broadcastToConnIds(event) {
      order.push(`broadcast:${event}`);
    },
  };
  bridge.resolveOutboxPushOwner = () => ({ connId: 'conn-1', clientId: 'client-1' });
  bridge.resolvePushConnIds = () => new Set(['conn-1']);
  bridge.hasRecentInboundReachability = () => false;
  bridge.isOnline = () => true;
  bridge.transferMediaToBncrClient = async () => {
    order.push('transfer-done');
    return {
      mode: 'chunk',
      mimeType: 'image/png',
      fileName: 'delayed.png',
      path: '/tmp/delayed.png',
    };
  };
  bridge.waitForMessageAck = async () => {
    order.push('wait-message-ack');
    bridge.outbox.delete('file-msg-1');
    return 'acked';
  };

  bridge.outbox.set('file-msg-1', {
    messageId: 'file-msg-1',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
    payload: {
      type: 'message.outbound',
      sessionKey: 'agent:orion:bncr:direct:demo',
      message: {
        type: 'file',
        msg: 'hello',
        mediaUrl: '/tmp/delayed.png',
        transferMode: 'media',
      },
    },
    createdAt: Date.now(),
    retryCount: 0,
    nextAttemptAt: Date.now(),
  });

  try {
    await bridge.flushPushQueue('Primary');

    assert.deepEqual(order, ['transfer-done', 'broadcast:plugin.bncr.push', 'wait-message-ack']);
  } finally {
    cleanupBridge(bridge);
  }
});

test('file-transfer failure does not start message ack wait or rewrite error to push-ack-timeout', async () => {
  const bridge = createBridge();
  bridge.canonicalAgentId = 'orion';

  let waitCalls = 0;
  bridge.gatewayContext = {
    broadcastToConnIds() {},
  };
  bridge.resolveOutboxPushOwner = () => ({ connId: 'conn-1', clientId: 'client-1' });
  bridge.resolvePushConnIds = () => new Set(['conn-1']);
  bridge.hasRecentInboundReachability = () => false;
  bridge.isOnline = () => true;
  bridge.transferMediaToBncrClient = async () => {
    throw new Error('complete ack timeout');
  };
  bridge.waitForMessageAck = async () => {
    waitCalls += 1;
    return 'timeout';
  };

  const entry = {
    messageId: 'file-msg-2',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
    payload: {
      type: 'message.outbound',
      sessionKey: 'agent:orion:bncr:direct:demo',
      message: {
        type: 'file',
        msg: 'hello',
        mediaUrl: '/tmp/fail.png',
        transferMode: 'media',
      },
    },
    createdAt: Date.now(),
    retryCount: 0,
    nextAttemptAt: Date.now(),
  };
  bridge.outbox.set(entry.messageId, entry);

  try {
    await bridge.flushPushQueue('Primary');

    assert.equal(waitCalls, 0);
    const updated = bridge.outbox.get(entry.messageId);
    assert.ok(updated);
    assert.equal(updated.lastError, 'complete ack timeout');
  } finally {
    cleanupBridge(bridge);
  }
});
