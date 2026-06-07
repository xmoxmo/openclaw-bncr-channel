import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePersistedOutboxEntry } from '../src/core/persisted-outbox-entry.ts';

const canonicalAgentId = 'orion';
const route = { platform: 'tgBot', groupId: '-1001', userId: '10001' };
const sessionKey = 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031';

function normalize(entry, now = () => 10_000) {
  return normalizePersistedOutboxEntry({ entry, canonicalAgentId, now });
}

test('normalizePersistedOutboxEntry migrates a valid persisted entry', () => {
  const entry = {
    messageId: 'msg-1',
    accountId: 'Primary',
    sessionKey,
    route,
    payload: { text: 'hello', sessionKey: 'old', platform: 'old', keep: true },
    createdAt: '100',
    retryCount: '2',
    nextAttemptAt: '200',
    lastAttemptAt: '150',
    extra: 'preserved',
  };

  const result = normalize(entry);

  assert.equal(result?.messageId, 'msg-1');
  assert.equal(result?.accountId, 'Primary');
  assert.equal(result?.sessionKey, sessionKey);
  assert.deepEqual(result?.route, route);
  assert.deepEqual(result?.payload, {
    text: 'hello',
    sessionKey,
    platform: 'tgBot',
    keep: true,
    groupId: '-1001',
    userId: '10001',
  });
  assert.equal(result?.createdAt, 100);
  assert.equal(result?.retryCount, 2);
  assert.equal(result?.nextAttemptAt, 200);
  assert.equal(result?.lastAttemptAt, 150);
  assert.equal(result?.extra, 'preserved');
});

test('normalizePersistedOutboxEntry returns null without messageId or session', () => {
  assert.equal(normalize({ sessionKey }), null);
  assert.equal(normalize({ messageId: 'msg-1', sessionKey: null }), null);
});

test('normalizePersistedOutboxEntry falls back to injected now for invalid timestamps', () => {
  const ticks = [9_001, 9_002];
  const result = normalize(
    {
      messageId: 'msg-1',
      sessionKey,
      route,
      createdAt: 'bad-created',
      nextAttemptAt: 'bad-next',
    },
    () => ticks.shift(),
  );

  assert.equal(result?.createdAt, 9_001);
  assert.equal(result?.nextAttemptAt, 9_002);
});

test('normalizePersistedOutboxEntry replaces non-object payload with route payload fields', () => {
  const result = normalize({
    messageId: 'msg-1',
    sessionKey,
    route,
    payload: 'bad-payload',
  });

  assert.deepEqual(result?.payload, {
    sessionKey,
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
  });
});

test('normalizePersistedOutboxEntry uses normalized route when persisted route is missing', () => {
  const result = normalize({
    messageId: 'msg-1',
    sessionKey,
    payload: {},
  });

  assert.deepEqual(result?.route, route);
});

test('normalizePersistedOutboxEntry stringifies truthy lastError', () => {
  const result = normalize({
    messageId: 'msg-1',
    sessionKey,
    route,
    lastError: 404,
  });

  assert.equal(result?.lastError, '404');
});
