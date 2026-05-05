import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridge } from '../src/channel.ts';
import {
  buildBncrMediaOutboundFrame,
  resolveBncrOutboundMessageType,
} from '../src/messaging/outbound/media.ts';

function createApiStub() {
  const currentConfig = {};
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {
      config: {
        current() {
          return currentConfig;
        },
        get() {
          return currentConfig;
        },
        async loadConfig() {
          return currentConfig;
        },
      },
      channel: {
        routing: {
          resolveAgentRoute() {
            return { sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion' };
          },
        },
      },
    },
  };
}

function cleanupBridge(bridge) {
  if (bridge.saveTimer) clearTimeout(bridge.saveTimer);
  if (bridge.pushTimer) clearTimeout(bridge.pushTimer);

  for (const waiter of bridge.messageAckWaiters?.values?.() || []) {
    clearTimeout(waiter.timer);
  }
  bridge.messageAckWaiters?.clear?.();
}


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

test('voice hinted but non-audio falls back to file', () => {
  assert.equal(
    resolveBncrOutboundMessageType({
      hintedType: 'voice',
      mimeType: 'application/pdf',
      hasPayload: true,
    }),
    'file',
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
    route: { platform: 'tgBot', groupId: '0', userId: '6278285192' },
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

test('channelSendMedia enqueues file-transfer outbox entry with voice metadata', async () => {
  const bridge = createBncrBridge(createApiStub());
  bridge.canonicalAgentId = 'orion';

  const route = { platform: 'tgBot', groupId: '-1001', userId: '6278285192' };
  bridge.resolveVerifiedTarget = () => ({
    accountId: 'Primary',
    route,
    sessionKey: 'agent:orion:bncr:direct:demo',
    displayScope: 'Bncr:tgBot:-1001:6278285192',
  });

  try {
    await bridge.channelSendMedia({
      accountId: 'Primary',
      to: 'Bncr:tgBot:-1001:6278285192',
      text: 'voice test',
      mediaUrl: '/tmp/voice.ogg',
      asVoice: true,
    });

    assert.equal(bridge.outbox.size, 1);
    const [entry] = bridge.outbox.values();
    assert.equal(entry.accountId, 'Primary');
    assert.equal(entry.route.platform, 'tgBot');
    assert.equal(entry.payload._meta?.kind, 'file-transfer');
    assert.equal(entry.payload._meta?.mediaUrl, '/tmp/voice.ogg');
    assert.equal(entry.payload._meta?.text, 'voice test');
    assert.equal(entry.payload._meta?.asVoice, true);
    assert.equal(entry.payload._meta?.finalEvent, 'plugin.bncr.push');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channelSendMedia stores replyToId on file-transfer metadata', async () => {
  const bridge = createBncrBridge(createApiStub());
  bridge.canonicalAgentId = 'orion';

  bridge.resolveVerifiedTarget = () => ({
    accountId: 'Primary',
    route: { platform: 'tgBot', groupId: '-1001', userId: '6278285192' },
    sessionKey: 'agent:orion:bncr:direct:demo',
    displayScope: 'Bncr:tgBot:-1001:6278285192',
  });

  try {
    await bridge.channelSendMedia({
      accountId: 'Primary',
      to: 'Bncr:tgBot:-1001:6278285192',
      text: 'image reply',
      mediaUrl: '/tmp/a.png',
      replyToId: 'reply-123',
    });

    const [entry] = bridge.outbox.values();
    assert.equal(entry.payload._meta?.replyToId, 'reply-123');
    assert.equal(entry.payload._meta?.kind, 'file-transfer');
    assert.equal(entry.payload._meta?.mediaUrl, '/tmp/a.png');
    assert.equal(entry.payload._meta?.text, 'image reply');
  } finally {
    cleanupBridge(bridge);
  }
});

test('file-transfer waits until final push is emitted before waiting for message ack', async () => {
  const bridge = createBncrBridge(createApiStub());
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
    route: { platform: 'tgBot', groupId: '-1001', userId: '6278285192' },
    payload: {
      type: 'message.outbound',
      sessionKey: 'agent:orion:bncr:direct:demo',
      _meta: {
        kind: 'file-transfer',
        mediaUrl: '/tmp/delayed.png',
        text: 'hello',
      },
    },
    createdAt: Date.now(),
    retryCount: 0,
    nextAttemptAt: Date.now(),
  });

  try {
    await bridge.flushPushQueue('Primary');

    assert.deepEqual(order, [
      'transfer-done',
      'broadcast:plugin.bncr.push',
      'wait-message-ack',
    ]);
  } finally {
    cleanupBridge(bridge);
  }
});

test('file-transfer failure does not start message ack wait or rewrite error to push-ack-timeout', async () => {
  const bridge = createBncrBridge(createApiStub());
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
    route: { platform: 'tgBot', groupId: '-1001', userId: '6278285192' },
    payload: {
      type: 'message.outbound',
      sessionKey: 'agent:orion:bncr:direct:demo',
      _meta: {
        kind: 'file-transfer',
        mediaUrl: '/tmp/fail.png',
        text: 'hello',
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
