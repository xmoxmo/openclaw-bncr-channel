import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { normalizePersistedOutboxEntry } from '../../src/core/persisted-outbox-entry.ts';
import { removeBncrConversationHistoryMessageIds } from '../../src/messaging/inbound/conversation-history.ts';
import { deleteSceneRecord, resolveSceneRecord } from '../../src/plugin/scene-registry.ts';
import { createBncrSqliteStateDatabase } from '../../src/plugin/sqlite-state.ts';
import { createBncrStateStore } from '../../src/plugin/state-store.ts';

function createStore() {
  let deadLetter = [];
  const conversationHistoryVersions = new Map();
  const runtime = {
    getStatePath: () => null,
    now: () => 1000,
    asString: (value, fallback = '') => (typeof value === 'string' ? value : fallback),
    finiteNumberOr: (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    },
    normalizeAccountId: (accountId) => {
      const value = String(accountId || '').trim();
      return !value || value.toLowerCase() === 'default' || value.toLowerCase() === 'primary'
        ? 'Primary'
        : value;
    },
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
    conversationHistories: new Map(),
    conversationHistoryVersions,
    outboundReplayCache: new Map(),
    outbox: new Map(),
    getDeadLetter: () => deadLetter,
    setDeadLetter: (entries) => {
      deadLetter = entries;
    },
    sessionRoutes: new Map(),
    routeAliases: new Map(),
    lastSessionByAccount: new Map(),
    lastActivityByAccount: new Map(),
    lastInboundByAccount: new Map(),
    lastOutboundByAccount: new Map(),
    getLastDriftSnapshot: () => null,
    setLastDriftSnapshot: () => {},
  };

  return { runtime, store: createBncrStateStore(runtime), conversationHistoryVersions };
}

function buildOutboxEntry(messageId, overrides = {}) {
  return {
    messageId,
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:7467426f743a3130303031',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { message: { msg: `msg ${messageId}` } },
    createdAt: 100,
    retryCount: 0,
    nextAttemptAt: 100,
    ...overrides,
  };
}

function formatCutoverTimestamp(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

test('createBncrStateStore closes sqlite idempotently and reopens on the next lifecycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-lifecycle-'));
  const { runtime, store } = createStore();
  const opened = [];
  runtime.getStatePath = () => join(dir, 'state.json');
  runtime.createSqliteState = () => {
    const fake = {
      closed: false,
      close() {
        if (this.closed) throw new Error('database is not open');
        this.closed = true;
      },
      getStoreMode: () => 'dual',
      saveControlState() {},
      loadHistoryState: () => ({ historyBuckets: [], replayBuckets: [] }),
      getHistoryStateRevision: () => 0,
      saveHistoryState() {},
      isOutboundImported: () => true,
      saveOutboundState() {},
    };
    opened.push(fake);
    return fake;
  };

  try {
    const firstLifecycle = store.beginSqliteLifecycle();
    await store.flushState();
    assert.equal(opened.length, 1);

    assert.equal(await store.closeSqliteLifecycle(firstLifecycle), true);
    assert.equal(await store.closeSqliteLifecycle(firstLifecycle), true);
    assert.equal(opened[0].closed, true);

    const secondLifecycle = store.beginSqliteLifecycle();
    await store.flushState();
    assert.equal(opened.length, 2);
    assert.equal(opened[1].closed, false);

    assert.equal(await store.closeSqliteLifecycle(secondLifecycle), true);
    assert.equal(opened[1].closed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createBncrStateStore closes a sqlite connection that finishes opening after stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-lifecycle-race-'));
  const { runtime, store } = createStore();
  let releaseOpen;
  let markOpenStarted;
  const openStarted = new Promise((resolve) => {
    markOpenStarted = resolve;
  });
  const openGate = new Promise((resolve) => {
    releaseOpen = resolve;
  });
  const opened = {
    closed: false,
    close() {
      this.closed = true;
    },
    getStoreMode: () => 'dual',
    saveControlState() {},
    loadHistoryState: () => ({ historyBuckets: [], replayBuckets: [] }),
    getHistoryStateRevision: () => 0,
    saveHistoryState() {},
    isOutboundImported: () => true,
    saveOutboundState() {},
  };
  runtime.getStatePath = () => join(dir, 'state.json');
  runtime.createSqliteState = async () => {
    markOpenStarted();
    await openGate;
    return opened;
  };

  try {
    store.beginSqliteLifecycle();
    const flushing = store.flushState();
    await openStarted;
    const closing = store.closeSqliteLifecycle();
    releaseOpen();

    await Promise.all([flushing, closing]);
    assert.equal(opened.closed, true);
  } finally {
    releaseOpen?.();
    await rm(dir, { recursive: true, force: true });
  }
});

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
      sessionKey: 'agent:orion:bncr:direct:10001',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      updatedAt: '14',
    },
    {
      accountId: 'B',
      sessionKey: 'agent:public:bncr:group:20002',
      route: { platform: 'wxBot', groupId: '20002', userId: '0' },
      updatedAt: '15',
    },
    {
      accountId: 'C',
      sessionKey: 'legacy-session-1',
      route: { platform: 'tgBot', groupId: '-1002', userId: '10003' },
      updatedAt: '16',
    },
  ]);

  assert.deepEqual(Array.from(runtime.sessionRoutes.entries()), [
    [
      'agent:orion:bncr:direct:10001',
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
      sessionKey: 'agent:orion:bncr:direct:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      updatedAt: '10',
    },
    {
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      route: { platform: 'wxBot', groupId: '0', userId: '20002' },
      updatedAt: '20',
    },
  ]);
  store.backfillAccountActivityFromSessionRoutes();

  assert.equal(runtime.routeAliases.size, 2);
  assert.deepEqual(runtime.lastSessionByAccount.get('Primary'), {
    sessionKey: 'agent:orion:bncr:direct:bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    scope: 'Bncr:wxBot:0:20002',
    updatedAt: 20,
  });
  assert.equal(runtime.lastActivityByAccount.get('Primary'), 20);
  assert.equal(runtime.lastInboundByAccount.get('Primary'), 20);
});

test('createBncrStateStore restores persisted scene registry entries for every agent and skips malformed rows', () => {
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
      agentId: 'orion',
      downloadMedia: true,
      lastSeenAt: '12',
    },
    {
      sceneKey: 'wxBot:20002',
      kind: 'group',
      status: 'denied',
      platform: 'wxBot',
      groupId: '20002',
      agentId: 'public',
      lastSeenAt: 13,
    },
    {
      sceneKey: 'tgBot:-1001',
      kind: 'group',
      status: 'denied',
      platform: 'tgBot',
      groupId: '-1001',
      groupName: 'wind_system',
      groupReplyMode: 'mention',
      downloadMedia: false,
      lastSeenAt: 14,
    },
  ]);

  // Every valid row is restored under its own (agentId, sceneKey) entry, so two
  // agents watching the same chat never displace each other. Malformed rows are
  // the only ones skipped.
  assert.deepEqual(
    Array.from(runtime.sceneRegistry.keys()).sort(),
    ['orion\u0000tgBot:10001', 'public\u0000wxBot:20002', 'tgBot:-1001'].sort(),
  );
  assert.equal(
    resolveSceneRecord(runtime.sceneRegistry, 'tgBot:10001', 'orion')?.downloadMedia,
    true,
  );
  assert.equal(
    resolveSceneRecord(runtime.sceneRegistry, 'wxBot:20002', 'public')?.status,
    'denied',
  );
  assert.equal(resolveSceneRecord(runtime.sceneRegistry, 'tgBot:-1001')?.groupReplyMode, 'mention');
});

test('createBncrStateStore keeps per-agent rows for the same chat and resolves by agent', () => {
  const { runtime, store } = createStore();

  store.loadPersistedSceneRegistry([
    {
      sceneKey: 'tgBot:-1001',
      kind: 'group',
      status: 'denied',
      platform: 'tgBot',
      groupId: '-1001',
      groupReplyMode: 'admin',
      lastSeenAt: 200,
    },
    {
      sceneKey: 'tgBot:-1001',
      kind: 'group',
      status: 'allowed',
      platform: 'tgBot',
      groupId: '-1001',
      agentId: 'public',
      groupReplyMode: 'mention',
      lastSeenAt: 100,
    },
  ]);

  assert.equal(runtime.sceneRegistry.size, 2, 'both rows survive the load');
  const owned = resolveSceneRecord(runtime.sceneRegistry, 'tgBot:-1001', 'public');
  assert.equal(owned?.status, 'allowed');
  assert.equal(owned?.groupReplyMode, 'mention');
  assert.equal(owned?.agentId, 'public');
  const unowned = resolveSceneRecord(runtime.sceneRegistry, 'tgBot:-1001');
  assert.equal(unowned?.status, 'denied');
  assert.equal(unowned?.groupReplyMode, 'admin');
  // An agent without its own row still sees the legacy row instead of nothing.
  assert.equal(resolveSceneRecord(runtime.sceneRegistry, 'tgBot:-1001', 'orion')?.status, 'denied');
});

test('createBncrStateStore keeps every agent scene row through a scoped flush', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-scene-scope-'));
  const statePath = join(dir, 'state.json');
  const dbPath = join(dir, 'state.sqlite3');
  const { runtime, store } = createStore();
  runtime.getStatePath = () => statePath;
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  runtime.sqliteState = sqlite;

  const scene = (agentId, status, groupReplyMode, historyLimit, lastSeenAt) => ({
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status,
    platform: 'tgBot',
    groupId: '-1001',
    agentId,
    groupReplyMode,
    historyLimit,
    lastSeenAt,
  });
  await writeFile(
    statePath,
    JSON.stringify({
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
      sceneRegistry: [
        scene('orion', 'allowed', 'all', 20, 100),
        scene('public', 'denied', 'mention', 60, 200),
      ],
      lastSessionByAccount: [],
      lastActivityByAccount: [],
      lastInboundByAccount: [],
      lastOutboundByAccount: [],
      lastDriftSnapshot: null,
    }),
    'utf8',
  );

  await store.loadState();
  assert.equal(
    resolveSceneRecord(runtime.sceneRegistry, 'tgBot:-1001', 'orion')?.status,
    'allowed',
  );
  assert.equal(
    resolveSceneRecord(runtime.sceneRegistry, 'tgBot:-1001', 'public')?.groupReplyMode,
    'mention',
  );

  // The bridge flushes as its own agent. The other agent's row must survive with
  // its own settings instead of being deleted and replaced by the effective one.
  await store.flushState();
  const reloaded = createBncrSqliteStateDatabase(dbPath);
  const rows = reloaded
    .loadControlState()
    .sceneRegistry.filter((entry) => entry.sceneKey === 'tgBot:-1001')
    .map((entry) => [entry.agentId, entry.status, entry.groupReplyMode, entry.historyLimit])
    .sort();
  assert.deepEqual(rows, [
    ['orion', 'allowed', 'all', 20],
    ['public', 'denied', 'mention', 60],
  ]);
  reloaded.close();
  await store.closeSqliteLifecycle();
  await rm(dir, { recursive: true, force: true });
});

test('createBncrStateStore preserves senderId in persisted conversation histories', () => {
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

  store.loadPersistedConversationHistories([
    {
      key: 'Primary:tgBot:-1001',
      entries: [
        {
          sender: 'alice',
          senderId: '10001',
          role: 'user',
          body: 'hello',
          timestamp: 10,
          messageId: 'm1',
        },
      ],
    },
  ]);

  assert.deepEqual(runtime.conversationHistories.get('Primary:tgBot:-1001'), [
    {
      sender: 'alice',
      senderId: '10001',
      role: 'user',
      body: 'hello',
      timestamp: 10,
      messageId: 'm1',
    },
  ]);
  assert.deepEqual(store.dumpPersistedConversationHistories(), [
    {
      key: 'Primary:tgBot:-1001',
      entries: [
        {
          sender: 'alice',
          senderId: '10001',
          role: 'user',
          body: 'hello',
          timestamp: 10,
          messageId: 'm1',
        },
      ],
    },
  ]);
});

test('createBncrStateStore clears the injected history version tracker on persisted replacement', () => {
  const { store, conversationHistoryVersions } = createStore();
  conversationHistoryVersions.set('Primary:tgBot:10001', 9);

  store.loadPersistedConversationHistories([]);

  assert.equal(conversationHistoryVersions.size, 0);
});

test('createBncrStateStore migrates legacy scene-only history keys to account-scoped keys', () => {
  const { runtime, store } = createStore();
  store.loadPersistedConversationHistories([
    {
      key: 'tgBot:10001',
      entries: [
        {
          sender: 'alice',
          senderId: '10001',
          role: 'user',
          body: 'legacy message',
          timestamp: 10,
          messageId: 'legacy-m1',
        },
      ],
    },
  ]);

  assert.equal(runtime.conversationHistories.has('tgBot:10001'), false);
  assert.deepEqual(runtime.conversationHistories.get('Primary:tgBot:10001'), [
    {
      sender: 'alice',
      senderId: '10001',
      role: 'user',
      body: 'legacy message',
      timestamp: 10,
      messageId: 'legacy-m1',
    },
  ]);
  assert.equal(store.dumpPersistedConversationHistories()[0].key, 'Primary:tgBot:10001');
});

test('createBncrStateStore preserves role in unified direct conversation histories', () => {
  const { runtime, store } = createStore();

  store.loadPersistedConversationHistories([
    {
      key: 'Primary:tgBot:10001',
      entries: [
        {
          sender: 'OpenClaw',
          senderId: 'Primary',
          role: 'assistant',
          body: 'hello from bot',
          timestamp: 10,
          messageId: 'direct-m1',
        },
      ],
    },
  ]);

  assert.deepEqual(runtime.conversationHistories.get('Primary:tgBot:10001'), [
    {
      sender: 'OpenClaw',
      senderId: 'Primary',
      role: 'assistant',
      body: 'hello from bot',
      timestamp: 10,
      messageId: 'direct-m1',
    },
  ]);
  assert.deepEqual(store.dumpPersistedConversationHistories(), [
    {
      key: 'Primary:tgBot:10001',
      entries: [
        {
          sender: 'OpenClaw',
          senderId: 'Primary',
          role: 'assistant',
          body: 'hello from bot',
          timestamp: 10,
          messageId: 'direct-m1',
        },
      ],
    },
  ]);
});

test('createBncrStateStore applies configured direct scene history caps when persisting conversation histories', () => {
  const { runtime, store } = createStore();
  runtime.sceneRegistry.set('tgBot:10001', {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    historyLimit: 80,
    historyForce: true,
    lastSeenAt: 1,
  });

  const entries = Array.from({ length: 120 }, (_, index) => ({
    sender: 'alice',
    senderId: '10001',
    body: `direct-${index + 1}`,
    timestamp: index + 1,
    messageId: `direct-mid-${index + 1}`,
  }));

  store.loadPersistedConversationHistories([
    {
      key: 'Primary:tgBot:10001',
      entries,
    },
  ]);

  assert.equal(runtime.conversationHistories.get('Primary:tgBot:10001')?.length, 96);
  assert.equal(store.dumpPersistedConversationHistories()[0]?.entries.length, 96);
  assert.equal(store.dumpPersistedConversationHistories()[0]?.entries[0]?.body, 'direct-25');
  assert.equal(store.dumpPersistedConversationHistories()[0]?.entries[95]?.body, 'direct-120');
});

test('createBncrStateStore migrates legacy groupHistories state into conversationHistories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-'));
  const statePath = join(dir, 'state.json');
  const { runtime, store } = createStore();
  runtime.getStatePath = () => statePath;

  await writeFile(
    statePath,
    JSON.stringify({
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
      groupHistories: [
        {
          key: 'Primary:tgBot:10001',
          entries: [
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'legacy private chat',
              timestamp: 10,
              messageId: 'legacy-m1',
            },
          ],
        },
      ],
    }),
    'utf8',
  );

  await store.loadState();
  assert.deepEqual(runtime.conversationHistories.get('Primary:tgBot:10001'), [
    {
      sender: 'alice',
      senderId: '10001',
      role: 'user',
      body: 'legacy private chat',
      timestamp: 10,
      messageId: 'legacy-m1',
    },
  ]);

  await store.flushState();
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(persisted.conversationHistories, [
    {
      key: 'Primary:tgBot:10001',
      entries: [
        {
          sender: 'alice',
          senderId: '10001',
          role: 'user',
          body: 'legacy private chat',
          timestamp: 10,
          messageId: 'legacy-m1',
        },
      ],
    },
  ]);
  assert.equal(persisted.groupHistories, undefined);

  await rm(dir, { recursive: true, force: true });
});

test('createBncrStateStore ignores persisted historyLimit zero as an invalid legacy value', () => {
  const { runtime, store } = createStore();

  store.loadPersistedSceneRegistry([
    {
      sceneKey: 'tgBot:10001',
      kind: 'direct',
      status: 'allowed',
      platform: 'tgBot',
      userId: '10001',
      historyLimit: 0,
      lastSeenAt: 1,
    },
  ]);

  assert.equal(resolveSceneRecord(runtime.sceneRegistry, 'tgBot:10001')?.historyLimit, undefined);
});

test('createBncrStateStore ignores persisted historyLimit one as an invalid legacy value', () => {
  const { runtime, store } = createStore();

  store.loadPersistedSceneRegistry([
    {
      sceneKey: 'tgBot:10001',
      kind: 'direct',
      status: 'allowed',
      platform: 'tgBot',
      userId: '10001',
      historyLimit: 1,
      lastSeenAt: 1,
    },
  ]);

  assert.equal(resolveSceneRecord(runtime.sceneRegistry, 'tgBot:10001')?.historyLimit, undefined);
});

test('createBncrStateStore normalizes missing history roles to user', () => {
  const { runtime, store } = createStore();

  store.loadPersistedConversationHistories([
    {
      key: 'Primary:tgBot:10001',
      entries: [
        {
          sender: 'alice',
          senderId: '10001',
          body: 'legacy private chat',
          timestamp: 10,
          messageId: 'legacy-m1',
        },
      ],
    },
  ]);

  assert.deepEqual(runtime.conversationHistories.get('Primary:tgBot:10001'), [
    {
      sender: 'alice',
      senderId: '10001',
      role: 'user',
      body: 'legacy private chat',
      timestamp: 10,
      messageId: 'legacy-m1',
    },
  ]);
  assert.deepEqual(store.dumpPersistedConversationHistories(), [
    {
      key: 'Primary:tgBot:10001',
      entries: [
        {
          sender: 'alice',
          senderId: '10001',
          role: 'user',
          body: 'legacy private chat',
          timestamp: 10,
          messageId: 'legacy-m1',
        },
      ],
    },
  ]);
});

test('createBncrStateStore backfills stable synthetic ids for legacy missing message ids', () => {
  const { runtime, store } = createStore();
  const persisted = [
    {
      key: 'Primary:tgBot:10001',
      entries: [
        {
          sender: 'alice',
          senderId: '10001',
          role: 'user',
          body: 'legacy private chat',
          timestamp: 10,
        },
        {
          sender: 'alice',
          senderId: '10001',
          role: 'user',
          body: 'legacy media chat',
          timestamp: 11,
          media: [{ path: '/tmp/legacy.png', kind: 'image' }],
        },
      ],
    },
  ];

  store.loadPersistedConversationHistories(persisted);
  const firstLoad = runtime.conversationHistories.get('Primary:tgBot:10001') ?? [];
  assert.equal(firstLoad.length, 2);
  assert.match(firstLoad[0].messageId, /^bncr-synthetic:migrated:/);
  assert.match(firstLoad[1].messageId, /^bncr-synthetic:migrated:/);
  assert.equal(firstLoad[1].media?.[0]?.messageId, firstLoad[1].messageId);

  store.loadPersistedConversationHistories(persisted);
  const secondLoad = runtime.conversationHistories.get('Primary:tgBot:10001') ?? [];
  assert.deepEqual(
    secondLoad.map((entry) => entry.messageId),
    firstLoad.map((entry) => entry.messageId),
  );

  const dumped = store.dumpPersistedConversationHistories()[0]?.entries ?? [];
  assert.match(dumped[0].messageId, /^bncr-synthetic:migrated:/);
  assert.equal(dumped[1].media?.[0]?.messageId, dumped[1].messageId);

  removeBncrConversationHistoryMessageIds({
    historyMap: runtime.conversationHistories,
    historyKey: 'Primary:tgBot:10001',
    messageIds: secondLoad.map((entry) => entry.messageId),
  });
  assert.deepEqual(runtime.conversationHistories.get('Primary:tgBot:10001'), []);
});

test('createBncrStateStore aligns legacy outbound replay ids with assistant history', () => {
  const { runtime, store } = createStore();
  store.loadPersistedConversationHistories([
    {
      key: 'Primary:tgBot:10001',
      entries: [
        {
          sender: 'OpenClaw',
          senderId: 'Primary',
          role: 'assistant',
          body: 'legacy bot reply',
          timestamp: 10,
        },
      ],
    },
  ]);
  store.loadPersistedOutboundReplayCache(
    [
      {
        key: 'Primary:tgBot:10001',
        entries: [
          {
            sender: 'OpenClaw',
            senderId: 'Primary',
            body: 'legacy bot reply',
            timestamp: 10,
            accountId: 'Primary',
            route: { platform: 'tgBot', groupId: '0', userId: '10001' },
          },
        ],
      },
    ],
    { historyMap: runtime.conversationHistories },
  );

  const historyMessageId = runtime.conversationHistories.get('Primary:tgBot:10001')?.[0]?.messageId;
  const replayMessageId = runtime.outboundReplayCache.get('Primary:tgBot:10001')?.[0]?.messageId;
  assert.match(historyMessageId, /^bncr-synthetic:migrated:/);
  assert.equal(replayMessageId, historyMessageId);
});

test('createBncrStateStore infers assistant role for legacy histories matched by outbound replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-'));
  const statePath = join(dir, 'state.json');
  const { runtime, store } = createStore();
  runtime.getStatePath = () => statePath;

  await writeFile(
    statePath,
    JSON.stringify({
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
      groupHistories: [
        {
          key: 'Primary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Primary',
              body: 'legacy bot reply',
              timestamp: 10,
              messageId: 'legacy-bot-1',
            },
          ],
        },
      ],
      outboundReplayCache: [
        {
          key: 'Primary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Primary',
              body: 'legacy bot reply',
              timestamp: 10,
              messageId: 'legacy-bot-1',
              accountId: 'Primary',
              sessionKey: 'agent:orion:bncr:direct:demo',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
              createdAt: 10,
            },
          ],
        },
      ],
    }),
    'utf8',
  );

  await store.loadState();
  assert.equal(runtime.conversationHistories.get('Primary:tgBot:10001')?.[0]?.role, 'assistant');

  await rm(dir, { recursive: true, force: true });
});

test('createBncrStateStore scopes assistant role inference to the matching history key', () => {
  const { runtime, store } = createStore();
  const entries = [
    {
      sender: 'alice',
      senderId: '10001',
      body: 'shared message id',
      timestamp: 10,
      messageId: 'shared-m1',
    },
  ];

  store.loadPersistedConversationHistories([{ key: 'Primary:tgBot:10001', entries }], {
    assistantMessageIdsByHistoryKey: new Map([['Primary:tgBot:10002', new Set(['shared-m1'])]]),
  });
  assert.equal(runtime.conversationHistories.get('Primary:tgBot:10001')?.[0]?.role, 'user');

  store.loadPersistedConversationHistories([{ key: 'Primary:tgBot:10001', entries }], {
    assistantMessageIdsByHistoryKey: new Map([['Primary:tgBot:10001', new Set(['shared-m1'])]]),
  });
  assert.equal(runtime.conversationHistories.get('Primary:tgBot:10001')?.[0]?.role, 'assistant');
});

test('createBncrStateStore persists conversation histories up to 1.2x configured scene history limit', () => {
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

  store.loadPersistedConversationHistories([
    {
      key: 'Primary:tgBot:-1002',
      entries,
    },
  ]);

  assert.equal(runtime.conversationHistories.get('Primary:tgBot:-1002')?.length, 96);
  assert.equal(store.dumpPersistedConversationHistories()[0]?.entries.length, 96);
  assert.equal(store.dumpPersistedConversationHistories()[0]?.entries[0]?.body, 'm25');
  assert.equal(store.dumpPersistedConversationHistories()[0]?.entries[95]?.body, 'm120');
});

test('createBncrStateStore uses a minimum persisted conversation history cap of 60 for default 50-limit conversations', () => {
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

  store.loadPersistedConversationHistories([
    {
      key: 'Primary:tgBot:-1003',
      entries,
    },
  ]);

  assert.equal(runtime.conversationHistories.get('Primary:tgBot:-1003')?.length, 60);
  assert.equal(store.dumpPersistedConversationHistories()[0]?.entries.length, 60);
  assert.equal(store.dumpPersistedConversationHistories()[0]?.entries[0]?.body, 'd11');
  assert.equal(store.dumpPersistedConversationHistories()[0]?.entries[59]?.body, 'd70');
});

test('createBncrStateStore bounds persisted outbound replay buckets to the unified window limit', () => {
  const { runtime, store } = createStore();
  runtime.sceneRegistry.set('tgBot:10001', {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    historyLimit: 3,
    historyForce: true,
    lastSeenAt: 1,
  });
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };
  const entries = Array.from({ length: 60 }, (_, index) => ({
    sender: 'OpenClaw',
    senderId: 'Primary',
    body: `m${index + 1}`,
    timestamp: index + 1,
    messageId: `cache-mid-${index + 1}`,
    accountId: 'Primary',
    sessionKey: 'session-1',
    route,
    type: 'text',
    createdAt: index + 1,
    status: 'acked',
  }));
  entries.reverse();

  store.loadPersistedOutboundReplayCache([
    {
      key: 'Primary:tgBot:10001',
      entries,
    },
  ]);

  assert.equal(runtime.outboundReplayCache.get('Primary:tgBot:10001')?.length, 3);
  assert.equal(store.dumpPersistedOutboundReplayCache()[0]?.entries.length, 3);
  assert.equal(store.dumpPersistedOutboundReplayCache()[0]?.entries[0]?.body, 'm58');
  assert.equal(store.dumpPersistedOutboundReplayCache()[0]?.entries[2]?.body, 'm60');
  assert.equal(store.dumpPersistedOutboundReplayCache()[0]?.entries[0]?.sessionKey, 'session-1');
  assert.equal(store.dumpPersistedOutboundReplayCache()[0]?.entries[0]?.status, 'acked');
});

test('createBncrStateStore normalizes legacy outbound replay cache keys', () => {
  const { runtime, store } = createStore();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };
  store.loadPersistedOutboundReplayCache([
    {
      key: 'tgBot:10001',
      entries: [
        {
          sender: 'OpenClaw',
          senderId: 'Primary',
          body: 'legacy outbound',
          timestamp: 10,
          messageId: 'legacy-replay-1',
          accountId: 'Primary',
          route,
        },
      ],
    },
  ]);

  assert.equal(runtime.outboundReplayCache.has('tgBot:10001'), false);
  assert.equal(
    runtime.outboundReplayCache.get('Primary:tgBot:10001')?.[0]?.messageId,
    'legacy-replay-1',
  );
  assert.equal(store.dumpPersistedOutboundReplayCache()[0].key, 'Primary:tgBot:10001');
});

test('createBncrStateStore canonicalizes default account aliases in persisted keys', () => {
  const { runtime, store } = createStore();
  store.loadPersistedConversationHistories([
    {
      key: 'default:tgBot:10001',
      entries: [{ sender: 'alice', body: 'legacy default', messageId: 'default-history-1' }],
    },
  ]);
  store.loadPersistedOutboundReplayCache([
    {
      key: 'primary:tgBot:10001',
      entries: [
        {
          sender: 'OpenClaw',
          body: 'legacy primary',
          messageId: 'primary-replay-1',
          accountId: 'default',
          route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        },
      ],
    },
  ]);

  assert.equal(runtime.conversationHistories.has('default:tgBot:10001'), false);
  assert.equal(
    runtime.conversationHistories.get('Primary:tgBot:10001')?.[0]?.messageId,
    'default-history-1',
  );
  assert.equal(runtime.outboundReplayCache.has('primary:tgBot:10001'), false);
  assert.equal(
    runtime.outboundReplayCache.get('Primary:tgBot:10001')?.[0]?.messageId,
    'primary-replay-1',
  );
  assert.equal(runtime.outboundReplayCache.get('Primary:tgBot:10001')?.[0]?.accountId, 'Primary');
});

test('createBncrStateStore keeps account-scoped entries separate in a legacy replay bucket', () => {
  const { runtime, store } = createStore();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };
  store.loadPersistedOutboundReplayCache([
    {
      key: 'tgBot:10001',
      entries: [
        {
          sender: 'PrimaryBot',
          senderId: 'Primary',
          body: 'primary outbound',
          timestamp: 10,
          messageId: 'primary-replay-1',
          accountId: 'Primary',
          route,
        },
        {
          sender: 'SecondaryBot',
          senderId: 'Secondary',
          body: 'secondary outbound',
          timestamp: 20,
          messageId: 'secondary-replay-1',
          accountId: 'Secondary',
          route,
        },
      ],
    },
  ]);

  assert.deepEqual(
    runtime.outboundReplayCache.get('Primary:tgBot:10001')?.map((entry) => entry.messageId),
    ['primary-replay-1'],
  );
  assert.deepEqual(
    runtime.outboundReplayCache.get('Secondary:tgBot:10001')?.map((entry) => entry.messageId),
    ['secondary-replay-1'],
  );
});

test('createBncrStateStore separates account-scoped replay entries without routes', () => {
  const { runtime, store } = createStore();
  store.loadPersistedOutboundReplayCache([
    {
      key: 'tgBot:10001',
      entries: [
        {
          sender: 'PrimaryBot',
          body: 'primary outbound',
          messageId: 'primary-no-route-1',
          accountId: 'Primary',
        },
        {
          sender: 'SecondaryBot',
          body: 'secondary outbound',
          messageId: 'secondary-no-route-1',
          accountId: 'Secondary',
        },
      ],
    },
  ]);

  assert.deepEqual(
    runtime.outboundReplayCache.get('Primary:tgBot:10001')?.map((entry) => entry.messageId),
    ['primary-no-route-1'],
  );
  assert.deepEqual(
    runtime.outboundReplayCache.get('Secondary:tgBot:10001')?.map((entry) => entry.messageId),
    ['secondary-no-route-1'],
  );
});

test('createBncrStateStore infers assistant role for account-scoped replay without routes', () => {
  const { runtime, store } = createStore();
  store.loadPersistedConversationHistories([
    {
      key: 'Secondary:tgBot:10001',
      entries: [
        {
          sender: 'SecondaryBot',
          senderId: 'Secondary',
          body: 'secondary reply',
          messageId: 'secondary-no-route-role-1',
        },
      ],
    },
  ]);
  store.loadPersistedOutboundReplayCache(
    [
      {
        key: 'tgBot:10001',
        entries: [
          {
            sender: 'SecondaryBot',
            senderId: 'Secondary',
            body: 'secondary reply',
            messageId: 'secondary-no-route-role-1',
            accountId: 'Secondary',
          },
        ],
      },
    ],
    { historyMap: runtime.conversationHistories },
  );

  store.loadPersistedConversationHistories(
    [
      {
        key: 'Secondary:tgBot:10001',
        entries: [
          {
            sender: 'SecondaryBot',
            senderId: 'Secondary',
            body: 'secondary reply',
            messageId: 'secondary-no-route-role-1',
          },
        ],
      },
    ],
    {
      assistantMessageIdsByHistoryKey: new Map([
        ['Secondary:tgBot:10001', new Set(['secondary-no-route-role-1'])],
      ]),
    },
  );
  assert.equal(runtime.conversationHistories.get('Secondary:tgBot:10001')?.[0]?.role, 'assistant');
});

test('createBncrStateStore preserves an account-scoped replay bucket when an entry omits accountId', () => {
  const { runtime, store } = createStore();
  store.loadPersistedOutboundReplayCache([
    {
      key: 'Secondary:tgBot:10001',
      entries: [
        {
          sender: 'SecondaryBot',
          senderId: 'Secondary',
          body: 'secondary outbound',
          timestamp: 10,
          messageId: 'secondary-replay-no-account-1',
          route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        },
      ],
    },
  ]);

  assert.equal(runtime.outboundReplayCache.has('Primary:tgBot:10001'), false);
  assert.equal(
    runtime.outboundReplayCache.get('Secondary:tgBot:10001')?.[0]?.messageId,
    'secondary-replay-no-account-1',
  );
  assert.equal(
    runtime.outboundReplayCache.get('Secondary:tgBot:10001')?.[0]?.accountId,
    'Secondary',
  );
});

test('createBncrStateStore imports controls into sqlite and prefers sqlite over stale json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-sqlite-'));
  const statePath = join(dir, 'state.json');
  const dbPath = join(dir, 'state.sqlite3');
  const { runtime, store } = createStore();
  runtime.getStatePath = () => statePath;
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  runtime.sqliteState = sqlite;

  const persisted = {
    outbox: [],
    deadLetter: [],
    sessionRoutes: [
      {
        sessionKey: 'session-1',
        accountId: 'Primary',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        updatedAt: 10,
      },
    ],
    sceneRegistry: [
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        userName: 'alice',
        agentId: 'orion',
        downloadMedia: true,
        lastSeenAt: 20,
      },
    ],
    conversationHistories: [
      {
        key: 'Primary:tgBot:10001',
        entries: [
          { sender: 'alice', senderId: '10001', role: 'user', body: 'hello', messageId: 'h1' },
        ],
      },
    ],
    outboundReplayCache: [
      {
        key: 'Primary:tgBot:10001',
        entries: [
          {
            sender: 'OpenClaw',
            senderId: 'Primary',
            body: 'bot reply',
            messageId: 'h2',
            accountId: 'Primary',
            sessionKey: 'session-1',
            route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            createdAt: 25,
          },
        ],
      },
    ],
    lastSessionByAccount: [
      { accountId: 'Primary', sessionKey: 'session-1', scope: 'Bncr:tgBot:0:10001', updatedAt: 30 },
    ],
    lastActivityByAccount: [{ accountId: 'Primary', updatedAt: 40 }],
    lastInboundByAccount: [{ accountId: 'Primary', updatedAt: 41 }],
    lastOutboundByAccount: [{ accountId: 'Primary', updatedAt: 42 }],
    lastDriftSnapshot: null,
  };
  await writeFile(statePath, JSON.stringify(persisted), 'utf8');

  await store.loadState();
  assert.equal(sqlite.isControlStateImported(), true);
  assert.equal(
    sqlite.getMeta('legacy_json_sha256'),
    createHash('sha256')
      .update(await readFile(statePath))
      .digest('hex'),
  );
  assert.equal(sqlite.isHistoryImported(), true);
  assert.equal(sqlite.loadHistoryState().historyBuckets[0].entries.length, 1);
  assert.equal(sqlite.loadHistoryState().replayBuckets[0].entries.length, 1);
  assert.equal(resolveSceneRecord(runtime.sceneRegistry, 'tgBot:10001')?.agentId, 'orion');
  assert.equal(resolveSceneRecord(runtime.sceneRegistry, 'tgBot:10001')?.downloadMedia, true);

  persisted.sceneRegistry[0].agentId = 'stale-json-agent';
  persisted.conversationHistories[0].entries[0].body = 'stale-json-history';
  await writeFile(statePath, JSON.stringify(persisted), 'utf8');
  await store.loadState();
  assert.equal(resolveSceneRecord(runtime.sceneRegistry, 'tgBot:10001')?.agentId, 'orion');
  assert.equal(runtime.conversationHistories.get('Primary:tgBot:10001')?.[0]?.body, 'hello');

  await store.flushState();
  const writtenJson = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(writtenJson.sceneRegistry[0].agentId, 'orion');
  assert.equal(writtenJson.sceneRegistry[0].downloadMedia, true);
  assert.equal(writtenJson.conversationHistories[0].entries[0].body, 'hello');
  assert.equal(writtenJson.outboundReplayCache[0].entries[0].body, 'bot reply');
  assert.equal(sqlite.loadControlState().sceneRegistry[0].agentId, 'orion');

  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

test('dual-mode json mirror keeps another agent scene rows written by a newer flush', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-dual-merge-'));
  const statePath = join(dir, 'state.json');
  const sqlite = createBncrSqliteStateDatabase(join(dir, 'state.sqlite3'));
  sqlite.setStoreMode('dual');

  try {
    const first = createStore();
    first.runtime.getStatePath = () => statePath;
    first.runtime.sqliteState = sqlite;
    first.runtime.sceneRegistry.set('orion\u0000tgBot:-1001', {
      sceneKey: 'tgBot:-1001',
      kind: 'group',
      status: 'allowed',
      platform: 'tgBot',
      groupId: '-1001',
      agentId: 'orion',
      downloadMedia: false,
      lastSeenAt: 100,
    });
    await first.store.flushState();

    const second = createStore();
    second.runtime.getStatePath = () => statePath;
    second.runtime.sqliteState = sqlite;
    second.runtime.canonicalAgentId = () => 'public';
    second.runtime.sceneRegistry.set('public\u0000tgBot:-2002', {
      sceneKey: 'tgBot:-2002',
      kind: 'group',
      status: 'allowed',
      platform: 'tgBot',
      groupId: '-2002',
      agentId: 'public',
      lastSeenAt: 200,
    });
    await second.store.flushState();

    const written = JSON.parse(await readFile(statePath, 'utf8'));
    const rows = written.sceneRegistry
      .map((scene) => [scene.agentId, scene.sceneKey])
      .sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`));
    assert.deepEqual(rows, [
      ['orion', 'tgBot:-1001'],
      ['public', 'tgBot:-2002'],
    ]);
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('createBncrStateStore stale memory flush cannot reactivate consumed history messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-sqlite-stale-memory-'));
  const dbPath = join(dir, 'state.sqlite3');
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  try {
    const { runtime: activeRuntime, store: activeStore } = createStore();
    activeRuntime.sqliteState = sqlite;
    await activeStore.loadState();

    const historyBucket = [
      {
        sender: 'alice',
        senderId: '10001',
        role: 'user',
        body: 'hello',
        timestamp: 110,
        messageId: 'h1',
      },
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        role: 'assistant',
        body: 'bot reply',
        timestamp: 120,
        messageId: 'h2',
      },
      {
        sender: 'alice',
        senderId: '10001',
        role: 'user',
        body: 'after stale snapshot',
        timestamp: 130,
        messageId: 'h3',
      },
    ];
    const replayBucket = [
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        body: 'bot reply',
        timestamp: 120,
        messageId: 'h2',
        accountId: 'Primary',
        sessionKey: 'session-1',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        createdAt: 120,
      },
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        body: 'after stale snapshot',
        timestamp: 130,
        messageId: 'h3',
        accountId: 'Primary',
        sessionKey: 'session-1',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        createdAt: 130,
      },
    ];
    activeRuntime.conversationHistories.set('Primary:tgBot:10001', historyBucket);
    activeRuntime.outboundReplayCache.set('Primary:tgBot:10001', replayBucket);
    await activeStore.flushState();

    const { shardId } = activeStore.createHistoryShard({
      historyKey: 'Primary:tgBot:10001',
      accountId: 'Primary',
      payloadJson: '{"context":"active-snapshot"}',
      messageIds: ['h1', 'h2', 'h3'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    activeStore.historyShardQueue.markHistoryShardProcessing(shardId);
    activeStore.completeHistoryShard(shardId);
    assert.deepEqual(sqlite.loadHistoryState(), {
      historyBuckets: [],
      replayBuckets: [],
    });

    const { runtime: staleRuntime, store: staleStore } = createStore();
    staleRuntime.sqliteState = sqlite;
    staleRuntime.conversationHistories.set('Primary:tgBot:10001', historyBucket);
    staleRuntime.outboundReplayCache.set('Primary:tgBot:10001', replayBucket);
    await staleStore.flushState();

    const restored = sqlite.loadHistoryState();
    assert.equal(restored.historyBuckets.length, 0);
    assert.equal(restored.replayBuckets.length, 0);
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('createBncrStateStore stale flush preserves another instance active history rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-sqlite-stale-active-merge-'));
  const dbPath = join(dir, 'state.sqlite3');
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  try {
    const { runtime: activeRuntime, store: activeStore } = createStore();
    activeRuntime.sqliteState = sqlite;
    await activeStore.loadState();
    activeRuntime.conversationHistories.set('Primary:tgBot:10001', [
      {
        sender: 'alice',
        senderId: '10001',
        role: 'user',
        body: 'hello one',
        timestamp: 110,
        messageId: 'active-h1',
      },
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        role: 'assistant',
        body: 'bot reply',
        timestamp: 120,
        messageId: 'active-h2',
      },
    ]);
    activeRuntime.outboundReplayCache.set('Primary:tgBot:10001', [
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        body: 'bot reply',
        timestamp: 120,
        messageId: 'active-h2',
        accountId: 'Primary',
        sessionKey: 'session-1',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        createdAt: 120,
      },
    ]);
    await activeStore.flushState();

    const { runtime: staleRuntime, store: staleStore } = createStore();
    staleRuntime.sqliteState = sqlite;
    staleRuntime.conversationHistories.set('Primary:tgBot:10001', [
      {
        sender: 'alice',
        senderId: '10001',
        role: 'user',
        body: 'hello three',
        timestamp: 130,
        messageId: 'stale-h3',
      },
    ]);
    staleRuntime.outboundReplayCache.set('Primary:tgBot:10001', [
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        body: 'after stale snapshot',
        timestamp: 130,
        messageId: 'stale-h3',
        accountId: 'Primary',
        sessionKey: 'session-1',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        createdAt: 130,
      },
    ]);
    await staleStore.flushState();

    const restored = sqlite.loadHistoryState();
    assert.deepEqual(
      restored.historyBuckets[0].entries.map((entry) => entry.messageId),
      ['active-h1', 'active-h2', 'stale-h3'],
    );
    assert.deepEqual(
      restored.replayBuckets[0].entries.map((entry) => entry.messageId),
      ['active-h2', 'stale-h3'],
    );
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('createBncrStateStore retries history flush after a concurrent revision conflict', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-sqlite-revision-retry-'));
  const dbPath = join(dir, 'state.sqlite3');
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  try {
    const { runtime: activeRuntime, store: activeStore } = createStore();
    activeRuntime.sqliteState = sqlite;
    await activeStore.loadState();
    activeRuntime.conversationHistories.set('Primary:tgBot:10001', [
      {
        sender: 'alice',
        senderId: '10001',
        role: 'user',
        body: 'hello one',
        timestamp: 110,
        messageId: 'revision-h1',
      },
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        role: 'assistant',
        body: 'bot reply',
        timestamp: 120,
        messageId: 'revision-h2',
      },
    ]);
    activeRuntime.outboundReplayCache.set('Primary:tgBot:10001', [
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        body: 'bot reply',
        timestamp: 120,
        messageId: 'revision-h2',
        accountId: 'Primary',
        sessionKey: 'session-1',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        createdAt: 120,
      },
    ]);
    await activeStore.flushState();

    const { runtime: staleRuntime, store: staleStore } = createStore();
    let returnStaleRevision = true;
    const wrappedSqlite = {
      ...sqlite,
      getHistoryStateRevision: () => {
        if (returnStaleRevision) {
          returnStaleRevision = false;
          return sqlite.getHistoryStateRevision() - 1;
        }
        return sqlite.getHistoryStateRevision();
      },
    };
    staleRuntime.sqliteState = wrappedSqlite;
    staleRuntime.conversationHistories.set('Primary:tgBot:10001', [
      {
        sender: 'alice',
        senderId: '10001',
        role: 'user',
        body: 'hello three',
        timestamp: 130,
        messageId: 'revision-h3',
      },
    ]);
    staleRuntime.outboundReplayCache.set('Primary:tgBot:10001', [
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        body: 'after revision retry',
        timestamp: 130,
        messageId: 'revision-h3',
        accountId: 'Primary',
        sessionKey: 'session-1',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        createdAt: 130,
      },
    ]);

    await staleStore.flushState();

    const restored = sqlite.loadHistoryState();
    assert.deepEqual(
      restored.historyBuckets[0].entries.map((entry) => entry.messageId),
      ['revision-h1', 'revision-h2', 'revision-h3'],
    );
    assert.deepEqual(
      restored.replayBuckets[0].entries.map((entry) => entry.messageId),
      ['revision-h2', 'revision-h3'],
    );
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('createBncrStateStore reconcile memory drops consumed history before snapshot build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-sqlite-reconcile-memory-'));
  const dbPath = join(dir, 'state.sqlite3');
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  try {
    const { runtime: activeRuntime, store: activeStore } = createStore();
    activeRuntime.sqliteState = sqlite;
    await activeStore.loadState();

    const historyEntries = [
      {
        sender: 'alice',
        senderId: '10001',
        role: 'user',
        body: 'hello',
        timestamp: 110,
        messageId: 'reconcile-h1',
      },
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        role: 'assistant',
        body: 'bot reply',
        timestamp: 120,
        messageId: 'reconcile-h2',
      },
      {
        sender: 'alice',
        senderId: '10001',
        role: 'user',
        body: 'fresh',
        timestamp: 130,
        messageId: 'reconcile-h4',
      },
    ];
    const replayEntries = [
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        body: 'bot reply',
        timestamp: 120,
        messageId: 'reconcile-h2',
        accountId: 'Primary',
        sessionKey: 'session-1',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        createdAt: 120,
      },
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        body: 'fresh',
        timestamp: 130,
        messageId: 'reconcile-h4',
        accountId: 'Primary',
        sessionKey: 'session-1',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        createdAt: 130,
      },
    ];
    activeRuntime.conversationHistories.set('Primary:tgBot:10001', [
      ...historyEntries,
      {
        sender: 'alice',
        senderId: '10001',
        role: 'user',
        body: 'consumed',
        timestamp: 125,
        messageId: 'reconcile-h3',
      },
    ]);
    activeRuntime.outboundReplayCache.set('Primary:tgBot:10001', [
      ...replayEntries,
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        body: 'consumed',
        timestamp: 125,
        messageId: 'reconcile-h3',
        accountId: 'Primary',
        sessionKey: 'session-1',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        createdAt: 125,
      },
    ]);
    await activeStore.flushState();
    const { shardId } = activeStore.createHistoryShard({
      historyKey: 'Primary:tgBot:10001',
      accountId: 'Primary',
      payloadJson: '{"context":"consumed"}',
      messageIds: ['reconcile-h3'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    activeStore.historyShardQueue.markHistoryShardProcessing(shardId);
    activeStore.completeHistoryShard(shardId);

    const { runtime: staleRuntime, store: staleStore } = createStore();
    staleRuntime.sqliteState = sqlite;
    staleRuntime.conversationHistories.set('Primary:tgBot:10001', [
      ...historyEntries,
      {
        sender: 'alice',
        senderId: '10001',
        role: 'user',
        body: 'consumed',
        timestamp: 125,
        messageId: 'reconcile-h3',
      },
    ]);
    staleRuntime.outboundReplayCache.set('Primary:tgBot:10001', [
      ...replayEntries,
      {
        sender: 'OpenClaw',
        senderId: 'Primary',
        body: 'consumed',
        timestamp: 125,
        messageId: 'reconcile-h3',
        accountId: 'Primary',
        sessionKey: 'session-1',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        createdAt: 125,
      },
    ]);
    await staleStore.historyShardQueue.reconcileHistoryMemory('tgBot:10001');

    const restored = sqlite.loadHistoryState();
    assert.deepEqual(
      staleRuntime.conversationHistories
        .get('Primary:tgBot:10001')
        ?.map((entry) => entry.messageId),
      ['reconcile-h1', 'reconcile-h2', 'reconcile-h4'],
    );
    assert.deepEqual(
      staleRuntime.outboundReplayCache.get('Primary:tgBot:10001')?.map((entry) => entry.messageId),
      ['reconcile-h2', 'reconcile-h4'],
    );
    assert.deepEqual(
      restored.historyBuckets[0].entries.map((entry) => entry.messageId),
      ['reconcile-h1', 'reconcile-h2', 'reconcile-h4'],
    );
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('createBncrStateStore cutoverToSqlite refuses outstanding history shards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-sqlite-cutover-shard-'));
  const statePath = join(dir, 'state.json');
  const dbPath = join(dir, 'state.sqlite3');
  const { runtime, store } = createStore();
  runtime.getStatePath = () => statePath;
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  runtime.sqliteState = sqlite;

  await writeFile(
    statePath,
    JSON.stringify({
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
      conversationHistories: [
        {
          key: 'Primary:tgBot:10001',
          entries: [
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'hello',
              timestamp: 1,
              messageId: 'shard-h1',
            },
          ],
        },
      ],
      outboundReplayCache: [],
    }),
    'utf8',
  );
  await store.loadState();
  const { shardId } = store.createHistoryShard({
    historyKey: 'Primary:tgBot:10001',
    payloadJson: '{"context":"pending"}',
    messageIds: ['shard-h1'],
    bufferKeys: [],
  });
  store.historyShardQueue.markHistoryShardProcessing(shardId);

  await assert.rejects(store.cutoverToSqlite(), /no outstanding history shards/);
  assert.equal(sqlite.getStoreMode(), 'dual');

  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

test('createBncrStateStore recovers in-flight history shards before a reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-sqlite-recover-'));
  const statePath = join(dir, 'state.json');
  const dbPath = join(dir, 'state.sqlite3');
  const { runtime, store } = createStore();
  runtime.getStatePath = () => statePath;
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  runtime.sqliteState = sqlite;

  await writeFile(
    statePath,
    JSON.stringify({
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
      conversationHistories: [
        {
          key: 'Primary:tgBot:10001',
          entries: [
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'hello',
              timestamp: 1,
              messageId: 'recover-h1',
            },
          ],
        },
      ],
      outboundReplayCache: [],
    }),
    'utf8',
  );
  await store.loadState();

  const { shardId } = store.createHistoryShard({
    historyKey: 'Primary:tgBot:10001',
    payloadJson: '{"context":"pending"}',
    messageIds: ['recover-h1'],
    bufferKeys: [],
  });
  store.historyShardQueue.markHistoryShardProcessing(shardId);
  assert.equal(sqlite.listHistoryShards()[0].status, 'processing');

  assert.equal(await store.recoverInFlightHistoryShards(), 1);
  assert.equal(sqlite.listHistoryShards()[0].status, 'queued');

  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

test('createBncrStateStore restores terminal shard messages into the active window immediately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-sqlite-terminal-'));
  const statePath = join(dir, 'state.json');
  const dbPath = join(dir, 'state.sqlite3');
  const { runtime, store } = createStore();
  runtime.getStatePath = () => statePath;
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  runtime.sqliteState = sqlite;

  await writeFile(
    statePath,
    JSON.stringify({
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
      conversationHistories: [
        {
          key: 'Primary:tgBot:10001',
          entries: [
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'terminal history',
              timestamp: 1,
              messageId: 'terminal-h1',
            },
          ],
        },
      ],
      outboundReplayCache: [
        {
          key: 'Primary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Primary',
              body: 'terminal bot reply',
              messageId: 'terminal-h2',
              accountId: 'Primary',
              sessionKey: 'session-1',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
              createdAt: 2,
            },
          ],
        },
      ],
    }),
    'utf8',
  );
  await store.loadState();

  const { shardId } = store.createHistoryShard({
    historyKey: 'Primary:tgBot:10001',
    payloadJson: '{"context":"terminal"}',
    messageIds: ['terminal-h1', 'terminal-h2'],
    bufferKeys: ['Primary:tgBot:10001'],
  });
  runtime.conversationHistories.set('Primary:tgBot:10001', []);
  runtime.outboundReplayCache.set('Primary:tgBot:10001', []);

  let terminalResult;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    store.historyShardQueue.markHistoryShardProcessing(shardId);
    terminalResult = store.historyShardQueue.markHistoryShardFailed(
      shardId,
      new Error(`terminal ${attempt + 1}`),
    );
  }

  assert.equal(terminalResult.terminal, true);
  assert.deepEqual(
    runtime.conversationHistories.get('Primary:tgBot:10001')?.map((entry) => entry.messageId),
    ['terminal-h1'],
  );
  assert.deepEqual(
    runtime.outboundReplayCache.get('Primary:tgBot:10001')?.map((entry) => entry.messageId),
    ['terminal-h2'],
  );
  assert.equal(sqlite.listHistoryShards().length, 0);

  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

test('createBncrStateStore persists outbound mutations into sqlite during flush', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-sqlite-outbox-flush-'));
  const statePath = join(dir, 'state.json');
  const dbPath = join(dir, 'state.sqlite3');
  const { runtime, store } = createStore();
  runtime.getStatePath = () => statePath;
  runtime.normalizePersistedOutboxEntry = (entry) =>
    normalizePersistedOutboxEntry({
      entry,
      canonicalAgentId: 'orion',
      now: () => 1000,
    });
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  runtime.sqliteState = sqlite;

  await writeFile(
    statePath,
    JSON.stringify({ outbox: [], deadLetter: [], sessionRoutes: [] }),
    'utf8',
  );
  await store.loadState();

  runtime.outbox.set('queued-1', buildOutboxEntry('queued-1'));
  runtime.setDeadLetter([buildOutboxEntry('dead-1', { lastError: 'fatal' })]);
  await store.flushState();

  const loaded = sqlite.loadOutboundState();
  assert.deepEqual(
    loaded.outbox.map((entry) => entry.messageId),
    ['queued-1'],
  );
  assert.deepEqual(
    loaded.deadLetter.map((entry) => entry.messageId),
    ['dead-1'],
  );

  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

test('createBncrStateStore imports outbound state and prefers sqlite while backfilling json rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-sqlite-outbound-'));
  const statePath = join(dir, 'state.json');
  const dbPath = join(dir, 'state.sqlite3');
  const { runtime, store } = createStore();
  runtime.getStatePath = () => statePath;
  runtime.normalizePersistedOutboxEntry = (entry) =>
    normalizePersistedOutboxEntry({
      entry,
      canonicalAgentId: 'orion',
      now: () => 1000,
    });
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  runtime.sqliteState = sqlite;

  const same = buildOutboxEntry('same', { retryCount: 0 });
  const jsonOnly = buildOutboxEntry('json-only');
  const jsonDead = buildOutboxEntry('json-dead', { lastError: 'json-dead' });
  const persisted = {
    outbox: [same, jsonOnly],
    deadLetter: [jsonDead],
    sessionRoutes: [],
  };
  await writeFile(statePath, JSON.stringify(persisted), 'utf8');

  await store.loadState();
  assert.equal(sqlite.isOutboundImported(), true);
  assert.equal(runtime.outbox.size, 2);
  assert.equal(runtime.outbox.get('same')?.retryCount, 0);
  assert.deepEqual(
    runtime.getDeadLetter().map((entry) => entry.messageId),
    ['json-dead'],
  );

  sqlite.saveOutboundState(
    [buildOutboxEntry('same', { retryCount: 3, nextAttemptAt: 300 })],
    [buildOutboxEntry('sqlite-dead', { lastError: 'sqlite-dead' })],
  );
  await store.loadState();

  assert.equal(runtime.outbox.size, 2);
  assert.equal(runtime.outbox.get('same')?.retryCount, 3);
  assert.equal(runtime.outbox.has('json-only'), true);
  assert.deepEqual(
    runtime.getDeadLetter().map((entry) => entry.messageId),
    ['sqlite-dead', 'json-dead'],
  );

  const reconciled = sqlite.loadOutboundState();
  assert.deepEqual(reconciled.outbox.map((entry) => entry.messageId).sort(), ['json-only', 'same']);
  assert.deepEqual(
    reconciled.deadLetter.map((entry) => entry.messageId),
    ['sqlite-dead', 'json-dead'],
  );
  assert.equal(reconciled.outbox.find((entry) => entry.messageId === 'same')?.retryCount, 3);

  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

test('createBncrStateStore supports asynchronously created sqlite backends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-sqlite-async-'));
  const statePath = join(dir, 'state.json');
  const dbPath = join(dir, 'state.sqlite3');
  const { runtime, store } = createStore();
  runtime.getStatePath = () => statePath;
  runtime.createSqliteState = async (path) => {
    assert.equal(path, statePath);
    return createBncrSqliteStateDatabase(dbPath);
  };

  const persisted = {
    outbox: [],
    deadLetter: [],
    sessionRoutes: [],
    sceneRegistry: [
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        userName: 'alice',
        agentId: 'orion',
        lastSeenAt: 20,
      },
    ],
    lastSessionByAccount: [],
    lastActivityByAccount: [],
    lastInboundByAccount: [],
    lastOutboundByAccount: [],
    lastDriftSnapshot: null,
  };
  await writeFile(statePath, JSON.stringify(persisted), 'utf8');

  await store.loadState();
  assert.equal(resolveSceneRecord(runtime.sceneRegistry, 'tgBot:10001')?.agentId, 'orion');

  await store.flushState();
  const writtenJson = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(writtenJson.sceneRegistry[0].agentId, 'orion');

  const sqlite = createBncrSqliteStateDatabase(dbPath);
  assert.equal(sqlite.loadControlState().sceneRegistry[0].agentId, 'orion');
  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

test('createBncrStateStore cutoverToSqlite backs up json and stops rewriting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-sqlite-cutover-'));
  const statePath = join(dir, 'state.json');
  const dbPath = join(dir, 'state.sqlite3');
  const { runtime, store } = createStore();
  runtime.getStatePath = () => statePath;
  runtime.normalizePersistedOutboxEntry = (entry) =>
    normalizePersistedOutboxEntry({
      entry,
      canonicalAgentId: 'orion',
      now: () => 1000,
    });
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  runtime.sqliteState = sqlite;

  const persisted = {
    outbox: [buildOutboxEntry('cutover-1')],
    deadLetter: [buildOutboxEntry('cutover-dead', { lastError: 'fatal' })],
    sessionRoutes: [],
    sceneRegistry: [
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        userName: 'alice',
        agentId: 'orion',
        lastSeenAt: 1,
      },
    ],
    conversationHistories: [
      {
        key: 'Primary:tgBot:10001',
        entries: [
          {
            sender: 'alice',
            senderId: '10001',
            role: 'user',
            body: 'hello',
            timestamp: 1,
            messageId: 'cutover-h1',
          },
        ],
      },
    ],
    outboundReplayCache: [],
    lastSessionByAccount: [],
    lastActivityByAccount: [],
    lastInboundByAccount: [],
    lastOutboundByAccount: [],
    lastDriftSnapshot: null,
  };
  await writeFile(statePath, JSON.stringify(persisted), 'utf8');

  await store.loadState();
  const result = await store.cutoverToSqlite();

  assert.equal(sqlite.getStoreMode(), 'sqlite');
  assert.equal(result.storeMode, 'sqlite');
  assert.match(result.backupPath, /state\.pre-sqlite-\d{14}\.json$/);
  assert.equal(sqlite.getMeta('sqlite_cutover_backup_path'), result.backupPath);
  await assert.rejects(readFile(statePath, 'utf8'));
  const backup = JSON.parse(await readFile(result.backupPath, 'utf8'));
  assert.equal(backup.outbox[0].messageId, 'cutover-1');
  assert.equal(backup.deadLetter[0].messageId, 'cutover-dead');

  await store.flushState();
  await assert.rejects(readFile(statePath, 'utf8'));
  assert.equal(sqlite.loadOutboundState().outbox[0].messageId, 'cutover-1');

  await writeFile(
    statePath,
    JSON.stringify({
      outbox: [buildOutboxEntry('stale-json')],
      deadLetter: [],
      sessionRoutes: [],
    }),
    'utf8',
  );
  await store.loadState();
  assert.equal(runtime.outbox.has('cutover-1'), true);
  assert.equal(runtime.outbox.has('stale-json'), false);
  await store.flushState();
  const untouchedJson = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(untouchedJson.outbox[0].messageId, 'stale-json');

  const exported = await store.exportSqliteStateToJson();
  assert.equal(exported.outbox[0].messageId, 'cutover-1');
  assert.equal(exported.deadLetter[0].messageId, 'cutover-dead');
  assert.equal(exported.conversationHistories[0].entries[0].body, 'hello');

  sqlite.close();

  const collisionStatePath = join(dir, 'collision-state.json');
  const collisionDbPath = join(dir, 'collision-state.sqlite3');
  const collisionBasePath = join(
    dir,
    `collision-state.pre-sqlite-${formatCutoverTimestamp(1000)}.json`,
  );
  await writeFile(collisionStatePath, JSON.stringify(persisted), 'utf8');
  await writeFile(collisionBasePath, 'existing-backup', 'utf8');
  const collisionFixture = createStore();
  collisionFixture.runtime.getStatePath = () => collisionStatePath;
  collisionFixture.runtime.normalizePersistedOutboxEntry = (entry) =>
    normalizePersistedOutboxEntry({
      entry,
      canonicalAgentId: 'orion',
      now: () => 1000,
    });
  const collisionSqlite = createBncrSqliteStateDatabase(collisionDbPath);
  collisionFixture.runtime.sqliteState = collisionSqlite;
  await collisionFixture.store.loadState();
  const collisionResult = await collisionFixture.store.cutoverToSqlite();
  assert.equal(collisionResult.backupPath, collisionBasePath.replace(/\.json$/, '-1.json'));
  assert.equal(await readFile(collisionBasePath, 'utf8'), 'existing-backup');
  assert.equal(
    JSON.parse(await readFile(collisionResult.backupPath, 'utf8')).outbox[0].messageId,
    'cutover-1',
  );
  collisionSqlite.close();

  await rm(dir, { recursive: true, force: true });
});

test('createBncrStateStore persists removal of a scene row owned by another agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-scene-remove-'));
  const statePath = join(dir, 'state.json');
  const dbPath = join(dir, 'state.sqlite3');
  const { runtime, store } = createStore();
  runtime.getStatePath = () => statePath;
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  runtime.sqliteState = sqlite;
  const scene = (agentId, status) => ({
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status,
    platform: 'tgBot',
    groupId: '-1001',
    agentId,
    groupReplyMode: 'admin',
    lastSeenAt: 100,
  });
  await writeFile(
    statePath,
    JSON.stringify({
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
      sceneRegistry: [scene('orion', 'allowed'), scene('public', 'allowed')],
      lastSessionByAccount: [],
      lastActivityByAccount: [],
      lastInboundByAccount: [],
      lastOutboundByAccount: [],
      lastDriftSnapshot: null,
    }),
    'utf8',
  );

  await store.loadState();
  // A revoke of the public row runs in the orion process; the scoped flush must
  // still delete it instead of leaving the revoked scene behind.
  assert.equal(deleteSceneRecord(runtime.sceneRegistry, 'tgBot:-1001', 'public'), true);
  await store.flushState();

  const reloaded = createBncrSqliteStateDatabase(dbPath);
  const rows = reloaded
    .loadControlState()
    .sceneRegistry.filter((entry) => entry.sceneKey === 'tgBot:-1001')
    .map((entry) => entry.agentId);
  assert.deepEqual(rows, ['orion']);
  reloaded.close();
  await store.closeSqliteLifecycle();
  await rm(dir, { recursive: true, force: true });
});

test('createBncrStateStore keeps a scene row another process re-created after load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-state-scene-remove-race-'));
  const statePath = join(dir, 'state.json');
  const dbPath = join(dir, 'state.sqlite3');
  const { runtime, store } = createStore();
  runtime.getStatePath = () => statePath;
  const sqlite = createBncrSqliteStateDatabase(dbPath);
  runtime.sqliteState = sqlite;
  const scene = (agentId, lastSeenAt) => ({
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    agentId,
    groupReplyMode: 'admin',
    lastSeenAt,
  });
  await writeFile(
    statePath,
    JSON.stringify({
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
      sceneRegistry: [scene('orion', 100), scene('public', 100)],
      lastSessionByAccount: [],
      lastActivityByAccount: [],
      lastInboundByAccount: [],
      lastOutboundByAccount: [],
      lastDriftSnapshot: null,
    }),
    'utf8',
  );

  await store.loadState();
  // Another process re-creates the public scene after this process loaded it.
  const race = new DatabaseSync(dbPath);
  race
    .prepare(
      "UPDATE scenes SET last_seen_at = 500 WHERE scene_key = 'tgBot:-1001' AND agent_id = 'public'",
    )
    .run();
  race.close();
  assert.equal(deleteSceneRecord(runtime.sceneRegistry, 'tgBot:-1001', 'public'), true);
  await store.flushState();

  const reloaded = createBncrSqliteStateDatabase(dbPath);
  const publicRow = reloaded
    .loadControlState()
    .sceneRegistry.find((entry) => entry.sceneKey === 'tgBot:-1001' && entry.agentId === 'public');
  assert.equal(publicRow?.lastSeenAt, 500, 'the newer re-created row survives the stale delete');
  reloaded.close();
  await store.closeSqliteLifecycle();
  await rm(dir, { recursive: true, force: true });
});
