import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge, makeEntry } from './helpers/bncr-bridge.mjs';

const target = 'Bncr:tgBot:-1001:10001';

test('channel.message text sends enqueue bncr outbox entries and return queued handoff receipts', async () => {
  const bridge = createBridge();
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
  const bridge = createBridge();
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

test('channel.message media sends with mediaUrls return queued handoff receipt for the last new outbox entry', async () => {
  const bridge = createBridge();
  try {
    const existing = makeEntry('existing-channel-message-outbox', 'already queued');
    bridge.outbox.set(existing.messageId, existing);

    const result = await bridge.channelMessageSendMedia({
      accountId: 'Primary',
      to: target,
      text: 'album caption',
      mediaUrls: ['/tmp/channel-message-1.png', '/tmp/channel-message-2.png'],
      replyToId: 'source-channel-message-media-album',
      mediaLocalRoots: ['/tmp'],
    });

    assert.equal(bridge.outbox.size, 3);
    const newEntries = Array.from(bridge.outbox.values()).filter(
      (entry) => entry.messageId !== existing.messageId,
    );
    assert.equal(newEntries.length, 2);
    assert.equal(newEntries[0].payload._meta?.kind, 'file-transfer');
    assert.equal(newEntries[0].payload._meta?.mediaUrl, '/tmp/channel-message-1.png');
    assert.equal(newEntries[0].payload._meta?.text, 'album caption');
    assert.equal(newEntries[0].payload._meta?.replyToId, 'source-channel-message-media-album');
    assert.equal(newEntries[1].payload._meta?.kind, 'file-transfer');
    assert.equal(newEntries[1].payload._meta?.mediaUrl, '/tmp/channel-message-2.png');
    assert.equal(newEntries[1].payload._meta?.text, '');
    assert.equal(newEntries[1].payload._meta?.replyToId, 'source-channel-message-media-album');

    const lastNewEntry = newEntries[1];
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].messageId, lastNewEntry.messageId);
    assert.equal(result.receipt.primaryPlatformMessageId, lastNewEntry.messageId);
    assert.deepEqual(result.receipt.platformMessageIds, [lastNewEntry.messageId]);
    assert.equal(result.receipt.parts.length, 1);
    assert.equal(result.receipt.parts[0].platformMessageId, lastNewEntry.messageId);
    assert.equal(result.receipt.parts[0].kind, 'media');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channel.message payload sends normalize text payloads into bncr outbox handoff', async () => {
  const bridge = createBridge();
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

test('channel.message payload send prefers payload reply target over context fallback', async () => {
  const bridge = createBridge();
  try {
    await bridge.channelMessageSendPayload({
      accountId: 'Primary',
      to: target,
      replyToId: 'ctx-reply-to-id',
      replyToMessageId: 'ctx-reply-to-message-id',
      payload: {
        message: 'payload message alias',
        replyToId: 'payload-reply-to-id',
      },
    });

    assert.equal(bridge.outbox.size, 1);
    const [entry] = bridge.outbox.values();
    assert.equal(entry.payload.message.msg, 'payload message alias');
    assert.equal(entry.payload.replyToId, 'payload-reply-to-id');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channel.message payload send uses caption alias and context reply fallback', async () => {
  const bridge = createBridge();
  try {
    await bridge.channelMessageSendPayload({
      accountId: 'Primary',
      to: target,
      replyToMessageId: 'ctx-reply-to-message-id',
      payload: {
        caption: 'payload caption alias',
      },
    });

    assert.equal(bridge.outbox.size, 1);
    const [entry] = bridge.outbox.values();
    assert.equal(entry.payload.message.msg, 'payload caption alias');
    assert.equal(entry.payload.replyToId, 'ctx-reply-to-message-id');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channel.message payload sends with mediaUrls return queued handoff receipt for the last new outbox entry', async () => {
  const bridge = createBridge();
  try {
    const result = await bridge.channelMessageSendPayload({
      accountId: 'Primary',
      to: target,
      payload: {
        text: 'payload album caption',
        mediaUrls: [
          '/tmp/channel-message-payload-1.png',
          '/tmp/channel-message-payload-2.png',
          '/tmp/channel-message-payload-3.png',
        ],
        replyToId: 'source-channel-message-payload-album',
      },
      mediaLocalRoots: ['/tmp'],
    });

    assert.equal(bridge.outbox.size, 3);
    const entries = Array.from(bridge.outbox.values());
    assert.deepEqual(
      entries.map((entry) => entry.payload._meta?.mediaUrl),
      [
        '/tmp/channel-message-payload-1.png',
        '/tmp/channel-message-payload-2.png',
        '/tmp/channel-message-payload-3.png',
      ],
    );
    assert.equal(entries[0].payload._meta?.text, 'payload album caption');
    assert.equal(entries[1].payload._meta?.text, '');
    assert.equal(entries[2].payload._meta?.text, '');
    assert.deepEqual(
      entries.map((entry) => entry.payload._meta?.replyToId),
      [
        'source-channel-message-payload-album',
        'source-channel-message-payload-album',
        'source-channel-message-payload-album',
      ],
    );

    const lastEntry = entries[2];
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].messageId, lastEntry.messageId);
    assert.equal(result.receipt.primaryPlatformMessageId, lastEntry.messageId);
    assert.deepEqual(result.receipt.platformMessageIds, [lastEntry.messageId]);
    assert.equal(result.receipt.parts.length, 1);
    assert.equal(result.receipt.parts[0].platformMessageId, lastEntry.messageId);
    assert.equal(result.receipt.parts[0].replyToId, 'source-channel-message-payload-album');
  } finally {
    cleanupBridge(bridge);
  }
});
