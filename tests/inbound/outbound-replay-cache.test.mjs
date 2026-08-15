import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBncrOutboundReplayKeyFromRoute,
  readBncrOutboundReplaySnapshot,
  recordBncrOutboundReplay,
  removeBncrOutboundReplayMessageIds,
} from '../../src/messaging/inbound/outbound-replay-cache.ts';
import { parseBncrInboundParams } from '../../src/messaging/inbound/parse.ts';

function makeOutboundEntry(messageId, route, overrides = {}) {
  const message = {
    type: overrides.type ?? 'text',
    msg: overrides.msg ?? 'hello from bot',
    ...(overrides.mediaUrl ? { mediaUrl: overrides.mediaUrl } : {}),
  };
  return {
    messageId,
    accountId: 'Primary',
    sessionKey: `agent:orion:bncr:${route.groupId === '0' ? 'direct' : 'group'}:demo`,
    route,
    payload: {
      type: 'message.outbound',
      messageId,
      message,
    },
    createdAt: 1,
    retryCount: 0,
    nextAttemptAt: 1,
  };
}

function makeParsed(route) {
  return parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: route.platform,
    groupId: route.groupId,
    userId: route.userId,
    isGroup: route.groupId !== '0',
    type: 'text',
    msg: 'current direct message',
    msgId: 'current-1',
  });
}

test('outbound messages use the same cache key as inbound messages in groups', () => {
  const cache = new Map();
  const route = { platform: 'tgBot', groupId: '-1001', userId: '0' };

  recordBncrOutboundReplay({
    cache,
    entry: makeOutboundEntry('out-group-1', route),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  assert.deepEqual(cache.get('Primary:tgBot:-1001'), [
    {
      sender: 'OpenClaw',
      senderId: 'Primary',
      body: 'hello from bot',
      timestamp: cache.get('Primary:tgBot:-1001')[0].timestamp,
      messageId: 'out-group-1',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:group:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '0' },
      type: 'text',
      createdAt: 1,
    },
  ]);
});

test('outbound messages are readable by the next direct turn and stay cached', () => {
  const cache = new Map();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  recordBncrOutboundReplay({
    cache,
    entry: makeOutboundEntry('out-direct-1', route, {
      type: 'video',
      msg: 'see this',
      mediaUrl: 'https://cdn.example.com/clip.mp4',
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  const parsed = makeParsed(route);
  const entries = readBncrOutboundReplaySnapshot({
    cache,
    parsed,
    accountId: 'Primary',
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].messageId, 'out-direct-1');
  assert.equal(entries[0].body, 'see this');
  assert.equal(entries[0].media?.[0]?.kind, 'video');
  assert.equal(entries[0].sessionKey, 'agent:orion:bncr:direct:demo');
  assert.equal(entries[0].route?.userId, '10001');
  assert.equal(cache.get('Primary:tgBot:10001')?.length, 1);
});

test('outbound messages write assistant entries into unified private history', () => {
  const cache = new Map();
  const conversationHistories = new Map();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  recordBncrOutboundReplay({
    cache,
    conversationHistories,
    entry: makeOutboundEntry('out-private-history-1', route, {
      type: 'image',
      msg: 'see this image',
      mediaUrl: 'https://cdn.example.com/image.png',
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  assert.deepEqual(conversationHistories.get('tgBot:10001'), [
    {
      sender: 'OpenClaw',
      senderId: 'Primary',
      body: 'see this image',
      timestamp: conversationHistories.get('tgBot:10001')[0].timestamp,
      messageId: 'out-private-history-1',
      role: 'assistant',
      media: [
        {
          path: 'https://cdn.example.com/image.png',
          kind: 'image',
          messageId: 'out-private-history-1',
        },
      ],
    },
  ]);

  const parsed = makeParsed(route);
  const entries = readBncrOutboundReplaySnapshot({
    cache,
    conversationHistories,
    parsed,
    accountId: 'Primary',
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].messageId, 'out-private-history-1');
  assert.equal(entries[0].sender, 'OpenClaw');
  assert.equal(entries[0].senderId, 'Primary');
  assert.equal(entries[0].body, 'see this image');
  assert.equal(entries[0].media?.[0]?.kind, 'image');
});

test('outbound message history timestamps prefer the actual push time', () => {
  const cache = new Map();
  const conversationHistories = new Map();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };
  const entry = {
    ...makeOutboundEntry('out-timestamp-1', route),
    lastPushAt: 42,
  };

  recordBncrOutboundReplay({
    cache,
    conversationHistories,
    entry,
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  assert.equal(conversationHistories.get('tgBot:10001')?.[0]?.timestamp, 42);
  assert.equal(cache.get('Primary:tgBot:10001')?.[0]?.timestamp, 42);
});

test('read outbound replay falls back to legacy cache while unified history is empty', () => {
  const cache = new Map();
  const conversationHistories = new Map();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  recordBncrOutboundReplay({
    cache,
    entry: makeOutboundEntry('out-legacy-only-1', route),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  const entries = readBncrOutboundReplaySnapshot({
    cache,
    conversationHistories,
    parsed: makeParsed(route),
    accountId: 'Primary',
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].messageId, 'out-legacy-only-1');
  assert.equal(entries[0].sessionKey, 'agent:orion:bncr:direct:demo');
});

test('read outbound replay deduplicates unified history and legacy cache', () => {
  const cache = new Map();
  const conversationHistories = new Map();
  const route = { platform: 'tgBot', groupId: '-1001', userId: '0' };

  recordBncrOutboundReplay({
    cache,
    conversationHistories,
    entry: makeOutboundEntry('out-shared-1', route),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  const entries = readBncrOutboundReplaySnapshot({
    cache,
    conversationHistories,
    parsed: makeParsed(route),
    accountId: 'Primary',
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].messageId, 'out-shared-1');
});

test('outbound messages deduplicate by outbox message id', () => {
  const cache = new Map();
  const route = { platform: 'tgBot', groupId: '-1001', userId: '0' };

  const entry = makeOutboundEntry('out-group-dedupe', route);
  recordBncrOutboundReplay({ cache, entry, sender: 'OpenClaw', senderId: 'Primary' });
  recordBncrOutboundReplay({ cache, entry, sender: 'OpenClaw', senderId: 'Primary' });

  assert.equal(cache.get('Primary:tgBot:-1001')?.length, 1);
});

test('outbound replies without platform ids share one synthetic id across history and cache', () => {
  const cache = new Map();
  const conversationHistories = new Map();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  const result = recordBncrOutboundReplay({
    cache,
    conversationHistories,
    entry: makeOutboundEntry(undefined, route, { lastPushAt: 42 }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });
  assert.equal(result.recorded, true);

  const historyMessageId = conversationHistories.get('tgBot:10001')?.[0]?.messageId;
  const cacheMessageId = cache.get('Primary:tgBot:10001')?.[0]?.messageId;
  assert.match(historyMessageId, /^bncr-synthetic:/);
  assert.equal(cacheMessageId, historyMessageId);

  const parsed = makeParsed(route);
  const snapshot = readBncrOutboundReplaySnapshot({
    cache,
    conversationHistories,
    parsed,
    accountId: 'Primary',
  });
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].messageId, historyMessageId);

  assert.equal(
    removeBncrOutboundReplayMessageIds({
      cache,
      parsed,
      accountId: 'Primary',
      messageIds: [historyMessageId],
    }),
    1,
  );
  assert.equal(cache.has('Primary:tgBot:10001'), false);
});

test('outbound replay key rejects unknown route targets', () => {
  assert.equal(
    buildBncrOutboundReplayKeyFromRoute({ platform: 'tgBot', groupId: '0', userId: '0' }),
    null,
  );
});

test('outbound replay signals history overflow only when an outbound reaches the limit', () => {
  const cache = new Map();
  const conversationHistories = new Map();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };
  const results = [];

  for (let index = 1; index <= 3; index += 1) {
    results.push(
      recordBncrOutboundReplay({
        cache,
        conversationHistories,
        historyLimit: 3,
        entry: makeOutboundEntry(`overflow-${index}`, route),
        sender: 'OpenClaw',
        senderId: 'Primary',
      }),
    );
  }

  assert.deepEqual(results, [
    { recorded: true, historyOverflow: false },
    { recorded: true, historyOverflow: false },
    { recorded: true, historyOverflow: true, historyVersion: 3 },
  ]);

  assert.deepEqual(
    recordBncrOutboundReplay({
      cache,
      conversationHistories,
      historyLimit: 3,
      entry: makeOutboundEntry('overflow-3', route),
      sender: 'OpenClaw',
      senderId: 'Primary',
    }),
    { recorded: false, historyOverflow: true, historyVersion: 3 },
  );
});

test('outbound replay still signals overflow when history is new but cache already has the message id', () => {
  const cache = new Map();
  const conversationHistories = new Map();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  recordBncrOutboundReplay({
    cache,
    entry: makeOutboundEntry('cache-only-1', route),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });
  recordBncrOutboundReplay({
    cache,
    entry: makeOutboundEntry('cache-only-2', route),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  recordBncrOutboundReplay({
    cache,
    conversationHistories,
    historyLimit: 2,
    entry: makeOutboundEntry('cache-only-1', route),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  assert.deepEqual(
    recordBncrOutboundReplay({
      cache,
      conversationHistories,
      historyLimit: 2,
      entry: makeOutboundEntry('cache-only-2', route),
      sender: 'OpenClaw',
      senderId: 'Primary',
    }),
    { recorded: false, historyOverflow: true, historyVersion: 2 },
  );
});

test('outbound replay cache is bounded by the unified conversation window limit', () => {
  const cache = new Map();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  for (let index = 1; index <= 5; index += 1) {
    recordBncrOutboundReplay({
      cache,
      historyLimit: 3,
      entry: makeOutboundEntry(`bounded-cache-${index}`, route, {
        lastPushAt: 1000 + index,
      }),
      sender: 'OpenClaw',
      senderId: 'Primary',
    });
  }

  assert.deepEqual(
    cache.get('Primary:tgBot:10001')?.map((entry) => entry.messageId),
    ['bounded-cache-3', 'bounded-cache-4', 'bounded-cache-5'],
  );
});
