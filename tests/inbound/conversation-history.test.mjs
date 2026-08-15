import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearBncrPendingConversationHistory,
  readBncrPendingConversationHistorySnapshot,
  readConversationHistoryVersion,
  recordBncrBotReply,
  recordBncrPendingConversationMedia,
  recordBncrPendingConversationText,
  removeBncrConversationHistoryMessageIds,
  resetConversationHistoryVersions,
  resolveBncrHistoryLimit,
} from '../../src/messaging/inbound/conversation-history.ts';
import { parseBncrInboundParams } from '../../src/messaging/inbound/parse.ts';

function makeDirectParsed(messageId, body) {
  return parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    isGroup: false,
    type: 'text',
    msg: body,
    mimeType: 'text/plain',
    msgId: messageId,
  });
}

test('resolveBncrHistoryLimit treats zero and invalid values as the default window', () => {
  assert.equal(resolveBncrHistoryLimit(0), 50);
  assert.equal(resolveBncrHistoryLimit(1), 50);
  assert.equal(resolveBncrHistoryLimit(-1), 50);
  assert.equal(resolveBncrHistoryLimit(Number.NaN), 50);
  assert.equal(resolveBncrHistoryLimit(undefined), 50);
  assert.equal(resolveBncrHistoryLimit(0.5), 50);
  assert.equal(resolveBncrHistoryLimit(1.5), 50);
  assert.equal(resolveBncrHistoryLimit(2), 2);
  assert.equal(resolveBncrHistoryLimit(12.8), 12);
});

test('conversation history records with historyLimit zero use the default window', () => {
  const historyMap = new Map();
  const parsed = makeDirectParsed('zero-limit-user-1', 'hello');

  recordBncrPendingConversationText({
    historyMap,
    parsed,
    senderDisplayName: 'xmo',
    senderId: '10001',
    bodyText: 'hello',
    historyLimit: 0,
  });
  recordBncrBotReply({
    historyMap,
    historyKey: 'tgBot:10001',
    sender: 'OpenClaw',
    senderId: 'Primary',
    body: 'bot reply',
    messageId: 'zero-limit-bot-1',
    historyLimit: 0,
  });

  const entries = historyMap.get('tgBot:10001') ?? [];
  assert.equal(entries.length, 2);
  assert.equal(entries[0].role, 'user');
  assert.equal(entries[1].role, 'assistant');
});

test('conversation history read and clear with historyLimit zero use the default window', () => {
  const historyMap = new Map();
  const parsed = makeDirectParsed('zero-limit-read-1', 'hello');
  recordBncrPendingConversationText({
    historyMap,
    parsed,
    senderDisplayName: 'xmo',
    senderId: '10001',
    bodyText: 'hello',
    historyLimit: 0,
  });

  const snapshot = readBncrPendingConversationHistorySnapshot({
    historyMap,
    parsed,
    historyLimit: 0,
  });
  assert.equal(snapshot.length, 1);

  clearBncrPendingConversationHistory({
    historyMap,
    parsed,
    historyLimit: 0,
  });
  assert.deepEqual(historyMap.get('tgBot:10001'), []);
});

test('conversation history assigns stable synthetic ids for missing platform message ids', () => {
  const historyMap = new Map();
  const textParsed = makeDirectParsed(undefined, 'hello without message id');
  const mediaParsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    isGroup: false,
    type: 'image',
    msg: 'caption without message id',
    base64: Buffer.from('image').toString('base64'),
    mimeType: 'image/png',
  });

  recordBncrPendingConversationText({
    historyMap,
    parsed: textParsed,
    senderDisplayName: 'xmo',
    senderId: '10001',
    bodyText: 'hello without message id',
  });

  recordBncrPendingConversationMedia({
    historyMap,
    parsed: mediaParsed,
    senderDisplayName: 'xmo',
    senderId: '10001',
    bodyText: 'caption without message id',
    mediaItems: [{ path: '/tmp/image.png', contentType: 'image/png', kind: 'image' }],
  });

  const snapshot = readBncrPendingConversationHistorySnapshot({
    historyMap,
    parsed: textParsed,
  });
  const [textMessageId, mediaMessageId] = snapshot.map((entry) => entry.messageId);
  assert.match(textMessageId, /^bncr-synthetic:/);
  assert.match(mediaMessageId, /^bncr-synthetic:/);
  assert.notEqual(textMessageId, mediaMessageId);
  assert.equal(historyMap.get('tgBot:10001')?.[1]?.media?.[0]?.messageId, mediaMessageId);

  removeBncrConversationHistoryMessageIds({
    historyMap,
    historyKey: 'tgBot:10001',
    messageIds: [textMessageId, mediaMessageId],
  });
  assert.deepEqual(historyMap.get('tgBot:10001'), []);
});

test('identical messages without platform ids are retained as distinct entries', () => {
  const historyMap = new Map();
  for (let index = 0; index < 2; index += 1) {
    recordBncrPendingConversationText({
      historyMap,
      parsed: makeDirectParsed(undefined, 'same text without message id'),
      senderDisplayName: 'xmo',
      senderId: '10001',
      bodyText: 'same text without message id',
    });
  }

  const snapshot = readBncrPendingConversationHistorySnapshot({
    historyMap,
    parsed: makeDirectParsed(undefined, 'ignored'),
  });
  const messageIds = snapshot.map((entry) => entry.messageId);
  assert.equal(snapshot.length, 2);
  assert.equal(new Set(messageIds).size, 2);
});

test('bot replies without platform message ids get stable synthetic history ids', () => {
  const historyMap = new Map();

  const first = recordBncrBotReply({
    historyMap,
    historyKey: 'tgBot:10001',
    sender: 'OpenClaw',
    senderId: 'Primary',
    body: 'bot reply without platform id',
    timestamp: 123,
    media: [{ path: '/tmp/bot-reply.png', contentType: 'image/png', kind: 'image' }],
  });
  const duplicate = recordBncrBotReply({
    historyMap,
    historyKey: 'tgBot:10001',
    sender: 'OpenClaw',
    senderId: 'Primary',
    body: 'bot reply without platform id',
    timestamp: 123,
    media: [{ path: '/tmp/bot-reply.png', contentType: 'image/png', kind: 'image' }],
  });

  assert.equal(first, true);
  assert.equal(duplicate, false);
  const entry = historyMap.get('tgBot:10001')?.[0];
  assert.match(entry.messageId, /^bncr-synthetic:/);
  assert.equal(entry.media?.[0]?.messageId, entry.messageId);

  removeBncrConversationHistoryMessageIds({
    historyMap,
    historyKey: 'tgBot:10001',
    messageIds: [entry.messageId],
  });
  assert.deepEqual(historyMap.get('tgBot:10001'), []);
});

test('history snapshot backfills stable synthetic ids for legacy bot entries without ids', () => {
  const historyMap = new Map([
    [
      'tgBot:10001',
      [
        {
          sender: 'OpenClaw',
          senderId: 'Primary',
          body: 'legacy bot reply',
          timestamp: 1,
        },
      ],
    ],
  ]);

  const snapshot = readBncrPendingConversationHistorySnapshot({
    historyMap,
    parsed: makeDirectParsed('legacy-bot-snapshot-1', 'ignored'),
  });
  const messageId = snapshot[0]?.messageId;
  assert.match(messageId, /^bncr-synthetic:/);
  assert.equal(historyMap.get('tgBot:10001')?.[0]?.messageId, messageId);
});

test('conversation history version increments only for new writes and clears', () => {
  const historyMap = new Map();

  recordBncrPendingConversationText({
    historyMap,
    parsed: makeDirectParsed('version-user-1', 'hello'),
    senderDisplayName: 'xmo',
    senderId: '10001',
    bodyText: 'hello',
  });
  assert.equal(readConversationHistoryVersion(historyMap, 'tgBot:10001'), 1);

  recordBncrBotReply({
    historyMap,
    historyKey: 'tgBot:10001',
    sender: 'OpenClaw',
    senderId: 'Primary',
    body: 'bot hello',
    messageId: 'version-bot-1',
  });
  assert.equal(readConversationHistoryVersion(historyMap, 'tgBot:10001'), 2);

  recordBncrBotReply({
    historyMap,
    historyKey: 'tgBot:10001',
    sender: 'OpenClaw',
    senderId: 'Primary',
    body: 'bot hello',
    messageId: 'version-bot-1',
  });
  assert.equal(readConversationHistoryVersion(historyMap, 'tgBot:10001'), 2);

  clearBncrPendingConversationHistory({
    historyMap,
    parsed: makeDirectParsed('version-user-1', 'hello'),
  });
  assert.equal(readConversationHistoryVersion(historyMap, 'tgBot:10001'), 3);
});

test('snapshot cleanup removal does not advance history version', () => {
  const historyMap = new Map();
  recordBncrPendingConversationText({
    historyMap,
    parsed: makeDirectParsed('cleanup-version-user-1', 'hello'),
    senderDisplayName: 'xmo',
    senderId: '10001',
    bodyText: 'hello',
  });
  recordBncrBotReply({
    historyMap,
    historyKey: 'tgBot:10001',
    sender: 'OpenClaw',
    senderId: 'Primary',
    body: 'bot hello',
    messageId: 'cleanup-version-bot-1',
  });
  assert.equal(readConversationHistoryVersion(historyMap, 'tgBot:10001'), 2);

  removeBncrConversationHistoryMessageIds({
    historyMap,
    historyKey: 'tgBot:10001',
    messageIds: ['cleanup-version-user-1', 'cleanup-version-bot-1'],
  });

  assert.equal(readConversationHistoryVersion(historyMap, 'tgBot:10001'), 2);
  assert.deepEqual(historyMap.get('tgBot:10001'), []);
});

test('conversation history version resets when persisted history is replaced', () => {
  const historyMap = new Map();

  recordBncrPendingConversationText({
    historyMap,
    parsed: makeDirectParsed('version-reset-1', 'hello'),
    senderDisplayName: 'xmo',
    senderId: '10001',
    bodyText: 'hello',
  });
  assert.equal(readConversationHistoryVersion(historyMap, 'tgBot:10001'), 1);

  resetConversationHistoryVersions(historyMap);
  assert.equal(readConversationHistoryVersion(historyMap, 'tgBot:10001'), 0);
});
