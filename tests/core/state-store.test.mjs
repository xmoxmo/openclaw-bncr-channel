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
    sceneRegistry: new Map(),
    groupHistories: new Map(),
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

test('createBncrStateStore restores valid persisted scene registry entries and skips malformed rows', () => {
  const { runtime, store } = createStore();

  store.loadPersistedSceneRegistry([
    null,
    'bad',
    {
      sceneKey: '',
      kind: 'direct',
      status: 'pending',
      platform: 'tgBot',
      userId: '10001',
      lastSeenAt: 10,
    },
    {
      sceneKey: 'tgBot:10001',
      kind: 'direct',
      status: 'allowed',
      platform: 'tgBot',
      userId: '10001',
      userName: 'xmo',
      agentId: 'main',
      lastSeenAt: '12',
    },
    {
      sceneKey: 'tgBot:-1001',
      kind: 'group',
      status: 'denied',
      platform: 'tgBot',
      groupId: '-1001',
      groupName: 'wind_system',
      groupReplyMode: 'mention',
      lastSeenAt: 13,
    },
  ]);

  assert.deepEqual(Array.from(runtime.sceneRegistry.entries()), [
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        agentId: 'main',
        lastSeenAt: 12,
      },
    ],
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'denied',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        groupReplyMode: 'mention',
        lastSeenAt: 13,
      },
    ],
  ]);
});

test('createBncrStateStore preserves senderId in persisted group histories', () => {
  const { runtime, store } = createStore();
  runtime.sceneRegistry.set('tgBot:-1001', {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    historyLimit: 50,
    historyForce: true,
    lastSeenAt: 1,
  });

  store.loadPersistedGroupHistories([
    {
      key: 'tgBot:-1001',
      entries: [
        {
          sender: 'alice',
          senderId: '10001',
          body: 'hello',
          timestamp: 10,
          messageId: 'm1',
        },
      ],
    },
  ]);

  assert.deepEqual(runtime.groupHistories.get('tgBot:-1001'), [
    {
      sender: 'alice',
      senderId: '10001',
      body: 'hello',
      timestamp: 10,
      messageId: 'm1',
    },
  ]);
  assert.deepEqual(store.dumpPersistedGroupHistories(), [
    {
      key: 'tgBot:-1001',
      entries: [
        {
          sender: 'alice',
          senderId: '10001',
          body: 'hello',
          timestamp: 10,
          messageId: 'm1',
        },
      ],
    },
  ]);
});

test('createBncrStateStore persists group histories up to 1.2x configured scene history limit', () => {
  const { runtime, store } = createStore();
  runtime.sceneRegistry.set('tgBot:-1002', {
    sceneKey: 'tgBot:-1002',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1002',
    historyLimit: 80,
    historyForce: true,
    lastSeenAt: 1,
  });

  const entries = Array.from({ length: 120 }, (_, index) => ({
    sender: 'alice',
    senderId: '10001',
    body: `m${index + 1}`,
    timestamp: index + 1,
    messageId: `mid-${index + 1}`,
  }));

  store.loadPersistedGroupHistories([
    {
      key: 'tgBot:-1002',
      entries,
    },
  ]);

  assert.equal(runtime.groupHistories.get('tgBot:-1002')?.length, 96);
  assert.equal(store.dumpPersistedGroupHistories()[0]?.entries.length, 96);
  assert.equal(store.dumpPersistedGroupHistories()[0]?.entries[0]?.body, 'm25');
  assert.equal(store.dumpPersistedGroupHistories()[0]?.entries[95]?.body, 'm120');
});

test('createBncrStateStore uses a minimum persisted group history cap of 60 for default 50-limit groups', () => {
  const { runtime, store } = createStore();
  runtime.sceneRegistry.set('tgBot:-1003', {
    sceneKey: 'tgBot:-1003',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1003',
    historyLimit: 50,
    historyForce: true,
    lastSeenAt: 1,
  });

  const entries = Array.from({ length: 70 }, (_, index) => ({
    sender: 'alice',
    senderId: '10001',
    body: `d${index + 1}`,
    timestamp: index + 1,
    messageId: `default-mid-${index + 1}`,
  }));

  store.loadPersistedGroupHistories([
    {
      key: 'tgBot:-1003',
      entries,
    },
  ]);

  assert.equal(runtime.groupHistories.get('tgBot:-1003')?.length, 60);
  assert.equal(store.dumpPersistedGroupHistories()[0]?.entries.length, 60);
  assert.equal(store.dumpPersistedGroupHistories()[0]?.entries[0]?.body, 'd11');
  assert.equal(store.dumpPersistedGroupHistories()[0]?.entries[59]?.body, 'd70');
});
