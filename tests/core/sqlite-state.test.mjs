import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createBncrSqliteStateDatabase,
  createEmptyBncrSqliteControlState,
  validateSqliteMigrationChecksums,
} from '../../src/plugin/sqlite-state.ts';

function buildControlState() {
  return {
    sessionRoutes: [
      {
        sessionKey: 'agent:orion:bncr:direct:demo',
        accountId: 'Primary',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        updatedAt: 100,
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
        lastSeenAt: 110,
      },
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'denied',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        groupReplyMode: 'mention',
        historyLimit: 80,
        historyForce: false,
        downloadMedia: true,
        lastSeenAt: 120,
      },
    ],
    lastSessionByAccount: [
      {
        accountId: 'Primary',
        sessionKey: 'session-1',
        scope: 'Bncr:tgBot:0:10001',
        updatedAt: 130,
      },
    ],
    lastActivityByAccount: [{ accountId: 'Primary', updatedAt: 140 }],
    lastInboundByAccount: [{ accountId: 'Primary', updatedAt: 150 }],
    lastOutboundByAccount: [{ accountId: 'Primary', updatedAt: 160 }],
    lastDriftSnapshot: {
      capturedAt: 170,
      registerCount: 3,
      apiGeneration: 1,
      postWarmupRegisterCount: 1,
      apiInstanceId: 'api-1',
      registryFingerprint: 'registry-1',
      dominantBucket: 'other',
      sourceBuckets: { other: 1, 'gateway/startup': 2 },
      traceWindowSize: 1,
      traceRecent: [
        {
          ts: 170,
          bridgeId: 'bridge-1',
          gatewayPid: 123,
          registerCount: 3,
          apiGeneration: 1,
          apiRebound: false,
          stack: 'test',
          stackBucket: 'other',
        },
      ],
    },
  };
}

function buildHistoryState() {
  return {
    historyBuckets: [
      {
        key: 'tgBot:10001',
        entries: [
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
        ],
      },
    ],
    replayBuckets: [
      {
        key: 'Primary:tgBot:10001',
        entries: [
          {
            sender: 'OpenClaw',
            senderId: 'Primary',
            body: 'bot reply',
            timestamp: 120,
            messageId: 'h2',
            accountId: 'Primary',
            sessionKey: 'agent:orion:bncr:direct:demo',
            route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            createdAt: 120,
            status: 'pushed',
          },
        ],
      },
    ],
  };
}

function buildOutboundEntry(messageId, overrides = {}) {
  return {
    messageId,
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { message: { msg: `msg ${messageId}` } },
    createdAt: 100,
    retryCount: 2,
    nextAttemptAt: 200,
    lastAttemptAt: 150,
    lastError: `error ${messageId}`,
    lastPushAt: 160,
    lastPushConnId: 'conn-1',
    lastPushClientId: 'client-1',
    routeAttemptConnIds: ['conn-1', 'conn-2'],
    routeAttemptRound: 3,
    fastReroutePending: true,
    awaitingRetryPush: false,
    ...overrides,
  };
}

function buildOutboundState() {
  return {
    outbox: [buildOutboundEntry('outbox-1')],
    deadLetter: [buildOutboundEntry('dead-1', { lastError: 'fatal' })],
  };
}

test('createBncrSqliteStateDatabase creates schema and reports json store mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    assert.equal(db.getStoreMode(), null);
    const checksumRows = validateSqliteMigrationChecksums(db.getPath());
    assert.equal(checksumRows.length, 5);
    assert.match(checksumRows[0], /^1:[0-9a-f]{64}$/);
    assert.match(checksumRows[1], /^2:[0-9a-f]{64}$/);
    assert.match(checksumRows[2], /^3:[0-9a-f]{64}$/);
    assert.match(checksumRows[3], /^4:[0-9a-f]{64}$/);
    assert.match(checksumRows[4], /^5:[0-9a-f]{64}$/);
    db.close();

    const reopened = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    assert.equal(reopened.getStoreMode(), null);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sqlite control state round trips all imported fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(buildControlState(), {
      legacyJsonPath: '/tmp/bncr-bridge-state.json',
      legacyJsonSha256: 'abc',
    });

    assert.equal(db.getStoreMode(), 'dual');
    assert.equal(db.getMeta('legacy_json_sha256'), 'abc');

    const loaded = db.loadControlState();
    assert.deepEqual(loaded, buildControlState());
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sqlite control state save replaces previous rows without duplicating routes or scenes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(buildControlState(), { storeMode: 'dual' });

    const next = buildControlState();
    next.sessionRoutes[0].sessionKey = 'agent:orion:bncr:direct:next';
    next.sceneRegistry[0].agentId = 'public';
    db.saveControlState(next);

    assert.deepEqual(db.loadControlState(), next);
    assert.equal(db.loadControlState().sessionRoutes.length, 1);
    assert.equal(db.loadControlState().sceneRegistry.length, 2);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sqlite control state rejects writes before import', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    assert.throws(() => db.saveControlState(buildControlState()), /not writable/);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sqlite store mode can be cut over to sqlite only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(buildControlState(), { storeMode: 'dual' });
    db.setStoreMode('sqlite');
    assert.equal(db.getStoreMode(), 'sqlite');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sqlite history state round trips json buckets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-history-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);

    assert.deepEqual(db.loadHistoryState(), fixture);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sqlite outbound state round trips queued and dead entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-outbound-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildOutboundState();
    db.importOutboundState(fixture.outbox, fixture.deadLetter);

    assert.equal(db.isOutboundImported(), true);
    assert.deepEqual(db.loadOutboundState(), fixture);

    db.saveOutboundState([fixture.outbox[0]], []);
    assert.deepEqual(db.loadOutboundState(), { outbox: [fixture.outbox[0]], deadLetter: [] });
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sqlite outbound state maps only queued rows as outbox and dead rows as dead letter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-outbound-state-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importOutboundState(
      [buildOutboundEntry('queued-1')],
      [buildOutboundEntry('dead-1', { lastError: 'fatal' })],
    );

    const loaded = db.loadOutboundState();
    assert.deepEqual(
      loaded.outbox.map((entry) => entry.messageId),
      ['queued-1'],
    );
    assert.deepEqual(
      loaded.deadLetter.map((entry) => entry.messageId),
      ['dead-1'],
    );
    assert.equal(loaded.outbox[0]?.lastPushAt, 160);
    assert.equal(loaded.deadLetter[0]?.lastError, 'fatal');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history shard moves pending rows and complete removes them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);

    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      accountId: 'Primary',
      payloadJson: '{"context":"snapshot"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId);

    assert.deepEqual(db.loadHistoryState(), {
      historyBuckets: [],
      replayBuckets: [],
    });

    db.saveHistoryState(
      [
        {
          key: 'tgBot:10001',
          entries: [{ sender: 'alice', senderId: '10001', body: 'after shard', messageId: 'h3' }],
        },
      ],
      [],
    );
    assert.deepEqual(db.loadHistoryState(), {
      historyBuckets: [
        {
          key: 'tgBot:10001',
          entries: [{ sender: 'alice', senderId: '10001', body: 'after shard', messageId: 'h3' }],
        },
      ],
      replayBuckets: [],
    });

    db.completeHistoryShard(shardId);
    assert.equal(db.listHistoryShards().length, 0);
    assert.equal(db.loadHistoryState().historyBuckets[0].entries.length, 1);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history shard claims only the snapshot message ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-exact-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);

    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      accountId: 'Primary',
      payloadJson: '{"context":"exact-snapshot"}',
      messageIds: ['h1'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId);

    const restored = db.loadHistoryState();
    assert.deepEqual(
      restored.historyBuckets[0].entries.map((entry) => entry.messageId),
      ['h2'],
    );
    assert.deepEqual(
      restored.replayBuckets[0].entries.map((entry) => entry.messageId),
      ['h2'],
    );

    db.completeHistoryShard(shardId);
    assert.deepEqual(
      db.loadHistoryState().historyBuckets[0].entries.map((entry) => entry.messageId),
      ['h2'],
    );
    assert.deepEqual(
      db.loadHistoryState().replayBuckets[0].entries.map((entry) => entry.messageId),
      ['h2'],
    );
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('queued history shards stay queued after restart and are replayed by the worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-restart-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);
    db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"unfinished"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.close();

    const reopened = createBncrSqliteStateDatabase(dbPath);
    const restored = reopened.loadHistoryState();
    assert.equal(restored.historyBuckets.length, 0);
    assert.equal(restored.replayBuckets.length, 0);
    const queued = reopened.listHistoryShards();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].status, 'queued');
    assert.equal(queued[0].payloadJson, '{"context":"unfinished"}');

    reopened.saveHistoryState(fixture.historyBuckets, fixture.replayBuckets);
    assert.equal(reopened.listHistoryShards().length, 1);
    assert.equal(reopened.loadHistoryState().historyBuckets.length, 0);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('expired history shard leases are recovered without counting recovery as upload attempts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-lease-'));
  let currentTime = 1_000;
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'), {
      now: () => currentTime,
    });
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"lease"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId);
    assert.equal(db.recoverHistoryShards(), 0);

    currentTime += 6 * 60 * 1000;
    assert.equal(db.recoverHistoryShards(), 1);
    const recovered = db.listHistoryShards()[0];
    assert.equal(recovered.status, 'queued');
    assert.equal(recovered.attempts, 0);
    assert.equal(db.loadHistoryState().historyBuckets.length, 0);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history shard claims only the replay buffer that was uploaded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-owner-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(
      [
        {
          key: 'tgBot:10001',
          entries: [
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'shared history',
              timestamp: 110,
              messageId: 'shared-history',
            },
          ],
        },
      ],
      [
        {
          key: 'Primary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Primary',
              body: 'primary reply',
              timestamp: 120,
              messageId: 'primary-reply',
              accountId: 'Primary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
          ],
        },
        {
          key: 'Secondary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Secondary',
              body: 'secondary reply',
              timestamp: 130,
              messageId: 'secondary-reply',
              accountId: 'Secondary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
          ],
        },
      ],
    );

    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      accountId: 'Primary',
      payloadJson: '{"context":"primary-only"}',
      messageIds: ['shared-history', 'primary-reply'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId);
    db.completeHistoryShard(shardId);

    const restored = db.loadHistoryState();
    assert.equal(restored.historyBuckets.length, 0);
    assert.equal(restored.replayBuckets.length, 1);
    assert.equal(restored.replayBuckets[0].key, 'Secondary:tgBot:10001');
    assert.deepEqual(
      restored.replayBuckets[0].entries.map((entry) => entry.messageId),
      ['secondary-reply'],
    );
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup recovery returns unexpired in-flight shards to the worker queue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-startup-recover-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"unexpired"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId);

    assert.equal(db.recoverInFlightHistoryShards(), 1);
    const recovered = db.listHistoryShards()[0];
    assert.equal(recovered.status, 'queued');
    assert.equal(recovered.lastError, 'startup in-flight recovered');
    assert.equal(db.loadHistoryState().historyBuckets.length, 0);
    assert.equal(db.loadHistoryState().replayBuckets.length, 0);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed history shards stay queued for worker retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-failed-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"failed"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId);

    db.markHistoryShardFailed(shardId, new Error('upload failed'));
    const failed = db.listHistoryShards()[0];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 1);
    assert.equal(failed.lastError, 'upload failed');
    assert.ok(failed.nextAttemptAt > 0);
    assert.equal(db.loadHistoryState().historyBuckets.length, 0);

    db.saveHistoryState(fixture.historyBuckets, fixture.replayBuckets);
    assert.equal(db.listHistoryShards().length, 1);
    assert.equal(db.loadHistoryState().historyBuckets.length, 0);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history shard worker claims due queued and failed shards with backoff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-claim-'));
  let currentTime = 1_000;
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'), {
      now: () => currentTime,
    });
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(buildHistoryState().historyBuckets, buildHistoryState().replayBuckets);

    const { shardId: queuedId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"queued"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    const { shardId: failedId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"failed"}',
      messageIds: ['h1'],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(failedId);
    db.markHistoryShardFailed(failedId, new Error('upload failed'));
    const failed = db.listHistoryShards().find((item) => item.id === failedId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 1);
    assert.ok(failed.nextAttemptAt > currentTime);

    const first = db.claimNextHistoryShard();
    assert.equal(first.id, queuedId);
    assert.equal(first.status, 'claimed');
    assert.deepEqual(first.messageIds, ['h1', 'h2']);
    db.markHistoryShardProcessing(first.id);
    assert.equal(db.listHistoryShards().find((item) => item.id === queuedId).status, 'processing');
    assert.equal(db.claimNextHistoryShard(), null);

    currentTime = failed.nextAttemptAt;
    const retried = db.claimNextHistoryShard();
    assert.equal(retried.id, failedId);
    assert.equal(retried.status, 'claimed');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history shard claim result carries the assigned owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-claim-owner-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(buildHistoryState().historyBuckets, buildHistoryState().replayBuckets);
    db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"owned"}',
      messageIds: ['h1'],
      bufferKeys: [],
    });

    const claimed = db.claimNextHistoryShard([], 'bridge-a:active');
    assert.equal(claimed.owner, 'bridge-a:active');
    const raw = new DatabaseSync(db.getPath());
    try {
      const row = raw
        .prepare('SELECT claim_owner FROM history_shards WHERE id = ?')
        .get(claimed.id);
      assert.equal(row.claim_owner, 'bridge-a:active');
    } finally {
      raw.close();
    }
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('expired shard lease recovery is isolated to the active claim owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-expired-owner-'));
  let currentTime = 1_000;
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'), {
      now: () => currentTime,
    });
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(buildHistoryState().historyBuckets, buildHistoryState().replayBuckets);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"expired-owner-isolated"}',
      messageIds: ['h1'],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(shardId, 'bridge-a:1:old');

    currentTime += 6 * 60 * 1000;
    assert.equal(db.claimNextHistoryShard([], 'bridge-b:2:new'), null);
    assert.equal(db.listHistoryShards()[0].status, 'processing');

    const samePrefix = db.claimNextHistoryShard([], 'bridge-a:2:new');
    assert.equal(samePrefix.id, shardId);
    assert.equal(samePrefix.owner, 'bridge-a:2:new');
    assert.equal(db.listHistoryShards()[0].status, 'claimed');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history shard creation is idempotent for the same active message snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-dedupe-key-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);

    const first = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"snapshot-a"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    const second = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"snapshot-b"}',
      messageIds: ['h2', 'h1'],
      bufferKeys: ['Primary:tgBot:10001'],
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.shardId, first.shardId);
    assert.equal(db.listHistoryShards().length, 1);
    assert.equal(db.loadHistoryState().historyBuckets.length, 0);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup recovery only resets shards owned by the current bridge or legacy node', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-owner-isolation-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);

    const { shardId: currentShardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"current"}',
      messageIds: ['h1'],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(currentShardId, 'bridge-a');

    const { shardId: otherShardId } = db.createHistoryShard({
      historyKey: 'tgBot:20002',
      payloadJson: '{"context":"other"}',
      messageIds: ['h1'],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(otherShardId, 'bridge-b');

    assert.equal(db.recoverInFlightHistoryShards([], 'bridge-a'), 1);
    const rows = new Map(db.listHistoryShards().map((item) => [item.id, item]));
    assert.equal(rows.get(currentShardId).status, 'queued');
    assert.equal(rows.get(otherShardId).status, 'processing');

    assert.equal(db.recoverInFlightHistoryShards([], 'bridge-b'), 1);
    assert.equal(db.listHistoryShards().find((item) => item.id === otherShardId).status, 'queued');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadHistoryState recovery respects the active bridge owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-load-owner-'));
  let currentTime = 1_000;
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'), {
      now: () => currentTime,
    });
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(buildHistoryState().historyBuckets, buildHistoryState().replayBuckets);

    const current = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"owner-a"}',
      messageIds: ['h1'],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(current.shardId, 'bridge-a');
    const other = db.createHistoryShard({
      historyKey: 'tgBot:20002',
      payloadJson: '{"context":"owner-b"}',
      messageIds: ['h1'],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(other.shardId, 'bridge-b');

    currentTime += 6 * 60 * 1000;
    db.loadHistoryState([], 'bridge-a');
    const rows = new Map(db.listHistoryShards().map((item) => [item.id, item]));
    assert.equal(rows.get(current.shardId).status, 'queued');
    assert.equal(rows.get(other.shardId).status, 'processing');

    db.loadHistoryState([], 'bridge-b');
    const afterOther = new Map(db.listHistoryShards().map((item) => [item.id, item]));
    assert.equal(afterOther.get(other.shardId).status, 'queued');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup recovery skips history keys with an active serial task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-skip-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(buildHistoryState().historyBuckets, buildHistoryState().replayBuckets);
    const { shardId: activeShardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"active"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(activeShardId);
    const { shardId: otherShardId } = db.createHistoryShard({
      historyKey: 'tgBot:99999',
      payloadJson: '{"context":"other"}',
      messageIds: [],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(otherShardId);

    assert.equal(db.recoverInFlightHistoryShards(['tgBot:10001']), 1);
    const rows = new Map(db.listHistoryShards().map((item) => [item.id, item]));
    assert.equal(rows.get(activeShardId).status, 'processing');
    assert.equal(rows.get(otherShardId).status, 'queued');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('expired shard leases stay processing for active history keys until reload without skip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-active-lease-'));
  let currentTime = 1_000;
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'), {
      now: () => currentTime,
    });
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(buildHistoryState().historyBuckets, buildHistoryState().replayBuckets);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"active-lease"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId);

    currentTime += 6 * 60 * 1000;
    assert.equal(db.loadHistoryState(['tgBot:10001']).historyBuckets.length, 0);
    assert.equal(db.listHistoryShards()[0].status, 'processing');
    assert.equal(db.claimNextHistoryShard(['tgBot:10001']), null);
    assert.equal(db.claimNextHistoryShard()?.id, shardId);
    assert.equal(db.listHistoryShards()[0].status, 'claimed');
    assert.equal(db.listHistoryShards()[0].attempts, 0);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history shard lease renewal extends an active processing claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-renew-'));
  let currentTime = 1_000;
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'), {
      now: () => currentTime,
    });
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(buildHistoryState().historyBuckets, buildHistoryState().replayBuckets);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"renew"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(shardId);
    assert.equal(db.renewHistoryShardLease(shardId), true);

    currentTime += 4 * 60 * 1000;
    assert.equal(db.recoverHistoryShards(), 0);
    assert.equal(db.listHistoryShards()[0].status, 'processing');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('terminal failed history shards are restored to the active window on load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-terminal-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(buildHistoryState().historyBuckets, buildHistoryState().replayBuckets);
    assert.equal(db.getHistoryStateRevision(), 1);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"terminal"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      db.markHistoryShardProcessing(shardId);
      db.markHistoryShardFailed(shardId, new Error(`failed ${attempt + 1}`));
    }
    const failed = db.listHistoryShards()[0];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 8);
    assert.equal(failed.nextAttemptAt, null);

    const restored = db.loadHistoryState();
    assert.equal(restored.historyBuckets[0].entries.length, 2);
    assert.equal(restored.replayBuckets[0].entries.length, 1);
    assert.equal(db.listHistoryShards().length, 0);
    assert.equal(db.getHistoryStateRevision(), 2);
    assert.throws(() => db.saveHistoryState([], [], 1), /history revision conflict/);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('migration 2 dedupes existing active message ids before creating the unique index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-migration-dedupe-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP INDEX idx_conv_history_dedupe_active');
    raw.exec('DROP INDEX idx_conv_replay_dedupe_active');
    raw.prepare('DELETE FROM schema_migrations WHERE version IN (2, 4)').run();
    raw
      .prepare(
        `INSERT INTO conversation_messages (
         storage_kind, history_key, buffer_key, sender, body, message_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('history', 'tgBot:10001', 'tgBot:10001', 'alice', 'hello', 'dup', 1, 1);
    raw
      .prepare(
        `INSERT INTO conversation_messages (
         storage_kind, history_key, buffer_key, sender, body, message_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('history', 'tgBot:10001', 'tgBot:10001', 'alice', 'hello duplicate', 'dup', 1, 1);
    raw.close();

    const reopened = createBncrSqliteStateDatabase(dbPath);
    const restored = reopened.loadHistoryState();
    assert.equal(restored.historyBuckets[0].entries.length, 1);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('active history replacement dedupes repeated message ids safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-dedupe-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(
      [
        {
          key: 'tgBot:10001',
          entries: [
            { sender: 'alice', senderId: '10001', body: 'hello', messageId: 'h1' },
            { sender: 'alice', senderId: '10001', body: 'hello duplicate', messageId: 'h1' },
          ],
        },
      ],
      [],
    );
    const restored = db.loadHistoryState();
    assert.equal(restored.historyBuckets[0].entries.length, 1);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('completed history shards are cleaned before loading the active window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-completed-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"completed"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId);
    db.markHistoryShardCompleted(shardId);
    assert.equal(db.listHistoryShards()[0].status, 'completed');
    db.close();

    const reopened = createBncrSqliteStateDatabase(dbPath);
    assert.deepEqual(reopened.loadHistoryState(), {
      historyBuckets: [],
      replayBuckets: [],
    });
    assert.equal(reopened.listHistoryShards().length, 0);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cleanup failure after upload leaves a completed shard instead of a retryable one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-cleanup-failure-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"cleanup-failure"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId);

    const triggerDb = new DatabaseSync(db.getPath());
    triggerDb.exec(`CREATE TRIGGER block_history_shard_delete
                    BEFORE DELETE ON history_shards
                    BEGIN
                      SELECT RAISE(ABORT, 'cleanup blocked');
                    END`);
    triggerDb.close();

    assert.throws(() => db.completeHistoryShard(shardId), /cleanup blocked/);
    assert.equal(db.listHistoryShards()[0].status, 'completed');
    assert.equal(db.claimNextHistoryShard(), null);

    const dropDb = new DatabaseSync(db.getPath());
    dropDb.exec('DROP TRIGGER block_history_shard_delete');
    dropDb.close();
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('completion cleanup finalizes a processing shard even if the marker write is blocked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-cleanup-guard-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"cleanup-guard"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId);

    const triggerDb = new DatabaseSync(db.getPath());
    triggerDb.exec(`CREATE TRIGGER block_history_shard_complete
                    BEFORE UPDATE OF status ON history_shards
                    WHEN NEW.status = 'completed'
                    BEGIN
                      SELECT RAISE(ABORT, 'completion blocked');
                    END`);
    triggerDb.close();

    db.completeHistoryShard(shardId);
    assert.equal(db.listHistoryShards().length, 0);

    const dropDb = new DatabaseSync(db.getPath());
    dropDb.exec('DROP TRIGGER block_history_shard_complete');
    dropDb.close();

    const rawAfter = new DatabaseSync(db.getPath());
    try {
      const shardRows = rawAfter
        .prepare('SELECT COUNT(*) AS count FROM conversation_messages WHERE shard_id = ?')
        .get(shardId);
      assert.equal(Number(shardRows.count), 0);
      const activeRows = rawAfter
        .prepare('SELECT COUNT(*) AS count FROM conversation_messages WHERE shard_id IS NULL')
        .get();
      assert.equal(Number(activeRows.count), 0);
    } finally {
      rawAfter.close();
    }
    assert.deepEqual(db.loadHistoryState(), {
      historyBuckets: [],
      replayBuckets: [],
    });
    assert.equal(db.claimNextHistoryShard(), null);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('completion cleanup leaves an unstarted queued shard intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-cleanup-queued-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"queued-cleanup-guard"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });

    db.completeHistoryShard(shardId);
    assert.equal(db.listHistoryShards()[0].status, 'queued');
    const raw = new DatabaseSync(db.getPath());
    try {
      const row = raw
        .prepare('SELECT COUNT(*) AS count FROM conversation_messages WHERE shard_id = ?')
        .get(shardId);
      assert.equal(Number(row.count), 3);
    } finally {
      raw.close();
    }
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history shard renewal, failure, and completion are isolated to the claim owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-owner-actions-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"owner-isolated"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId, 'bridge-a');

    assert.equal(db.markHistoryShardProcessing(shardId, 'bridge-b'), false);
    assert.equal(db.listHistoryShards()[0].status, 'processing');
    const raw = new DatabaseSync(db.getPath());
    try {
      const row = raw.prepare('SELECT claim_owner FROM history_shards WHERE id = ?').get(shardId);
      assert.equal(row.claim_owner, 'bridge-a');
    } finally {
      raw.close();
    }
    assert.equal(db.renewHistoryShardLease(shardId, 'bridge-a'), true);
    assert.equal(db.renewHistoryShardLease(shardId, 'bridge-b'), false);
    assert.deepEqual(db.markHistoryShardFailed(shardId, new Error('stale'), 'bridge-b'), {
      attempts: 0,
      terminal: false,
    });
    assert.equal(db.markHistoryShardCompleted(shardId, 'bridge-b'), false);
    assert.equal(db.listHistoryShards()[0].status, 'processing');

    db.completeHistoryShard(shardId, 'bridge-b');
    assert.equal(db.listHistoryShards().length, 1);
    assert.equal(db.loadHistoryState().historyBuckets.length, 0);

    db.completeHistoryShard(shardId, 'bridge-a');
    assert.equal(db.listHistoryShards().length, 0);
    assert.equal(db.loadHistoryState().historyBuckets.length, 0);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('active history dedupe is scoped to the conversation history key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-history-scoped-dedupe-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(
      [
        {
          key: 'tgBot:10001',
          entries: [
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'hello one',
              messageId: 'same',
            },
          ],
        },
        {
          key: 'tgBot:20002',
          entries: [
            {
              sender: 'bob',
              senderId: '20002',
              role: 'user',
              body: 'hello two',
              messageId: 'same',
            },
          ],
        },
      ],
      [],
    );

    const restored = db.loadHistoryState();
    assert.equal(restored.historyBuckets.length, 2);
    assert.deepEqual(
      restored.historyBuckets.map((bucket) => bucket.entries.map((entry) => entry.messageId)),
      [['same'], ['same']],
    );
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replay dedupe is scoped to the account buffer key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-replay-scoped-dedupe-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(
      [],
      [
        {
          key: 'Primary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Primary',
              body: 'primary reply',
              messageId: 'same',
              accountId: 'Primary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
            {
              sender: 'OpenClaw',
              senderId: 'Primary',
              body: 'duplicate reply',
              messageId: 'same',
              accountId: 'Primary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
          ],
        },
        {
          key: 'Secondary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Secondary',
              body: 'secondary reply',
              messageId: 'same',
              accountId: 'Secondary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
          ],
        },
      ],
    );

    const restored = db.loadHistoryState();
    assert.equal(restored.replayBuckets.length, 2);
    assert.deepEqual(
      restored.replayBuckets.map((bucket) => bucket.entries.map((entry) => entry.messageId)),
      [['same'], ['same']],
    );
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('migration 4 scopes existing active message id dedupe by history and replay buffer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-migration-scoped-dedupe-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP INDEX idx_conv_history_dedupe_active');
    raw.exec('DROP INDEX idx_conv_replay_dedupe_active');
    raw.prepare('DELETE FROM schema_migrations WHERE version = 4').run();
    const insert = raw.prepare(
      `INSERT INTO conversation_messages (
         storage_kind, history_key, buffer_key, sender, body, message_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('history', 'tgBot:10001', 'tgBot:10001', 'alice', 'hello one', 'same', 1, 1);
    insert.run('history', 'tgBot:20002', 'tgBot:20002', 'bob', 'hello two', 'same', 2, 2);
    insert.run(
      'replay',
      'tgBot:10001',
      'Primary:tgBot:10001',
      'OpenClaw',
      'primary reply',
      'same',
      3,
      3,
    );
    insert.run(
      'replay',
      'tgBot:10001',
      'Secondary:tgBot:10001',
      'OpenClaw',
      'secondary reply',
      'same',
      4,
      4,
    );
    raw.close();

    const reopened = createBncrSqliteStateDatabase(dbPath);
    const restored = reopened.loadHistoryState();
    assert.equal(restored.historyBuckets.length, 2);
    assert.equal(restored.replayBuckets.length, 2);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history shards with different account buffers are not deduplicated as one shard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-account-buffer-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(
      [
        {
          key: 'tgBot:10001',
          entries: [
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'shared history',
              timestamp: 110,
              messageId: 'shared-history',
            },
          ],
        },
      ],
      [
        {
          key: 'Primary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Primary',
              body: 'primary reply',
              timestamp: 120,
              messageId: 'primary-reply',
              accountId: 'Primary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
          ],
        },
        {
          key: 'Secondary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Secondary',
              body: 'secondary reply',
              timestamp: 130,
              messageId: 'secondary-reply',
              accountId: 'Secondary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
          ],
        },
      ],
    );

    const primary = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      accountId: 'Primary',
      payloadJson: '{"context":"primary"}',
      messageIds: ['shared-history', 'primary-reply'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    const secondary = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      accountId: 'Secondary',
      payloadJson: '{"context":"secondary"}',
      messageIds: ['shared-history', 'secondary-reply'],
      bufferKeys: ['Secondary:tgBot:10001'],
    });
    assert.equal(primary.created, true);
    assert.equal(secondary.created, true);
    assert.notEqual(primary.shardId, secondary.shardId);
    assert.equal(db.listHistoryShards().length, 2);

    db.markHistoryShardProcessing(primary.shardId);
    db.markHistoryShardProcessing(secondary.shardId);
    db.completeHistoryShard(primary.shardId);
    db.completeHistoryShard(secondary.shardId);

    assert.deepEqual(db.loadHistoryState(), {
      historyBuckets: [],
      replayBuckets: [],
    });
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shard completion tombstones shared payload messages not owned as rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-payload-tombstone-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(
      [
        {
          key: 'tgBot:10001',
          entries: [
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'shared history',
              timestamp: 110,
              messageId: 'shared-history',
            },
          ],
        },
      ],
      [
        {
          key: 'Primary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Primary',
              body: 'primary reply',
              timestamp: 120,
              messageId: 'primary-reply',
              accountId: 'Primary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
          ],
        },
        {
          key: 'Secondary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Secondary',
              body: 'secondary reply',
              timestamp: 130,
              messageId: 'secondary-reply',
              accountId: 'Secondary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
          ],
        },
      ],
    );

    const primary = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      accountId: 'Primary',
      payloadJson: '{"context":"primary"}',
      messageIds: ['shared-history', 'primary-reply'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    const secondary = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      accountId: 'Secondary',
      payloadJson: '{"context":"secondary"}',
      messageIds: ['shared-history', 'secondary-reply'],
      bufferKeys: ['Secondary:tgBot:10001'],
    });
    assert.equal(primary.created, true);
    assert.equal(secondary.created, true);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      db.markHistoryShardProcessing(primary.shardId);
      db.markHistoryShardFailed(primary.shardId, new Error(`failed ${attempt + 1}`));
    }
    let restored = db.loadHistoryState();
    assert.deepEqual(
      restored.historyBuckets[0].entries.map((entry) => entry.messageId),
      ['shared-history'],
    );

    db.markHistoryShardProcessing(secondary.shardId);
    db.completeHistoryShard(secondary.shardId);
    restored = db.loadHistoryState();
    assert.equal(restored.historyBuckets.length, 0);
    assert.deepEqual(
      restored.replayBuckets.map((bucket) => bucket.entries.map((entry) => entry.messageId)),
      [['primary-reply']],
    );
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('terminal restore does not resurrect messages already consumed by another payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-terminal-consumed-restore-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(
      [
        {
          key: 'tgBot:10001',
          entries: [
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'shared history',
              timestamp: 110,
              messageId: 'shared-history',
            },
          ],
        },
      ],
      [
        {
          key: 'Primary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Primary',
              body: 'primary reply',
              timestamp: 120,
              messageId: 'primary-reply',
              accountId: 'Primary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
          ],
        },
        {
          key: 'Secondary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Secondary',
              body: 'secondary reply',
              timestamp: 130,
              messageId: 'secondary-reply',
              accountId: 'Secondary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
          ],
        },
      ],
    );

    const primary = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      accountId: 'Primary',
      payloadJson: '{"context":"primary"}',
      messageIds: ['shared-history', 'primary-reply'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    const secondary = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      accountId: 'Secondary',
      payloadJson: '{"context":"secondary"}',
      messageIds: ['shared-history', 'secondary-reply'],
      bufferKeys: ['Secondary:tgBot:10001'],
    });

    db.markHistoryShardProcessing(secondary.shardId);
    db.completeHistoryShard(secondary.shardId);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      db.markHistoryShardProcessing(primary.shardId);
      db.markHistoryShardFailed(primary.shardId, new Error(`failed ${attempt + 1}`));
    }
    const restored = db.loadHistoryState();
    assert.equal(restored.historyBuckets.length, 0);
    assert.deepEqual(
      restored.replayBuckets.map((bucket) => bucket.entries.map((entry) => entry.messageId)),
      [['primary-reply']],
    );
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('completed shard tombstones prevent stale memory from reactivating consumed messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-consumed-tombstone-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"consumed"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId);
    db.completeHistoryShard(shardId);
    assert.deepEqual(db.loadHistoryState(), {
      historyBuckets: [],
      replayBuckets: [],
    });

    db.saveHistoryState(
      [
        ...fixture.historyBuckets,
        {
          key: 'tgBot:20002',
          entries: [
            {
              sender: 'bob',
              senderId: '20002',
              role: 'user',
              body: 'same id in another conversation',
              messageId: 'h1',
            },
          ],
        },
      ],
      [
        ...fixture.replayBuckets,
        {
          key: 'Secondary:tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              senderId: 'Secondary',
              body: 'same id in another buffer',
              messageId: 'h2',
              accountId: 'Secondary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
          ],
        },
      ],
    );

    const restored = db.loadHistoryState();
    assert.deepEqual(
      restored.historyBuckets.map((bucket) => bucket.entries.map((entry) => entry.messageId)),
      [['h1']],
    );
    assert.equal(restored.historyBuckets[0].key, 'tgBot:20002');
    assert.deepEqual(
      restored.replayBuckets.map((bucket) => bucket.entries.map((entry) => entry.messageId)),
      [['h2']],
    );
    assert.equal(restored.replayBuckets[0].key, 'Secondary:tgBot:10001');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('expired history consumed tombstones are pruned after the retention window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-consumed-retention-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  let currentTime = 1_000;
  try {
    const db = createBncrSqliteStateDatabase(dbPath, { now: () => currentTime });
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const fixture = buildHistoryState();
    db.importHistoryState(fixture.historyBuckets, fixture.replayBuckets);
    const { shardId } = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"retained"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId);
    db.completeHistoryShard(shardId);

    const readTombstoneCount = () => {
      const raw = new DatabaseSync(dbPath);
      try {
        const row = raw.prepare('SELECT COUNT(*) AS count FROM history_message_consumed').get();
        return Number(row.count);
      } finally {
        raw.close();
      }
    };
    assert.ok(readTombstoneCount() > 0);

    currentTime += 29 * 24 * 60 * 60 * 1000;
    db.loadHistoryState();
    assert.ok(readTombstoneCount() > 0);

    currentTime += 2 * 24 * 60 * 60 * 1000;
    db.loadHistoryState();
    assert.equal(readTombstoneCount(), 0);

    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history state save rejects stale revisions and preserves newer active rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-revision-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const stale = createBncrSqliteStateDatabase(dbPath);
  const live = createBncrSqliteStateDatabase(dbPath);
  try {
    const control = createEmptyBncrSqliteControlState();
    stale.importControlState(control, { storeMode: 'dual' });
    live.importControlState(control, { storeMode: 'dual' });
    stale.importHistoryState(
      [
        {
          key: 'tgBot:10001',
          entries: [
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'hello one',
              timestamp: 110,
              messageId: 'h1',
            },
          ],
        },
      ],
      [],
    );

    live.saveHistoryState(
      [
        {
          key: 'tgBot:10001',
          entries: [
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'hello one',
              timestamp: 110,
              messageId: 'h1',
            },
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'hello two',
              timestamp: 120,
              messageId: 'h2',
            },
          ],
        },
      ],
      [],
      1,
    );
    assert.equal(live.getHistoryStateRevision(), 2);

    assert.throws(
      () =>
        stale.saveHistoryState(
          [
            {
              key: 'tgBot:10001',
              entries: [
                {
                  sender: 'alice',
                  senderId: '10001',
                  role: 'user',
                  body: 'hello stale three',
                  timestamp: 130,
                  messageId: 'h3',
                },
              ],
            },
          ],
          [],
          1,
        ),
      /history revision conflict/,
    );
    assert.deepEqual(
      live.loadHistoryState().historyBuckets[0].entries.map((entry) => entry.messageId),
      ['h1', 'h2'],
    );

    stale.saveHistoryState(
      [
        {
          key: 'tgBot:10001',
          entries: [
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'hello one',
              timestamp: 110,
              messageId: 'h1',
            },
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'hello two',
              timestamp: 120,
              messageId: 'h2',
            },
            {
              sender: 'alice',
              senderId: '10001',
              role: 'user',
              body: 'hello stale three',
              timestamp: 130,
              messageId: 'h3',
            },
          ],
        },
      ],
      [],
      2,
    );
    assert.deepEqual(
      stale.loadHistoryState().historyBuckets[0].entries.map((entry) => entry.messageId),
      ['h1', 'h2', 'h3'],
    );
    assert.equal(stale.getHistoryStateRevision(), 3);
  } finally {
    stale.close();
    live.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed history revision save does not mark history as imported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-revision-import-marker-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  try {
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare(
          `INSERT INTO state_meta (meta_key, meta_value, updated_at)
           VALUES ('history_revision', '1', 1)`,
        )
        .run();
    } finally {
      raw.close();
    }

    assert.equal(db.isHistoryImported(), false);
    assert.throws(
      () =>
        db.saveHistoryState(
          [
            {
              key: 'tgBot:10001',
              entries: [
                {
                  sender: 'alice',
                  senderId: '10001',
                  role: 'user',
                  body: 'hello',
                  messageId: 'h1',
                },
              ],
            },
          ],
          [],
          0,
        ),
      /history revision conflict/,
    );
    assert.equal(db.isHistoryImported(), false);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
