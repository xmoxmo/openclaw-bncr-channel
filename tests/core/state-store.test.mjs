import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrStateStore } from '../../src/plugin/state-store.ts';

function createStore() {
  const runtime = {
    getStatePath: () => null,
    now: () => 1000,
    asString: (value, fallback = '') => (typeof value === 'string' ? value : fallback),
    finiteNumberOr: (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    },
    normalizeAccountId: (accountId) => String(accountId || '').trim() || 'Primary',
    normalizeStoredSessionKey: (sessionKey) =>
      sessionKey
        ? {
            sessionKey,
            route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
          }
        : null,
    parseRouteLike: (value) =>
      value && typeof value === 'object' && value.platform ? value : null,
    routeKey: (accountId, route) =>
      `${accountId}:${route.platform}:${route.groupId}:${route.userId}`,
    formatDisplayScope: (route) => `Bncr:${route.platform}:${route.groupId}:${route.userId}`,
    canonicalAgentId: () => 'orion',
    normalizePersistedOutboxEntry: () => null,
    maxDeadLetterEntries: 100,
    maxSessionRouteEntries: 100,
    maxAccountActivityEntries: 100,
    outbox: new Map(),
    getDeadLetter: () => [],
    setDeadLetter: () => {},
    sessionRoutes: new Map(),
    routeAliases: new Map(),
    lastSessionByAccount: new Map(),
    lastActivityByAccount: new Map(),
    lastInboundByAccount: new Map(),
    lastOutboundByAccount: new Map(),
    getLastDriftSnapshot: () => null,
    setLastDriftSnapshot: () => {},
  };

  return { runtime, store: createBncrStateStore(runtime) };
}

test('createBncrStateStore skips non-object entries in persisted account timestamp arrays', () => {
  const { runtime, store } = createStore();
  store.loadPersistedAccountTimestampMap(runtime.lastActivityByAccount, [
    null,
    'bad',
    { accountId: 'A', updatedAt: '12' },
  ]);
  assert.deepEqual(Array.from(runtime.lastActivityByAccount.entries()), [['A', 12]]);
});

test('createBncrStateStore skips non-object entries in persisted last-session arrays', () => {
  const { runtime, store } = createStore();
  store.loadPersistedLastSessionMap([
    undefined,
    'bad',
    { accountId: 'A', sessionKey: 'session-1', updatedAt: '13' },
  ]);
  assert.deepEqual(Array.from(runtime.lastSessionByAccount.entries()), [
    ['A', { sessionKey: 'session-1', scope: 'Bncr:tgBot:-1001:10001', updatedAt: 13 }],
  ]);
});

test('createBncrStateStore keeps valid persisted session routes while skipping malformed entries', () => {
  const { runtime, store } = createStore();
  store.loadPersistedSessionRoutes([
    null,
    'bad',
    { accountId: 'A', sessionKey: '', route: {} },
    {
      accountId: 'A',
      sessionKey: 'session-1',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      updatedAt: '14',
    },
  ]);

  assert.deepEqual(Array.from(runtime.sessionRoutes.entries()), [
    [
      'session-1',
      {
        accountId: 'A',
        route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
        updatedAt: 14,
      },
    ],
  ]);
});

test('createBncrStateStore restores aliases and backfills lastSession from normalized persisted routes', () => {
  const { runtime, store } = createStore();

  store.loadPersistedSessionRoutes([
    {
      accountId: 'Primary',
      sessionKey: 'legacy-session-a',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      updatedAt: '10',
    },
    {
      accountId: 'Primary',
      sessionKey: 'legacy-session-b',
      route: { platform: 'wxBot', groupId: '0', userId: '20002' },
      updatedAt: '20',
    },
  ]);
  store.backfillAccountActivityFromSessionRoutes();

  assert.equal(runtime.routeAliases.size, 2);
  assert.deepEqual(runtime.lastSessionByAccount.get('Primary'), {
    sessionKey: 'legacy-session-b',
    scope: 'Bncr:wxBot:0:20002',
    updatedAt: 20,
  });
  assert.equal(runtime.lastActivityByAccount.get('Primary'), 20);
  assert.equal(runtime.lastInboundByAccount.get('Primary'), 20);
});
