import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from '../helpers/bncr-bridge.mjs';

test('startService tolerates corrupt persisted state by falling back to empty state', async () => {
  const bridge = createBridge();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-corrupt-state-'));
  try {
    await fs.writeFile(path.join(stateDir, 'bncr-bridge-state.json'), '{"outbox":[', 'utf8');

    await bridge.startService({ stateDir }, false);

    assert.equal(bridge.outbox.size, 0);
    assert.equal(bridge.deadLetter.length, 0);
    assert.equal(bridge.sessionRoutes.size, 0);
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('startService caps oversized persisted account activity arrays during load', async () => {
  const bridge = createBridge();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-large-activity-state-'));
  try {
    const nowTs = Date.now();
    const mkAccount = (i) => `Account-${i}`;
    const mkSession = (i) => {
      const groupId = `-${200000 + i}`;
      return {
        accountId: mkAccount(i),
        sessionKey: `agent:orion:bncr:group:${Buffer.from(`tgBot:${groupId}`).toString('hex')}`,
        scope: 'ignored',
        updatedAt: nowTs + i,
      };
    };
    const mkActivity = (i) => ({ accountId: mkAccount(i), updatedAt: nowTs + i });
    const state = {
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
      lastSessionByAccount: Array.from({ length: 1005 }, (_, i) => mkSession(i)),
      lastActivityByAccount: Array.from({ length: 1005 }, (_, i) => mkActivity(i)),
      lastInboundByAccount: Array.from({ length: 1005 }, (_, i) => mkActivity(i)),
      lastOutboundByAccount: Array.from({ length: 1005 }, (_, i) => mkActivity(i)),
    };
    await fs.writeFile(
      path.join(stateDir, 'bncr-bridge-state.json'),
      JSON.stringify(state),
      'utf8',
    );

    await bridge.startService({ stateDir }, false);

    assert.equal(bridge.lastSessionByAccount.size, 1000);
    assert.equal(bridge.lastActivityByAccount.size, 1000);
    assert.equal(bridge.lastInboundByAccount.size, 1000);
    assert.equal(bridge.lastOutboundByAccount.size, 1000);
    for (const map of [
      bridge.lastSessionByAccount,
      bridge.lastActivityByAccount,
      bridge.lastInboundByAccount,
      bridge.lastOutboundByAccount,
    ]) {
      assert.equal(map.has('Account-4'), false);
      assert.equal(map.has('Account-5'), true);
      assert.equal(map.has('Account-1004'), true);
    }
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('startService caps oversized persisted session routes during load', async () => {
  const bridge = createBridge();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-large-routes-state-'));
  try {
    const sessionRoutes = Array.from({ length: 1005 }, (_, i) => {
      const groupId = `-${100000 + i}`;
      const route = { platform: 'tgBot', groupId, userId: '0' };
      return {
        sessionKey: `agent:orion:bncr:group:${Buffer.from(`tgBot:${groupId}`).toString('hex')}`,
        accountId: 'Primary',
        route,
        updatedAt: Date.now() + i,
      };
    });
    const state = {
      outbox: [],
      deadLetter: [],
      sessionRoutes,
    };
    await fs.writeFile(
      path.join(stateDir, 'bncr-bridge-state.json'),
      JSON.stringify(state),
      'utf8',
    );

    await bridge.startService({ stateDir }, false);

    assert.equal(bridge.sessionRoutes.size, 1000);
    assert.equal(bridge.routeAliases.size, 1000);
    assert.equal(
      bridge.sessionRoutes.has(
        `agent:orion:bncr:group:${Buffer.from('tgBot:-100000').toString('hex')}`,
      ),
      false,
    );
    assert.equal(
      bridge.sessionRoutes.has(
        `agent:orion:bncr:group:${Buffer.from('tgBot:-100004').toString('hex')}`,
      ),
      false,
    );
    assert.equal(
      bridge.sessionRoutes.has(
        `agent:orion:bncr:group:${Buffer.from('tgBot:-100005').toString('hex')}`,
      ),
      true,
    );
    assert.equal(
      bridge.sessionRoutes.has(
        `agent:orion:bncr:group:${Buffer.from('tgBot:-101004').toString('hex')}`,
      ),
      true,
    );
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('startService caps oversized persisted deadLetter state during load', async () => {
  const bridge = createBridge();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-large-dead-state-'));
  try {
    const persistedSessionKey = 'agent:orion:bncr:group:7467426f743a2d31303031';
    const deadLetter = Array.from({ length: 1005 }, (_, i) => {
      const entry = makeEntry(`persisted-dead-${i}`, `dead ${i}`);
      entry.sessionKey = persistedSessionKey;
      entry.payload.sessionKey = persistedSessionKey;
      return entry;
    });
    const state = {
      outbox: [],
      deadLetter,
      sessionRoutes: [],
    };
    await fs.writeFile(
      path.join(stateDir, 'bncr-bridge-state.json'),
      JSON.stringify(state),
      'utf8',
    );

    await bridge.startService({ stateDir }, false);

    assert.equal(bridge.deadLetter.length, 1000);
    assert.equal(bridge.deadLetter[0].messageId, 'persisted-dead-5');
    assert.equal(bridge.deadLetter.at(-1).messageId, 'persisted-dead-1004');
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('startService skips malformed persisted entries without blocking valid state', async () => {
  const bridge = createBridge();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-dirty-state-'));
  try {
    const nowTs = Date.now();
    const persistedSessionKey = 'agent:orion:bncr:group:7467426f743a2d31303031';
    const goodOutbox = makeEntry('persisted-good-outbox', 'good outbox');
    goodOutbox.sessionKey = persistedSessionKey;
    goodOutbox.payload.sessionKey = persistedSessionKey;
    goodOutbox.createdAt = String(nowTs - 10_000);
    goodOutbox.nextAttemptAt = String(nowTs - 5_000);
    goodOutbox.retryCount = '2';
    goodOutbox.lastAttemptAt = 'not-a-number';
    const goodDeadLetter = makeEntry('persisted-good-dead', 'good dead');
    goodDeadLetter.sessionKey = persistedSessionKey;
    goodDeadLetter.payload.sessionKey = persistedSessionKey;
    goodDeadLetter.createdAt = 'not-a-number';
    goodDeadLetter.nextAttemptAt = 'not-a-number';
    goodDeadLetter.retryCount = 'not-a-number';
    goodDeadLetter.lastAttemptAt = 'not-a-number';
    const state = {
      outbox: [
        null,
        {},
        { messageId: 'bad-missing-session', accountId: 'Primary' },
        { ...goodOutbox, route: { malformed: true } },
      ],
      deadLetter: [{ messageId: 'bad-dead-missing-session', accountId: 'Primary' }, goodDeadLetter],
      sessionRoutes: [
        null,
        { sessionKey: 'bad-session-key', accountId: 'Primary', route: {}, updatedAt: nowTs },
        {
          sessionKey: persistedSessionKey,
          accountId: 'Primary',
          route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
          updatedAt: 'not-a-number',
        },
      ],
      lastSessionByAccount: [
        { accountId: 'Primary', sessionKey: 'bad-session-key', scope: 'bad', updatedAt: nowTs },
        {
          accountId: 'Primary',
          sessionKey: persistedSessionKey,
          scope: 'ignored-stored-scope',
          updatedAt: String(nowTs),
        },
      ],
      lastActivityByAccount: [
        { accountId: 'Primary', updatedAt: 'not-a-number' },
        { accountId: 'Primary', updatedAt: String(nowTs - 1_000) },
      ],
      lastInboundByAccount: [
        { accountId: 'Primary', updatedAt: 0 },
        { accountId: 'Primary', updatedAt: String(nowTs - 2_000) },
      ],
      lastOutboundByAccount: [
        { accountId: 'Primary', updatedAt: -1 },
        { accountId: 'Primary', updatedAt: String(nowTs - 3_000) },
      ],
      lastDriftSnapshot: {
        capturedAt: 'not-a-number',
        registerCount: 'not-a-number',
        apiGeneration: '2',
        postWarmupRegisterCount: '3',
        apiInstanceId: 'api-1',
        registryFingerprint: 'fingerprint-1',
        dominantBucket: 'bucket-1',
        sourceBuckets: { 'bucket-1': 1 },
        traceWindowSize: 'not-a-number',
        traceRecent: [{ source: 'test' }],
      },
    };
    await fs.writeFile(
      path.join(stateDir, 'bncr-bridge-state.json'),
      JSON.stringify(state),
      'utf8',
    );

    await bridge.startService({ stateDir }, false);

    assert.deepEqual(Array.from(bridge.outbox.keys()), ['persisted-good-outbox']);
    const loadedOutbox = bridge.outbox.get('persisted-good-outbox');
    assert.equal(loadedOutbox.retryCount, 2);
    assert.equal(loadedOutbox.createdAt, nowTs - 10_000);
    assert.equal(loadedOutbox.nextAttemptAt, nowTs - 5_000);
    assert.equal(loadedOutbox.lastAttemptAt, undefined);
    assert.deepEqual(loadedOutbox.route, {
      platform: 'tgBot',
      groupId: '-1001',
      userId: '0',
    });
    assert.deepEqual(
      bridge.deadLetter.map((entry) => entry.messageId),
      ['persisted-good-dead'],
    );
    assert.equal(Number.isFinite(bridge.deadLetter[0].createdAt), true);
    assert.equal(bridge.deadLetter[0].retryCount, 0);
    assert.equal(Number.isFinite(bridge.deadLetter[0].nextAttemptAt), true);
    assert.equal(bridge.deadLetter[0].lastAttemptAt, undefined);
    assert.equal(bridge.sessionRoutes.size, 1);
    assert.equal(Number.isFinite(Array.from(bridge.sessionRoutes.values())[0].updatedAt), true);
    assert.equal(bridge.lastSessionByAccount.get('Primary')?.scope, 'Bncr:tgBot:-1001:0');
    assert.equal(bridge.lastActivityByAccount.get('Primary'), nowTs - 1_000);
    assert.equal(bridge.lastInboundByAccount.get('Primary'), nowTs - 2_000);
    assert.equal(bridge.lastOutboundByAccount.get('Primary'), nowTs - 3_000);
    const diagnostics = bridge.buildExtendedDiagnostics('Primary');
    assert.equal(diagnostics.register.lastDriftSnapshot.capturedAt, 0);
    assert.equal(diagnostics.register.lastDriftSnapshot.registerCount, null);
    assert.equal(diagnostics.register.lastDriftSnapshot.apiGeneration, 2);
    assert.equal(diagnostics.register.lastDriftSnapshot.postWarmupRegisterCount, 3);
    assert.equal(diagnostics.register.lastDriftSnapshot.traceWindowSize, 0);
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('startService restores persisted scene registry entries', async () => {
  const bridge = createBridge();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-scene-state-'));
  try {
    const state = {
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
          userName: 'xmo',
          agentId: 'main',
          lastSeenAt: 100,
        },
        {
          sceneKey: 'tgBot:-1001',
          kind: 'group',
          status: 'denied',
          platform: 'tgBot',
          groupId: '-1001',
          groupName: 'wind_system',
          lastSeenAt: 90,
        },
      ],
    };
    await fs.writeFile(
      path.join(stateDir, 'bncr-bridge-state.json'),
      JSON.stringify(state),
      'utf8',
    );

    await bridge.startService({ stateDir }, false);

    assert.deepEqual(Array.from(bridge.sceneRegistry.entries()), [
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
          lastSeenAt: 100,
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
          lastSeenAt: 90,
        },
      ],
    ]);
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
