import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTextOutboxEntry } from '../../src/core/outbox-entry-builders.ts';
import { buildBncrNativeReplyDeliveryPayload } from '../../src/messaging/inbound/native-reply-delivery.ts';
import {
  enqueueReplyTextEntry,
  normalizeReplyPayload,
} from '../../src/messaging/outbound/reply-enqueue.ts';
import {
  cleanupBridge,
  createBridge,
  TEST_ACCOUNT_ID,
  TEST_ROUTE,
  TEST_SESSION_KEY,
} from '../helpers/bncr-bridge.mjs';

test('buildBncrNativeReplyDeliveryPayload builds command payload from final reply', () => {
  assert.deepEqual(
    buildBncrNativeReplyDeliveryPayload({
      payload: { text: 'done' },
      kind: 'final',
      effectiveReply: { blockStreaming: true, allowTool: false },
      msgId: 'msg-1',
    }),
    {
      text: 'done',
      replyToId: 'msg-1',
    },
  );
});

test('buildBncrNativeReplyDeliveryPayload builds command payload from block reply', () => {
  assert.deepEqual(
    buildBncrNativeReplyDeliveryPayload({
      payload: { mediaUrl: 'https://example.test/image.png' },
      kind: 'block',
      effectiveReply: { blockStreaming: false, allowTool: false },
      msgId: 'msg-2',
    }),
    {
      mediaUrl: 'https://example.test/image.png',
      replyToId: 'msg-2',
    },
  );
});

test('buildBncrNativeReplyDeliveryPayload drops tool payload when allowTool is false', () => {
  assert.equal(
    buildBncrNativeReplyDeliveryPayload({
      payload: { text: 'tool result' },
      kind: 'tool',
      effectiveReply: { blockStreaming: true, allowTool: false },
      msgId: 'msg-3',
    }),
    null,
  );
});

test('buildBncrNativeReplyDeliveryPayload drops tool payload when blockStreaming is false', () => {
  assert.equal(
    buildBncrNativeReplyDeliveryPayload({
      payload: { text: 'tool result' },
      kind: 'tool',
      effectiveReply: { blockStreaming: false, allowTool: true },
      msgId: 'msg-4',
    }),
    null,
  );
});

test('native command direct gateway reply keeps reply target without carrying reply kind', () => {
  assert.deepEqual(
    buildBncrNativeReplyDeliveryPayload({
      payload: { text: 'gateway direct command reply' },
      kind: 'tool',
      effectiveReply: { blockStreaming: true, allowTool: true },
      msgId: '1780776712995',
    }),
    {
      text: 'gateway direct command reply',
      replyToId: '1780776712995',
    },
  );
});

test('native command tool reply keeps reply target after enqueue normalization', async () => {
  const payload = buildBncrNativeReplyDeliveryPayload({
    payload: { text: 'gateway direct command reply' },
    kind: 'tool',
    effectiveReply: { blockStreaming: true, allowTool: true },
    msgId: '1780776712995',
  });
  const normalized = normalizeReplyPayload(
    payload,
    { asString: String },
    { replyTargetPolicy: 'preserve' },
  );
  const enqueued = [];

  enqueueReplyTextEntry(
    {
      accountId: TEST_ACCOUNT_ID,
      sessionKey: TEST_SESSION_KEY,
      route: TEST_ROUTE,
      payload: normalized,
    },
    {
      enqueueOutbound: (entry) => enqueued.push(entry),
      buildTextOutboxEntry: (args) =>
        buildTextOutboxEntry({
          ...args,
          createMessageId: () => 'native-tool-reply-target',
          now: () => 1000,
          normalizeAccountId: (accountId) => accountId || TEST_ACCOUNT_ID,
          normalizeReplyToId: (value) => (typeof value === 'string' ? value.trim() : ''),
        }),
    },
  );

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].payload.message.kind, undefined);
  assert.equal(enqueued[0].payload.replyToId, '1780776712995');
});

test('native command tool reply keeps reply target through bridge enqueue path', async () => {
  const bridge = createBridge();
  try {
    const payload = buildBncrNativeReplyDeliveryPayload({
      payload: { text: 'gateway direct command reply' },
      kind: 'tool',
      effectiveReply: { blockStreaming: true, allowTool: true },
      msgId: '1780776712995',
    });

    await bridge.enqueueFromReply({
      accountId: TEST_ACCOUNT_ID,
      sessionKey: TEST_SESSION_KEY,
      route: TEST_ROUTE,
      payload,
      replyTargetPolicy: 'preserve',
    });

    assert.equal(bridge.outbox.size, 1);
    const [entry] = bridge.outbox.values();
    bridge.outbox.clear();
    assert.equal(entry.payload.message.kind, undefined);
    assert.equal(entry.payload.replyToId, '1780776712995');
  } finally {
    cleanupBridge(bridge);
  }
});

test('ordinary payload cannot preserve tool reply target through payload field', async () => {
  const bridge = createBridge();
  try {
    await bridge.enqueueFromReply({
      accountId: TEST_ACCOUNT_ID,
      sessionKey: TEST_SESSION_KEY,
      route: TEST_ROUTE,
      payload: {
        text: 'ordinary tool payload',
        kind: 'tool',
        replyToId: '1780776712995',
        replyTargetPolicy: 'preserve',
      },
    });

    assert.equal(bridge.outbox.size, 1);
    const [entry] = bridge.outbox.values();
    bridge.outbox.clear();
    assert.equal(entry.payload.message.kind, 'tool');
    assert.equal(entry.payload.replyToId, undefined);
  } finally {
    cleanupBridge(bridge);
  }
});

test('native command reply preserve path keeps tool and final replies on the same session route', async () => {
  const bridge = createBridge();

  try {
    const toolPayload = buildBncrNativeReplyDeliveryPayload({
      payload: { text: 'tool reply' },
      kind: 'tool',
      effectiveReply: { blockStreaming: true, allowTool: true },
      msgId: 'native-msg-1',
    });
    const finalPayload = buildBncrNativeReplyDeliveryPayload({
      payload: { text: 'final reply' },
      kind: 'final',
      effectiveReply: { blockStreaming: true, allowTool: false },
      msgId: 'native-msg-1',
    });

    await bridge.enqueueFromReply({
      accountId: TEST_ACCOUNT_ID,
      sessionKey: TEST_SESSION_KEY,
      route: TEST_ROUTE,
      payload: toolPayload,
      replyTargetPolicy: 'preserve',
    });
    await bridge.enqueueFromReply({
      accountId: TEST_ACCOUNT_ID,
      sessionKey: TEST_SESSION_KEY,
      route: TEST_ROUTE,
      payload: finalPayload,
      replyTargetPolicy: 'preserve',
    });

    const entries = Array.from(bridge.outbox.values());
    assert.equal(entries.length, 2);
    assert.equal(entries[0].sessionKey, TEST_SESSION_KEY);
    assert.equal(entries[1].sessionKey, TEST_SESSION_KEY);
    assert.equal(entries[0].payload.replyToId, 'native-msg-1');
    assert.equal(entries[1].payload.replyToId, 'native-msg-1');
    assert.equal(entries[0].payload.message.kind, undefined);
    assert.equal(entries[1].payload.message.kind, undefined);
  } finally {
    cleanupBridge(bridge);
  }
});

test('buildBncrNativeReplyDeliveryPayload returns null for empty text, mediaUrl, and mediaUrls', () => {
  const effectiveReply = { blockStreaming: true, allowTool: true };

  assert.equal(
    buildBncrNativeReplyDeliveryPayload({
      payload: { text: '' },
      kind: 'final',
      effectiveReply,
      msgId: 'msg-6',
    }),
    null,
  );
  assert.equal(
    buildBncrNativeReplyDeliveryPayload({
      payload: { mediaUrl: '' },
      kind: 'final',
      effectiveReply,
      msgId: 'msg-6',
    }),
    null,
  );
  assert.equal(
    buildBncrNativeReplyDeliveryPayload({
      payload: { mediaUrls: [] },
      kind: 'final',
      effectiveReply,
      msgId: 'msg-6',
    }),
    null,
  );
});

test('buildBncrNativeReplyDeliveryPayload maps empty message id to undefined replyToId', () => {
  assert.deepEqual(
    buildBncrNativeReplyDeliveryPayload({
      payload: { mediaUrls: ['https://example.test/one.png'] },
      kind: 'final',
      effectiveReply: { blockStreaming: true, allowTool: false },
      msgId: '',
    }),
    {
      mediaUrls: ['https://example.test/one.png'],
      replyToId: undefined,
    },
  );
});
