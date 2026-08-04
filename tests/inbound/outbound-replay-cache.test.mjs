import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBncrOutboundReplayKeyFromRoute,
  readBncrOutboundReplaySnapshot,
  recordBncrOutboundReplay,
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

test('outbound messages deduplicate by outbox message id', () => {
  const cache = new Map();
  const route = { platform: 'tgBot', groupId: '-1001', userId: '0' };

  const entry = makeOutboundEntry('out-group-dedupe', route);
  recordBncrOutboundReplay({ cache, entry, sender: 'OpenClaw', senderId: 'Primary' });
  recordBncrOutboundReplay({ cache, entry, sender: 'OpenClaw', senderId: 'Primary' });

  assert.equal(cache.get('Primary:tgBot:-1001')?.length, 1);
});

test('outbound replay key rejects unknown route targets', () => {
  assert.equal(
    buildBncrOutboundReplayKeyFromRoute({ platform: 'tgBot', groupId: '0', userId: '0' }),
    null,
  );
});
