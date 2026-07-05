import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanupBridge,
  createBridge,
  makeEntry,
  setGatewayContextRecorder,
} from '../helpers/bncr-bridge.mjs';

const target = 'Bncr:tgBot:-1001:0';

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
      type: 'image',
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
    assert.equal(entry.payload._meta.type, 'image');
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

test('channel.message media sends with mediaUrls and text split text before attachments', async () => {
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

    assert.equal(bridge.outbox.size, 4);
    const newEntries = Array.from(bridge.outbox.values()).filter(
      (entry) => entry.messageId !== existing.messageId,
    );
    assert.equal(newEntries.length, 3);
    assert.equal(newEntries[0].payload.type, 'message.outbound');
    assert.equal(newEntries[0].payload.message.msg, 'album caption');
    assert.equal(newEntries[0].payload.replyToId, 'source-channel-message-media-album');
    assert.equal(newEntries[1].payload._meta?.kind, 'file-transfer');
    assert.equal(newEntries[1].payload._meta?.mediaUrl, '/tmp/channel-message-1.png');
    assert.equal(newEntries[1].payload._meta?.text, '');
    assert.equal(newEntries[1].payload._meta?.replyToId, 'source-channel-message-media-album');
    assert.equal(newEntries[2].payload._meta?.kind, 'file-transfer');
    assert.equal(newEntries[2].payload._meta?.mediaUrl, '/tmp/channel-message-2.png');
    assert.equal(newEntries[2].payload._meta?.text, '');
    assert.equal(newEntries[2].payload._meta?.replyToId, 'source-channel-message-media-album');

    const lastNewEntry = newEntries[2];
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

test('channel.message media sends with mediaUrls and no text enqueue attachment entries only', async () => {
  const bridge = createBridge();
  try {
    const result = await bridge.channelMessageSendMedia({
      accountId: 'Primary',
      to: target,
      mediaUrls: ['/tmp/channel-message-no-text-1.png', '/tmp/channel-message-no-text-2.png'],
      replyToId: 'source-channel-message-media-no-text',
      mediaLocalRoots: ['/tmp'],
    });

    assert.equal(bridge.outbox.size, 2);
    const entries = Array.from(bridge.outbox.values());
    assert.deepEqual(
      entries.map((entry) => entry.payload._meta?.mediaUrl),
      ['/tmp/channel-message-no-text-1.png', '/tmp/channel-message-no-text-2.png'],
    );
    assert.deepEqual(
      entries.map((entry) => entry.payload._meta?.text),
      ['', ''],
    );
    assert.deepEqual(
      entries.map((entry) => entry.payload._meta?.replyToId),
      ['source-channel-message-media-no-text', 'source-channel-message-media-no-text'],
    );

    const lastEntry = entries[1];
    assert.equal(result.results[0].messageId, lastEntry.messageId);
    assert.equal(result.receipt.parts[0].kind, 'media');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channel.message media sends with mediaUrls and asVoice keep queued voice receipts for each attachment', async () => {
  const bridge = createBridge();
  try {
    const result = await bridge.channelMessageSendMedia({
      accountId: 'Primary',
      to: target,
      text: 'voice album',
      mediaUrls: ['/tmp/channel-message-voice-1.ogg', '/tmp/channel-message-voice-2.ogg'],
      asVoice: true,
      replyToId: 'source-channel-message-media-voice-album',
      mediaLocalRoots: ['/tmp'],
    });

    assert.equal(bridge.outbox.size, 3);
    const entries = Array.from(bridge.outbox.values());

    assert.equal(entries[0].payload.type, 'message.outbound');
    assert.equal(entries[0].payload.message.msg, 'voice album');
    assert.equal(entries[1].payload._meta?.mediaUrl, '/tmp/channel-message-voice-1.ogg');
    assert.equal(entries[1].payload._meta?.asVoice, true);
    assert.equal(entries[2].payload._meta?.mediaUrl, '/tmp/channel-message-voice-2.ogg');
    assert.equal(entries[2].payload._meta?.asVoice, true);

    assert.equal(result.receipt.parts.length, 1);
    assert.equal(result.receipt.parts[0].kind, 'voice');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channel.message media keeps short text as single attachment caption', async () => {
  const bridge = createBridge();
  try {
    await bridge.channelMessageSendMedia({
      accountId: 'Primary',
      to: target,
      text: 'short caption',
      mediaUrl: '/tmp/channel-message-short-caption.png',
      replyToId: 'source-channel-message-media-short-caption',
      mediaLocalRoots: ['/tmp'],
    });

    assert.equal(bridge.outbox.size, 1);
    const [entry] = bridge.outbox.values();
    assert.equal(entry.payload._meta?.kind, 'file-transfer');
    assert.equal(entry.payload._meta?.mediaUrl, '/tmp/channel-message-short-caption.png');
    assert.equal(entry.payload._meta?.text, 'short caption');
    assert.equal(entry.payload._meta?.replyToId, 'source-channel-message-media-short-caption');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channel.message media splits text before a single attachment when text exceeds threshold', async () => {
  const bridge = createBridge();
  try {
    const longText = 'x'.repeat(1021);
    const result = await bridge.channelMessageSendMedia({
      accountId: 'Primary',
      to: target,
      text: longText,
      mediaUrl: '/tmp/channel-message-long-caption.png',
      replyToId: 'source-channel-message-media-long-caption',
      mediaLocalRoots: ['/tmp'],
    });

    assert.equal(bridge.outbox.size, 2);
    const entries = Array.from(bridge.outbox.values());
    assert.equal(entries[0].payload.type, 'message.outbound');
    assert.equal(entries[0].payload.message.msg, longText);
    assert.equal(entries[0].payload.replyToId, 'source-channel-message-media-long-caption');
    assert.equal(entries[1].payload._meta?.kind, 'file-transfer');
    assert.equal(entries[1].payload._meta?.mediaUrl, '/tmp/channel-message-long-caption.png');
    assert.equal(entries[1].payload._meta?.text, '');
    assert.equal(entries[1].payload._meta?.replyToId, 'source-channel-message-media-long-caption');

    assert.equal(result.results[0].messageId, entries[1].messageId);
    assert.equal(result.receipt.parts[0].kind, 'media');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channel.message media keeps a 1020 character text as attachment caption', async () => {
  const bridge = createBridge();
  try {
    const boundaryText = 'x'.repeat(1020);
    await bridge.channelMessageSendMedia({
      accountId: 'Primary',
      to: target,
      text: boundaryText,
      mediaUrl: '/tmp/channel-message-boundary-caption.png',
      replyToId: 'source-channel-message-media-boundary-caption',
      mediaLocalRoots: ['/tmp'],
    });

    assert.equal(bridge.outbox.size, 1);
    const [entry] = bridge.outbox.values();
    assert.equal(entry.payload._meta?.mediaUrl, '/tmp/channel-message-boundary-caption.png');
    assert.equal(entry.payload._meta?.text, boundaryText);
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

test('channel.message payload sends with mediaUrls and text split text before attachments', async () => {
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

    assert.equal(bridge.outbox.size, 4);
    const entries = Array.from(bridge.outbox.values());
    assert.equal(entries[0].payload.type, 'message.outbound');
    assert.equal(entries[0].payload.message.msg, 'payload album caption');
    assert.equal(entries[0].payload.replyToId, 'source-channel-message-payload-album');
    assert.deepEqual(
      entries.slice(1).map((entry) => entry.payload._meta?.mediaUrl),
      [
        '/tmp/channel-message-payload-1.png',
        '/tmp/channel-message-payload-2.png',
        '/tmp/channel-message-payload-3.png',
      ],
    );
    assert.deepEqual(
      entries.slice(1).map((entry) => entry.payload._meta?.text),
      ['', '', ''],
    );
    assert.deepEqual(
      entries.slice(1).map((entry) => entry.payload._meta?.replyToId),
      [
        'source-channel-message-payload-album',
        'source-channel-message-payload-album',
        'source-channel-message-payload-album',
      ],
    );

    const lastEntry = entries[3];
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

test('channel.message payload sends with mediaUrls and asVoice keep queued voice receipts', async () => {
  const bridge = createBridge();
  try {
    const result = await bridge.channelMessageSendPayload({
      accountId: 'Primary',
      to: target,
      payload: {
        text: 'payload voice album',
        mediaUrls: [
          '/tmp/channel-message-payload-voice-1.ogg',
          '/tmp/channel-message-payload-voice-2.ogg',
        ],
        asVoice: true,
        replyToId: 'source-channel-message-payload-voice-album',
      },
      mediaLocalRoots: ['/tmp'],
    });

    assert.equal(bridge.outbox.size, 3);
    const entries = Array.from(bridge.outbox.values());
    assert.equal(entries[0].payload.message.msg, 'payload voice album');
    assert.equal(entries[1].payload._meta?.mediaUrl, '/tmp/channel-message-payload-voice-1.ogg');
    assert.equal(entries[1].payload._meta?.asVoice, true);
    assert.equal(entries[2].payload._meta?.mediaUrl, '/tmp/channel-message-payload-voice-2.ogg');
    assert.equal(entries[2].payload._meta?.asVoice, true);
    assert.equal(result.receipt.parts[0].kind, 'voice');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channel.message text enqueue can be acked through the outbox chain', async () => {
  const bridge = createBridge();
  const pushes = [];

  try {
    setGatewayContextRecorder(bridge, pushes);
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-1',
      clientId: 'client-a',
      connectedAt: Date.now() - 1_000,
      lastSeenAt: Date.now(),
      outboundReadyUntil: Date.now() + 60_000,
      preferredForOutboundUntil: Date.now() + 60_000,
      inboundOnly: false,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => true;

    const result = await bridge.channelMessageSendText({
      accountId: 'Primary',
      to: target,
      text: 'channel message ack chain',
      replyToId: 'source-ack-chain',
    });

    const messageId = result.results[0].messageId;
    const waiter = bridge.waitForMessageAck(messageId, 1_000);
    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'channel-message-ack-chain',
    });
    await bridge.handleAck({
      params: { accountId: 'Primary', messageId, ok: true },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(await waiter, 'acked');
    assert.equal(pushes.length, 1);
    assert.equal(bridge.outbox.has(messageId), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('channel.message media enqueue can be settled through file ack and message ack chain', async () => {
  const bridge = createBridge();

  try {
    const result = await bridge.channelMessageSendMedia({
      accountId: 'Primary',
      to: target,
      text: 'file ack chain',
      mediaUrl: '/tmp/file-ack-chain.png',
      replyToId: 'source-file-ack-chain',
      mediaLocalRoots: ['/tmp'],
    });

    const messageId = result.results[0].messageId;
    const [entry] = bridge.outbox.values();
    const fileAck = bridge.waitForFileAck({
      transferId: messageId,
      stage: 'complete',
      timeoutMs: 1_000,
    });
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: messageId,
        stage: 'complete',
        ok: true,
        path: '/tmp/file-ack-chain.png',
      },
      respond() {},
      client: { connId: entry.lastPushConnId || 'conn-1' },
      context: null,
    });

    const ackPayload = await fileAck;
    assert.equal(ackPayload.path, '/tmp/file-ack-chain.png');
    assert.equal(ackPayload.stage, 'complete');
  } finally {
    cleanupBridge(bridge);
  }
});
