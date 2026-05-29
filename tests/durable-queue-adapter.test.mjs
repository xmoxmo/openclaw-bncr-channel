import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTextOutboxEntry, buildFileTransferOutboxEntry } from '../src/core/outbox-entry-builders.ts';
import { buildBncrDurableQueuedResult } from '../src/messaging/outbound/durable-queue-adapter.ts';

const route = {
  platform: 'tgBot',
  userId: '6278285192',
  groupId: '-1003776014601',
};

function buildTextEntry(overrides = {}) {
  return buildTextOutboxEntry({
    createMessageId: () => overrides.messageId ?? 'msg-text-1',
    now: () => overrides.createdAt ?? 1_790_000_000_000,
    normalizeAccountId: (value) => value || 'Primary',
    normalizeReplyToId: (value) => value || '',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route,
    text: 'hello queued',
    kind: 'final',
    replyToId: overrides.replyToId ?? 'source-mid-1',
  });
}

test('buildBncrDurableQueuedResult reports plugin accepted queued text without claiming client ack', () => {
  const entry = buildTextEntry();
  const result = buildBncrDurableQueuedResult({ entry, index: 2, threadId: 'thread-1' });

  assert.equal(result.status, 'sent');
  assert.equal(result.results[0].messageId, 'msg-text-1');
  assert.equal(result.results[0].chatId, 'Bncr:tgBot:-1003776014601:6278285192');
  assert.deepEqual(result.results[0].meta, {
    status: 'accepted',
    deliveryStage: 'queued',
    queue: 'bncr.outbox',
    finalAckManagedBy: 'bncr-outbox',
    ackSemantics: 'plugin-accepted-not-client-acked',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route,
    outboxPayloadType: 'message.outbound',
  });
  assert.equal(result.receipt.primaryPlatformMessageId, 'msg-text-1');
  assert.deepEqual(result.receipt.platformMessageIds, ['msg-text-1']);
  assert.equal(result.receipt.parts[0].kind, 'text');
  assert.equal(result.receipt.parts[0].index, 2);
  assert.equal(result.receipt.parts[0].replyToId, 'source-mid-1');
  assert.equal(result.receipt.threadId, 'thread-1');
  assert.equal(result.payloadOutcomes[0].status, 'sent');
  assert.equal(result.payloadOutcomes[0].results[0].meta.deliveryStage, 'queued');
});

test('buildBncrDurableQueuedResult maps file transfer entries as queued media receipts', () => {
  const entry = buildFileTransferOutboxEntry({
    createMessageId: () => 'file-msg-1',
    now: () => 1_790_000_123_000,
    normalizeAccountId: (value) => value || 'Primary',
    pushEvent: 'bncr.file.push',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route,
    mediaUrl: '/tmp/demo.png',
    text: 'image caption',
    kind: 'final',
    replyToId: 'source-mid-file',
  });

  const result = buildBncrDurableQueuedResult({ entry });

  assert.equal(result.status, 'sent');
  assert.equal(result.receipt.parts[0].kind, 'media');
  assert.equal(result.receipt.parts[0].replyToId, 'source-mid-file');
  assert.equal(result.results[0].meta.deliveryStage, 'queued');
  assert.equal(result.results[0].meta.finalAckManagedBy, 'bncr-outbox');
  assert.equal(result.results[0].meta.ackSemantics, 'plugin-accepted-not-client-acked');
});

test('buildBncrDurableQueuedResult maps voice-like file transfer entries as queued voice receipts', () => {
  const entry = buildFileTransferOutboxEntry({
    createMessageId: () => 'voice-msg-1',
    now: () => 1_790_000_456_000,
    normalizeAccountId: (value) => value || 'Primary',
    pushEvent: 'bncr.file.push',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route,
    mediaUrl: '/tmp/demo.ogg',
    text: '',
    asVoice: true,
  });

  const result = buildBncrDurableQueuedResult({ entry });

  assert.equal(result.receipt.parts[0].kind, 'voice');
  assert.equal(result.results[0].meta.queue, 'bncr.outbox');
});
