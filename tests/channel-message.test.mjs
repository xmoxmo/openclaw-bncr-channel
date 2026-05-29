import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridge } from '../src/channel.ts';

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

const target = 'Bncr:tgBot:-1001:10001';

test('channel.message text sends enqueue bncr outbox entries and return queued handoff receipts', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const result = await bridge.channelMessageSendText({
      accountId: 'Primary',
      to: target,
      text: 'hello through channel.message',
      replyToId: 'source-channel-message-text',
    });

    assert.equal(bridge.outbox.size, 1);
    const [entry] = bridge.outbox.values();
    assert.equal(entry.payload.type, 'message.outbound');
    assert.equal(entry.payload.message.msg, 'hello through channel.message');
    assert.equal(entry.payload.replyToId, 'source-channel-message-text');
    assert.equal(result.results[0].messageId, entry.messageId);
    assert.equal(result.receipt.primaryPlatformMessageId, entry.messageId);
    assert.equal(result.receipt.raw[0].meta.deliveryStage, 'queued');
    assert.equal(result.receipt.raw[0].meta.finalAckManagedBy, 'bncr-outbox');
    assert.equal(result.receipt.raw[0].meta.ackSemantics, 'plugin-accepted-not-client-acked');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channel.message media sends enqueue file-transfer entries and return queued handoff receipts', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const result = await bridge.channelMessageSendMedia({
      accountId: 'Primary',
      to: target,
      text: 'media caption',
      mediaUrl: '/tmp/channel-message.png',
      audioAsVoice: true,
      replyToId: 'source-channel-message-media',
      mediaLocalRoots: ['/tmp'],
    });

    assert.equal(bridge.outbox.size, 1);
    const [entry] = bridge.outbox.values();
    assert.equal(entry.payload.type, 'message.outbound');
    assert.equal(entry.payload._meta.kind, 'file-transfer');
    assert.equal(entry.payload._meta.mediaUrl, '/tmp/channel-message.png');
    assert.equal(entry.payload._meta.text, 'media caption');
    assert.equal(entry.payload._meta.audioAsVoice, true);
    assert.equal(entry.payload._meta.replyToId, 'source-channel-message-media');
    assert.equal(result.results[0].messageId, entry.messageId);
    assert.equal(result.receipt.primaryPlatformMessageId, entry.messageId);
    assert.equal(result.receipt.parts[0].kind, 'voice');
    assert.equal(result.receipt.raw[0].meta.deliveryStage, 'queued');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channel.message payload sends normalize text payloads into bncr outbox handoff', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const result = await bridge.channelMessageSendPayload({
      accountId: 'Primary',
      to: target,
      payload: {
        text: 'payload text',
        replyToId: 'source-channel-message-payload',
      },
    });

    assert.equal(bridge.outbox.size, 1);
    const [entry] = bridge.outbox.values();
    assert.equal(entry.payload.type, 'message.outbound');
    assert.equal(entry.payload.message.msg, 'payload text');
    assert.equal(entry.payload.replyToId, 'source-channel-message-payload');
    assert.equal(result.results[0].messageId, entry.messageId);
    assert.equal(result.receipt.primaryPlatformMessageId, entry.messageId);
    assert.equal(result.receipt.raw[0].meta.deliveryStage, 'queued');
  } finally {
    cleanupBridge(bridge);
  }
});
