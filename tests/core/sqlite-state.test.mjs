import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  BncrSqliteIntegrityFailure,
  createBncrSqliteStateDatabase,
  createEmptyBncrSqliteControlState,
  normalizeLegacyAliasAccountIds,
  rotateSqliteSnapshot,
  validateSqliteMigrationChecksums,
} from '../../src/plugin/sqlite-state.ts';

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

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
        key: 'Primary:tgBot:10001',
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
    const dbPath = join(dir, 'bncr.sqlite3');
    const db = createBncrSqliteStateDatabase(dbPath);
    assert.equal((await stat(dbPath)).mode & 0o777, 0o600);
    assert.equal(db.getStoreMode(), null);
    const checksumRows = validateSqliteMigrationChecksums(db.getPath());
    assert.equal(checksumRows.length, 6);
    assert.match(checksumRows[0], /^1:[0-9a-f]{64}$/);
    assert.match(checksumRows[1], /^2:[0-9a-f]{64}$/);
    assert.match(checksumRows[2], /^3:[0-9a-f]{64}$/);
    assert.match(checksumRows[3], /^4:[0-9a-f]{64}$/);
    assert.match(checksumRows[4], /^5:[0-9a-f]{64}$/);
    assert.match(checksumRows[5], /^6:[0-9a-f]{64}$/);
    db.close();

    const reopened = createBncrSqliteStateDatabase(dbPath);
    assert.equal(reopened.getStoreMode(), null);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createBncrSqliteStateDatabase hardens database, wal, and shm permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-modes-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const seed = new DatabaseSync(dbPath);
  try {
    seed.exec('PRAGMA journal_mode=WAL');
    seed.exec('CREATE TABLE seed_table (id INTEGER)');
    seed.exec('INSERT INTO seed_table (id) VALUES (1)');
    for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      await chmod(filePath, 0o644);
    }

    const db = createBncrSqliteStateDatabase(dbPath);
    try {
      for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        assert.equal((await stat(filePath)).mode & 0o777, 0o600);
      }
    } finally {
      db.close();
    }
  } finally {
    seed.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('createBncrSqliteStateDatabase accepts unknown checksum lineage when the schema contract is complete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-checksum-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.close();

    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    raw.close();

    const reopened = createBncrSqliteStateDatabase(dbPath);
    assert.equal(reopened.getStoreMode(), null);
    reopened.close();
    assert.ok(validateSqliteMigrationChecksums(dbPath).includes('1:tampered'));

    const brokenSchema = new DatabaseSync(dbPath);
    brokenSchema.exec('DROP INDEX idx_conv_shard');
    brokenSchema.close();
    assert.throws(
      () => createBncrSqliteStateDatabase(dbPath),
      /bncr sqlite write contract mismatch/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createBncrSqliteStateDatabase normalizes only the known legacy migration 2 checksum', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-legacy-checksum-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const legacyChecksum = '2f750f4526fa72b07676d8043a5829c6e392dcbb6a5ad9a0fa42171b82065ce8';
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.close();

    const seeded = new DatabaseSync(dbPath);
    const currentChecksum = seeded
      .prepare('SELECT checksum FROM schema_migrations WHERE version = 2')
      .get().checksum;
    seeded
      .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 2')
      .run(legacyChecksum);
    seeded.close();

    assert.ok(validateSqliteMigrationChecksums(dbPath).includes(`2:${legacyChecksum}`));
    const reopened = createBncrSqliteStateDatabase(dbPath);
    reopened.close();

    const healed = new DatabaseSync(dbPath);
    assert.equal(
      healed.prepare('SELECT checksum FROM schema_migrations WHERE version = 2').get().checksum,
      currentChecksum,
    );
    healed.close();
    assert.ok(validateSqliteMigrationChecksums(dbPath).includes(`2:${currentChecksum}`));

    const idempotent = createBncrSqliteStateDatabase(dbPath);
    idempotent.close();

    const unknownLineage = new DatabaseSync(dbPath);
    unknownLineage
      .prepare("UPDATE schema_migrations SET checksum = 'near-miss' WHERE version = 2")
      .run();
    unknownLineage.close();

    const accepted = createBncrSqliteStateDatabase(dbPath);
    accepted.close();
    assert.ok(validateSqliteMigrationChecksums(dbPath).includes('2:near-miss'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a schema contract failure does not poison the next write after schema repair', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-contract-recovery-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });

    const broken = new DatabaseSync(dbPath);
    broken.exec('DROP INDEX idx_history_message_consumed_at');
    broken.close();

    assert.throws(
      () => db.setMeta('contract_probe', 'first'),
      /bncr sqlite write contract mismatch/,
    );
    assert.equal(db.getMeta('contract_probe'), null);
    assert.equal(db.getStoreMode(), 'dual');

    const repaired = new DatabaseSync(dbPath);
    repaired.exec(
      'CREATE INDEX idx_history_message_consumed_at ON history_message_consumed(consumed_at)',
    );
    repaired.close();

    db.setMeta('contract_probe', 'second');
    assert.equal(db.getMeta('contract_probe'), 'second');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unexpected index on a business table is rejected until the additive constraint is removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-contract-extra-index-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    const unexpected = new DatabaseSync(dbPath);
    unexpected.exec('CREATE UNIQUE INDEX unexpected_state_meta_updated ON state_meta(updated_at)');
    unexpected.close();

    assert.throws(
      () => db.setMeta('contract_probe', 'blocked'),
      /bncr sqlite write contract mismatch: .*unexpected/,
    );
    assert.equal(db.getMeta('contract_probe'), null);

    const repaired = new DatabaseSync(dbPath);
    repaired.exec('DROP INDEX unexpected_state_meta_updated');
    repaired.close();

    db.setMeta('contract_probe', 'allowed');
    assert.equal(db.getMeta('contract_probe'), 'allowed');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a schema contract failure rolls back a compound write before the next retry succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-contract-rollback-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    const original = buildControlState();
    db.importControlState(original, { storeMode: 'dual' });

    const broken = new DatabaseSync(dbPath);
    broken.exec('DROP INDEX idx_conv_history_dedupe_active');
    broken.close();

    const replacement = buildControlState();
    replacement.sessionRoutes[0].sessionKey = 'agent:public:bncr:direct:retry';
    replacement.sceneRegistry[0].agentId = 'public';
    assert.throws(() => db.saveControlState(replacement), /bncr sqlite write contract mismatch/);
    assert.deepEqual(db.loadControlState(), original);

    const repaired = new DatabaseSync(dbPath);
    repaired.exec(
      `CREATE UNIQUE INDEX idx_conv_history_dedupe_active
       ON conversation_messages(history_key, message_id)
       WHERE storage_kind = 'history'
         AND shard_id IS NULL
         AND message_id IS NOT NULL
         AND message_id != ''`,
    );
    repaired.close();

    db.saveControlState(replacement);
    assert.deepEqual(db.loadControlState(), replacement);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup rejects foreign key violations even when migration lineage is valid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-fk-check-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA foreign_keys=OFF');
    raw
      .prepare(
        `INSERT INTO session_routes (
           session_key, account_id, route_id, platform, group_id, user_id, updated_at, created_at
         ) VALUES ('orphan', 'Primary', 999, 'tgBot', '0', '1', 1, 1)`,
      )
      .run();
    raw.close();

    assert.throws(
      () => createBncrSqliteStateDatabase(dbPath),
      /bncr sqlite foreign key check failed: 1 violation/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createBncrSqliteStateDatabase rejects migration name drift', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-name-drift-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.close();

    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE schema_migrations SET name = 'renamed' WHERE version = 2").run();
    raw.close();

    assert.throws(
      () => createBncrSqliteStateDatabase(dbPath),
      /bncr sqlite migration 2 name mismatch/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createBncrSqliteStateDatabase rejects migrations newer than this plugin supports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-future-migration-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.close();

    const raw = new DatabaseSync(dbPath);
    raw
      .prepare(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES (999, 'future', 'future', 1)`,
      )
      .run();
    raw.close();

    assert.throws(
      () => createBncrSqliteStateDatabase(dbPath),
      /bncr sqlite migration 999 is newer than this plugin supports/,
    );
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

test('sqlite history import normalizes legacy scene-only bucket keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-legacy-key-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(
      [
        {
          key: 'tgBot:10001',
          entries: [{ sender: 'alice', body: 'legacy history', messageId: 'legacy-history-1' }],
        },
      ],
      [
        {
          key: 'tgBot:10001',
          entries: [
            {
              sender: 'OpenClaw',
              body: 'legacy replay',
              messageId: 'legacy-replay-1',
              accountId: 'Primary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
          ],
        },
      ],
    );

    const restored = db.loadHistoryState();
    assert.deepEqual(
      restored.historyBuckets.map((bucket) => bucket.key),
      ['Primary:tgBot:10001'],
    );
    assert.deepEqual(
      restored.replayBuckets.map((bucket) => bucket.key),
      ['Primary:tgBot:10001'],
    );
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sqlite history import canonicalizes default account aliases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-default-key-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(
      [
        {
          key: 'default:tgBot:10001',
          entries: [{ sender: 'alice', body: 'default history', messageId: 'default-history-1' }],
        },
      ],
      [],
    );

    assert.deepEqual(
      db.loadHistoryState().historyBuckets.map((bucket) => bucket.key),
      ['Primary:tgBot:10001'],
    );
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sqlite history import separates account-scoped entries in a legacy replay bucket', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-legacy-mixed-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(
      [],
      [
        {
          key: 'tgBot:10001',
          entries: [
            {
              sender: 'PrimaryBot',
              body: 'primary replay',
              messageId: 'primary-legacy-replay-1',
              accountId: 'Primary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
            {
              sender: 'SecondaryBot',
              body: 'secondary replay',
              messageId: 'secondary-legacy-replay-1',
              accountId: 'Secondary',
              route: { platform: 'tgBot', groupId: '0', userId: '10001' },
            },
          ],
        },
      ],
    );

    const restored = db.loadHistoryState();
    assert.deepEqual(
      restored.replayBuckets.map((bucket) => [
        bucket.key,
        bucket.entries.map((entry) => entry.messageId),
      ]),
      [
        ['Primary:tgBot:10001', ['primary-legacy-replay-1']],
        ['Secondary:tgBot:10001', ['secondary-legacy-replay-1']],
      ],
    );
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
      historyKey: 'Primary:tgBot:10001',
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
          key: 'Primary:tgBot:10001',
          entries: [{ sender: 'alice', senderId: '10001', body: 'after shard', messageId: 'h3' }],
        },
      ],
      [],
    );
    assert.deepEqual(db.loadHistoryState(), {
      historyBuckets: [
        {
          key: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
          key: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
      payloadJson: '{"context":"queued"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    const { shardId: failedId } = db.createHistoryShard({
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
      payloadJson: '{"context":"snapshot-a"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    const second = db.createHistoryShard({
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
      payloadJson: '{"context":"current"}',
      messageIds: ['h1'],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(currentShardId, 'bridge-a');

    const { shardId: otherShardId } = db.createHistoryShard({
      historyKey: 'Primary:tgBot:20002',
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
      historyKey: 'Primary:tgBot:10001',
      payloadJson: '{"context":"owner-a"}',
      messageIds: ['h1'],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(current.shardId, 'bridge-a');
    const other = db.createHistoryShard({
      historyKey: 'Primary:tgBot:20002',
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
      historyKey: 'Primary:tgBot:10001',
      payloadJson: '{"context":"active"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(activeShardId);
    const { shardId: otherShardId } = db.createHistoryShard({
      historyKey: 'Primary:tgBot:99999',
      payloadJson: '{"context":"other"}',
      messageIds: [],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(otherShardId);

    assert.equal(db.recoverInFlightHistoryShards(['Primary:tgBot:10001']), 1);
    const rows = new Map(db.listHistoryShards().map((item) => [item.id, item]));
    assert.equal(rows.get(activeShardId).status, 'processing');
    assert.equal(rows.get(otherShardId).status, 'queued');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup recovery skip list matches both new and legacy history keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-shard-skip-legacy-'));
  try {
    const db = createBncrSqliteStateDatabase(join(dir, 'bncr.sqlite3'));
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(buildHistoryState().historyBuckets, buildHistoryState().replayBuckets);
    const current = db.createHistoryShard({
      historyKey: 'Primary:tgBot:10001',
      payloadJson: '{"context":"current-key"}',
      messageIds: ['h1'],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(current.shardId);
    const legacy = db.createHistoryShard({
      historyKey: 'tgBot:10001',
      payloadJson: '{"context":"legacy-key"}',
      messageIds: ['h2'],
      bufferKeys: [],
    });
    db.markHistoryShardProcessing(legacy.shardId);

    assert.equal(db.recoverInFlightHistoryShards(['Primary:tgBot:10001']), 0);
    const rows = new Map(db.listHistoryShards().map((item) => [item.id, item]));
    assert.equal(rows.get(current.shardId).status, 'processing');
    assert.equal(rows.get(legacy.shardId).status, 'processing');
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
      historyKey: 'Primary:tgBot:10001',
      payloadJson: '{"context":"active-lease"}',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    db.markHistoryShardProcessing(shardId);

    currentTime += 6 * 60 * 1000;
    assert.equal(db.loadHistoryState(['Primary:tgBot:10001']).historyBuckets.length, 0);
    assert.equal(db.listHistoryShards()[0].status, 'processing');
    assert.equal(db.claimNextHistoryShard(['Primary:tgBot:10001']), null);
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
      historyKey: 'Primary:tgBot:10001',
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
    const dbPath = join(dir, 'bncr.sqlite3');
    const db = createBncrSqliteStateDatabase(dbPath, { now: () => 2_000 });
    db.importControlState(createEmptyBncrSqliteControlState(), { storeMode: 'dual' });
    db.importHistoryState(buildHistoryState().historyBuckets, buildHistoryState().replayBuckets);
    assert.equal(db.getHistoryStateRevision(), 1);
    const { shardId } = db.createHistoryShard({
      historyKey: 'Primary:tgBot:10001',
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
    const raw = new DatabaseSync(dbPath);
    try {
      const revision = raw
        .prepare("SELECT updated_at FROM state_meta WHERE meta_key = 'history_revision'")
        .get();
      assert.equal(revision.updated_at, 2_000);
    } finally {
      raw.close();
    }
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
          key: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
          key: 'Primary:tgBot:10001',
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
          key: 'Primary:tgBot:20002',
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
    insert.run('history', 'Primary:tgBot:10001', 'tgBot:10001', 'alice', 'hello one', 'same', 1, 1);
    insert.run('history', 'Primary:tgBot:20002', 'tgBot:20002', 'bob', 'hello two', 'same', 2, 2);
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
          key: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
      accountId: 'Primary',
      payloadJson: '{"context":"primary"}',
      messageIds: ['shared-history', 'primary-reply'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    const secondary = db.createHistoryShard({
      historyKey: 'Primary:tgBot:10001',
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
          key: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
      accountId: 'Primary',
      payloadJson: '{"context":"primary"}',
      messageIds: ['shared-history', 'primary-reply'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    const secondary = db.createHistoryShard({
      historyKey: 'Primary:tgBot:10001',
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
          key: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
      accountId: 'Primary',
      payloadJson: '{"context":"primary"}',
      messageIds: ['shared-history', 'primary-reply'],
      bufferKeys: ['Primary:tgBot:10001'],
    });
    const secondary = db.createHistoryShard({
      historyKey: 'Primary:tgBot:10001',
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
      historyKey: 'Primary:tgBot:10001',
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
          key: 'Primary:tgBot:20002',
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
    assert.equal(restored.historyBuckets[0].key, 'Primary:tgBot:20002');
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
      historyKey: 'Primary:tgBot:10001',
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
          key: 'Primary:tgBot:10001',
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
          key: 'Primary:tgBot:10001',
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
              key: 'Primary:tgBot:10001',
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
          key: 'Primary:tgBot:10001',
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
              key: 'Primary:tgBot:10001',
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

test('rotateSqliteSnapshot publishes an exclusive retained snapshot and prunes only old ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-snap-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  db.saveControlState(buildControlState());
  const first = db.rotateSnapshot();
  db.close();
  try {
    assert.ok(first?.includes('bncr.sqlite3.snap-'), 'snapshot published');
    assert.equal((await stat(first)).mode & 0o777, 0o600);
    const backupDir = join(dir, 'backups');
    assert.equal((await stat(backupDir)).mode & 0o777, 0o700);
    const probe = new DatabaseSync(first, { readOnly: true });
    assert.equal(probe.prepare('SELECT COUNT(*) AS n FROM session_routes').get().n, 1);
    probe.close();

    for (const suffix of ['0', '1']) {
      await writeFile(
        join(backupDir, `bncr.sqlite3.snap-2026010100000${suffix}`),
        'stale-snapshot',
      );
      await utimes(
        join(backupDir, `bncr.sqlite3.snap-2026010100000${suffix}`),
        0,
        Date.now() / 1000 - 86400,
      );
    }
    await writeFile(join(backupDir, 'bncr-state.json'), '{"x":1}');

    const second = rotateSqliteSnapshot({ db: new DatabaseSync(dbPath), dbPath });
    assert.equal(second, `${first}-1`, 'same-second publish gets an incrementing suffix');
    const names = await readdir(backupDir);
    assert.ok(
      !names.includes('bncr.sqlite3.snap-20260101000000'),
      'oldest snapshot pruned to the cap',
    );
    assert.ok(names.includes('bncr.sqlite3.snap-20260101000001'), 'newer stale snapshot kept');
    assert.ok(names.includes('bncr-state.json'), 'json cutover backup untouched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup recovers from the newest eligible snapshot when the live database is corrupt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-recover-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  db.saveControlState(buildControlState());
  const snapshot = db.rotateSnapshot();
  db.close();
  assert.ok(snapshot, 'snapshot published');

  try {
    await writeFile(dbPath, Buffer.from('this is not a sqlite database'));
    const recovered = createBncrSqliteStateDatabase(dbPath);
    try {
      assert.equal(recovered.getMeta('sqlite_last_recovery_from'), basename(snapshot));
      assert.ok(recovered.getMeta('sqlite_last_recovery_at'), 'recovery timestamp recorded');
      assert.match(
        recovered.getMeta('sqlite_last_recovery_reason') ?? '',
        /open failed|not a database/i,
      );
      const routes = recovered.loadControlState().sessionRoutes;
      assert.equal(routes.length, 1);
      assert.equal(routes[0].sessionKey, 'agent:orion:bncr:direct:demo');
      const names = await readdir(dir);
      assert.ok(names.some((name) => name.startsWith('bncr.sqlite3.corrupt-')));
      assert.equal((await stat(dbPath)).mode & 0o777, 0o600);
    } finally {
      recovered.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('snapshot recovery promotes the newest eligible snapshot when several eligible snapshots exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-recover-order-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  db.saveControlState(buildControlState());
  const older = db.rotateSnapshot();
  assert.ok(older, 'older snapshot published');
  const extended = db.loadControlState();
  extended.sessionRoutes.push({
    sessionKey: 'agent:orion:bncr:direct:newer',
    accountId: 'Primary',
    route: { platform: 'tgBot', groupId: '0', userId: '10002' },
    updatedAt: 200,
  });
  db.saveControlState(extended);
  const newer = db.rotateSnapshot();
  db.close();
  assert.ok(newer, 'newer snapshot published');
  await utimes(older, 0, Date.now() / 1000 - 86400);

  try {
    await writeFile(dbPath, Buffer.from('corrupt'));
    const recovered = createBncrSqliteStateDatabase(dbPath);
    try {
      assert.equal(recovered.getMeta('sqlite_last_recovery_from'), basename(newer));
      assert.equal(
        recovered.loadControlState().sessionRoutes.length,
        2,
        'newest snapshot data survives recovery',
      );
      const names = await readdir(dir);
      assert.ok(
        names.some((name) => name.startsWith('bncr.sqlite3.corrupt-')),
        'corrupt live archived',
      );
      assert.ok(
        (await readdir(join(dir, 'backups'))).includes(basename(older)),
        'older snapshot retained for further rollback',
      );
    } finally {
      recovered.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('snapshot recovery falls back to an older eligible snapshot when the newest is ineligible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-recover-fallback-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  db.saveControlState(buildControlState());
  db.close();
  const backupDir = join(dir, 'backups');
  await mkdir(backupDir, { recursive: true });
  const eligible = join(backupDir, 'bncr.sqlite3.snap-eligible');
  const tainted = join(backupDir, 'bncr.sqlite3.snap-tainted');
  const seed = new DatabaseSync(dbPath, { readOnly: true });
  seed.exec(`VACUUM INTO '${eligible}'`);
  seed.exec(`VACUUM INTO '${tainted}'`);
  seed.close();
  await utimes(eligible, 0, Date.now() / 1000 - 86400);
  const broken = new DatabaseSync(tainted);
  broken.exec(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', 'deadbeef', 1)",
  );
  broken.close();
  await utimes(tainted, 0, Date.now() / 1000);

  try {
    await writeFile(dbPath, Buffer.from('corrupt'));
    const recovered = createBncrSqliteStateDatabase(dbPath);
    try {
      assert.equal(recovered.getMeta('sqlite_last_recovery_from'), basename(eligible));
      assert.equal(recovered.loadControlState().sessionRoutes.length, 1);
    } finally {
      recovered.close();
    }
    assert.ok(await fileExists(tainted), 'ineligible newest candidate left in place');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('snapshot recovery rejects candidates that carry a future migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-recover-lineage-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  db.saveControlState(buildControlState());
  db.close();
  const backupDir = join(dir, 'backups');
  await mkdir(backupDir, { recursive: true });
  const candidate = join(backupDir, 'bncr.sqlite3.snap-candidate');
  const source = new DatabaseSync(dbPath, { readOnly: true });
  source.exec(`VACUUM INTO '${candidate}'`);
  source.close();
  const tainted = new DatabaseSync(candidate);
  tainted.exec(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', 'deadbeef', 1)",
  );
  tainted.close();

  try {
    await writeFile(dbPath, Buffer.from('corrupt'));
    assert.throws(() => createBncrSqliteStateDatabase(dbPath), BncrSqliteIntegrityFailure);
    assert.equal(await fileExists(dbPath), true, 'no archive when no candidate is eligible');
    assert.equal(await fileExists(candidate), true, 'candidate left in place');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('snapshot recovery refuses candidates older than the recovery window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-recover-age-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  const snapshot = db.rotateSnapshot();
  db.close();
  assert.ok(snapshot, 'snapshot published');
  await utimes(snapshot, 0, Date.now() / 1000 - 30 * 86400);

  try {
    await writeFile(dbPath, Buffer.from('corrupt'));
    assert.throws(() => createBncrSqliteStateDatabase(dbPath), BncrSqliteIntegrityFailure);
    assert.equal(await fileExists(dbPath), true, 'no promotion: the live file stays in place');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup without any eligible snapshot fails closed with the original error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-recover-none-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  createBncrSqliteStateDatabase(dbPath).close();
  try {
    await writeFile(dbPath, Buffer.from('corrupt'));
    assert.throws(() => createBncrSqliteStateDatabase(dbPath), BncrSqliteIntegrityFailure);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('corrupt live archives are retained only up to the configured cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-archives-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  db.saveControlState(buildControlState());
  db.rotateSnapshot();
  db.close();
  for (const [index, name] of ['a', 'b', 'c', 'd'].entries()) {
    const archivePath = `${dbPath}.corrupt-2026010${name}000000`;
    await writeFile(archivePath, 'old');
    await utimes(archivePath, 0, Date.now() / 1000 - 86400 * (4 - index));
  }
  await writeFile(dbPath, Buffer.from('corrupt'));
  const recovered = createBncrSqliteStateDatabase(dbPath);
  try {
    const archives = (await readdir(dir)).filter((name) =>
      name.startsWith('bncr.sqlite3.corrupt-'),
    );
    assert.equal(archives.length, 3, 'oldest pre-seeded archives pruned to the cap');
    assert.ok(archives.includes('bncr.sqlite3.corrupt-2026010d000000'));
    assert.ok(!archives.includes('bncr.sqlite3.corrupt-2026010a000000'));
  } finally {
    recovered.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup one-shot normalizes legacy alias account ids on the stored truth tables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-alias-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  db.saveControlState(buildControlState());
  const outbound = buildOutboundState();
  db.saveOutboundState(outbound.outbox, outbound.deadLetter);
  db.close();

  const raw = new DatabaseSync(dbPath);
  raw.exec(
    "UPDATE session_routes SET account_id = 'primary' WHERE session_key = 'agent:orion:bncr:direct:demo'",
  );
  raw.exec(
    "INSERT INTO account_activity (account_id, activity_type, event_at, updated_at) VALUES ('default', 'last_inbound', 1, 1)",
  );
  raw.exec(
    "INSERT INTO account_activity (account_id, activity_type, event_at, updated_at) VALUES ('orion', 'last_activity', 2, 2)",
  );
  raw.close();

  const reopened = createBncrSqliteStateDatabase(dbPath);
  try {
    const ref = new DatabaseSync(dbPath, { readOnly: true });
    const sessionRoutes = ref
      .prepare('SELECT DISTINCT account_id FROM session_routes')
      .all()
      .map((row) => row.account_id);
    assert.deepEqual(sessionRoutes, ['Primary']);
    const activity = ref
      .prepare('SELECT DISTINCT account_id FROM account_activity ORDER BY account_id')
      .all()
      .map((row) => row.account_id);
    assert.ok(activity.includes('Primary'), 'alias ids rewritten to the canonical account');
    assert.ok(activity.includes('orion'), 'unknown legacy ids are never rewritten');
    ref.close();
  } finally {
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('normalizeLegacyAliasAccountIds reports rewritten rows and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-alias-direct-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const state = createBncrSqliteStateDatabase(dbPath);
  state.setStoreMode('sqlite');
  state.saveControlState(buildControlState());
  const outbound = buildOutboundState();
  state.saveOutboundState(outbound.outbox, outbound.deadLetter);
  state.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec("UPDATE session_routes SET account_id = 'primary'");
  raw.exec("UPDATE outbound_messages SET account_id = 'default'");
  const first = normalizeLegacyAliasAccountIds(raw);
  const second = normalizeLegacyAliasAccountIds(raw);
  raw.close();
  assert.equal(first, 3, 'one session route plus the outbound rows');
  assert.equal(second, 0, 'idempotent after the rewrite');
  await rm(dir, { recursive: true, force: true });
});

function scopedControlState(agent, updatedAt) {
  return {
    sessionRoutes: [
      {
        sessionKey: `agent:${agent}:bncr:direct:10001`,
        accountId: 'Primary',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        updatedAt,
      },
    ],
    sceneRegistry: [
      {
        sceneKey: `tgBot:scene-${agent}`,
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        agentId: agent,
        lastSeenAt: updatedAt,
      },
    ],
    lastSessionByAccount: [],
    lastActivityByAccount: [{ accountId: 'Primary', updatedAt }],
    lastInboundByAccount: [],
    lastOutboundByAccount: [],
    lastDriftSnapshot: null,
  };
}

function scopedOutboxEntry(messageId, sessionKey, extra = {}) {
  return {
    messageId,
    accountId: 'Primary',
    sessionKey,
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: 'hello' },
    retryCount: 0,
    nextAttemptAt: 1,
    createdAt: 1,
    ...extra,
  };
}

test('scoped control save preserves other agents rows and merges account activity by event time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-scoped-control-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  const probe = () => new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.saveControlState({
      sessionRoutes: [
        scopedControlState('orion', 100).sessionRoutes[0],
        scopedControlState('public', 100).sessionRoutes[0],
      ],
      sceneRegistry: [
        scopedControlState('orion', 100).sceneRegistry[0],
        scopedControlState('public', 100).sceneRegistry[0],
      ],
      lastSessionByAccount: [],
      lastActivityByAccount: [{ accountId: 'Primary', updatedAt: 500 }],
      lastInboundByAccount: [],
      lastOutboundByAccount: [],
      lastDriftSnapshot: null,
    });

    // A scoped flush carrying a stale account-activity event must not clobber
    // the fresher shared row, and must not touch the other agent's rows.
    db.saveControlState(scopedControlState('orion', 400), { agentId: 'orion' });

    let raw = probe();
    try {
      const rows = raw.prepare('SELECT session_key FROM session_routes ORDER BY session_key').all();
      assert.deepEqual(
        rows.map((row) => row.session_key),
        ['agent:orion:bncr:direct:10001', 'agent:public:bncr:direct:10001'],
      );
      assert.equal(
        raw.prepare("SELECT COUNT(*) AS n FROM routes WHERE route_key = 'wxBot:0:0'").get().n,
        0,
        'probe: public route uses its own key space',
      );
      assert.equal(
        raw.prepare("SELECT COUNT(*) AS n FROM scenes WHERE agent_id = 'public'").get().n,
        1,
        'other agents scene survives a scoped flush',
      );
      const activity = raw
        .prepare(
          "SELECT event_at FROM account_activity WHERE account_id = 'Primary' AND activity_type = 'last_activity'",
        )
        .get();
      assert.equal(
        Number(activity.event_at),
        500,
        'stale scoped event does not clobber fresher shared row',
      );
    } finally {
      raw.close();
    }

    // A fresher event wins the merge.
    db.saveControlState(scopedControlState('orion', 600), { agentId: 'orion' });
    raw = probe();
    try {
      const activity = raw
        .prepare(
          "SELECT event_at FROM account_activity WHERE account_id = 'Primary' AND activity_type = 'last_activity'",
        )
        .get();
      assert.equal(Number(activity.event_at), 600, 'fresher scoped event wins the merge');
      const orionUpdated = raw
        .prepare('SELECT updated_at FROM session_routes WHERE session_key = ?')
        .get('agent:orion:bncr:direct:10001');
      assert.ok(Number(orionUpdated.updated_at) >= 0);
    } finally {
      raw.close();
    }

    // A scoped save that drops a route in memory deletes only that row.
    const dropped = scopedControlState('orion', 700);
    dropped.sessionRoutes = [];
    db.saveControlState(dropped, { agentId: 'orion' });
    raw = probe();
    try {
      assert.equal(
        raw.prepare('SELECT COUNT(*) AS n FROM session_routes').get().n,
        1,
        'own dropped route is pruned, foreign row stays',
      );
    } finally {
      raw.close();
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function sharedSceneState(agent, status, historyLimit, lastSeenAt) {
  const state = scopedControlState(agent, lastSeenAt);
  const scene = state.sceneRegistry[0];
  scene.sceneKey = 'tgBot:-880001';
  scene.kind = 'group';
  scene.status = status;
  scene.groupId = '-880001';
  scene.groupReplyMode = 'all';
  scene.historyLimit = historyLimit;
  delete scene.userId;
  return state;
}

test('scoped scene saves keep one row per agent for a shared scene key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-scoped-scene-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  const probe = () => new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.saveControlState(sharedSceneState('orion', 'allowed', 20, 100), { agentId: 'orion' });
    db.saveControlState(sharedSceneState('public', 'denied', 60, 200), { agentId: 'public' });

    let raw = probe();
    try {
      const rows = raw
        .prepare(
          "SELECT agent_id, status, history_limit FROM scenes WHERE scene_key = 'tgBot:-880001' ORDER BY agent_id",
        )
        .all();
      assert.deepEqual(
        rows.map((row) => [row.agent_id, row.status, row.history_limit]),
        [
          ['orion', 'allowed', 20],
          ['public', 'denied', 60],
        ],
        'each agent keeps its own scene policy for the same scene key',
      );
    } finally {
      raw.close();
    }

    // A repeated scoped flush rewrites only its own row and keeps the values it carries.
    db.saveControlState(sharedSceneState('orion', 'denied', 30, 300), { agentId: 'orion' });
    raw = probe();
    try {
      const rows = raw
        .prepare(
          "SELECT agent_id, status, history_limit FROM scenes WHERE scene_key = 'tgBot:-880001' ORDER BY agent_id",
        )
        .all();
      assert.deepEqual(
        rows.map((row) => [row.agent_id, row.status, row.history_limit]),
        [
          ['orion', 'denied', 30],
          ['public', 'denied', 60],
        ],
        'own update lands while the other agent row is untouched',
      );
    } finally {
      raw.close();
    }

    // Unattributed legacy rows are neither claimed nor overwritten by a scoped flush.
    raw = new DatabaseSync(dbPath);
    raw
      .prepare(
        `INSERT INTO scenes (
           scene_key, kind, status, platform, group_id, agent_id, last_seen_at, created_at, updated_at
         ) VALUES ('tgBot:-880002', 'group', 'pending', 'tgBot', '-880002', NULL, 1, 1, 1)`,
      )
      .run();
    raw.close();
    db.saveControlState(sharedSceneState('orion', 'denied', 30, 400), { agentId: 'orion' });
    raw = probe();
    try {
      const legacy = raw
        .prepare("SELECT agent_id, status FROM scenes WHERE scene_key = 'tgBot:-880002'")
        .all();
      assert.deepEqual(
        legacy.map((row) => [row.agent_id, row.status]),
        [[null, 'pending']],
        'legacy scene row survives scoped flush unchanged',
      );
    } finally {
      raw.close();
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('scoped scene save stamps an unowned scene with the flushing agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-scene-owner-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  try {
    const state = sharedSceneState('orion', 'allowed', 20, 100);
    delete state.sceneRegistry[0].agentId;
    db.saveControlState(state, { agentId: 'orion' });
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = raw
        .prepare("SELECT agent_id, status FROM scenes WHERE scene_key = 'tgBot:-880001'")
        .get();
      assert.deepEqual(
        { agentId: row.agent_id, status: row.status },
        { agentId: 'orion', status: 'allowed' },
        'runtime scenes without an owner are attributed to the flushing agent',
      );
    } finally {
      raw.close();
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('migration 6 rebuilds scenes with per agent identity and preserves rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-migration-scenes-scope-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  try {
    const db = createBncrSqliteStateDatabase(dbPath);
    db.setStoreMode('sqlite');
    db.saveControlState(sharedSceneState('orion', 'allowed', 20, 100), { agentId: 'orion' });
    db.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE scenes_legacy (
      id INTEGER PRIMARY KEY,
      scene_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('direct','group')),
      status TEXT NOT NULL CHECK (status IN ('pending','allowed','denied')),
      platform TEXT NOT NULL,
      user_id TEXT,
      user_name TEXT,
      group_id TEXT,
      group_name TEXT,
      agent_id TEXT,
      group_reply_mode TEXT CHECK (group_reply_mode IN ('admin','mention','hybrid','all')),
      history_limit INTEGER CHECK (history_limit IS NULL OR history_limit >= 2),
      history_force INTEGER CHECK (history_force IN (0,1)),
      download_media INTEGER CHECK (download_media IN (0,1)),
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    raw.exec(`INSERT INTO scenes_legacy (
      id, scene_key, kind, status, platform, user_id, user_name, group_id, group_name,
      agent_id, group_reply_mode, history_limit, history_force, download_media,
      last_seen_at, created_at, updated_at
    ) SELECT id, scene_key, kind, status, platform, user_id, user_name, group_id, group_name,
      agent_id, group_reply_mode, history_limit, history_force, download_media,
      last_seen_at, created_at, updated_at FROM scenes`);
    raw.exec('DROP TABLE scenes');
    raw.exec('ALTER TABLE scenes_legacy RENAME TO scenes');
    raw.exec('CREATE INDEX idx_scenes_status ON scenes(status, kind, platform)');
    raw.exec('CREATE INDEX idx_scenes_last_seen ON scenes(last_seen_at)');
    raw.prepare('DELETE FROM schema_migrations WHERE version = 6').run();
    raw.close();

    const reopened = createBncrSqliteStateDatabase(dbPath);
    try {
      reopened.setStoreMode('sqlite');
      reopened.saveControlState(sharedSceneState('public', 'denied', 60, 200), {
        agentId: 'public',
      });
    } finally {
      reopened.close();
    }

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = verify
        .prepare(
          "SELECT agent_id, status, history_limit FROM scenes WHERE scene_key = 'tgBot:-880001' ORDER BY agent_id",
        )
        .all();
      assert.deepEqual(
        rows.map((row) => [row.agent_id, row.status, row.history_limit]),
        [
          ['orion', 'allowed', 20],
          ['public', 'denied', 60],
        ],
        'migrated row is preserved and the same key can be owned by another agent',
      );
      const index = verify
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_scenes_agent_scene'",
        )
        .get();
      assert.ok(index, 'agent scoped scene index exists after migration');
    } finally {
      verify.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scoped outbox save/load only rewrites this agents entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-scoped-outbox-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  try {
    db.saveOutboundState(
      [
        scopedOutboxEntry('m-orion', 'agent:orion:bncr:direct:10001'),
        scopedOutboxEntry('m-public', 'agent:public:bncr:group:20002'),
      ],
      [scopedOutboxEntry('m-legacy', 'legacy-no-agent', { lastError: 'x' })],
    );

    db.saveOutboundState(
      [scopedOutboxEntry('m-orion', 'agent:orion:bncr:direct:10001', { retryCount: 3 })],
      [],
      { agentId: 'orion' },
    );

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const keys = raw
        .prepare('SELECT session_key FROM outbound_messages ORDER BY session_key')
        .all()
        .map((row) => row.session_key);
      assert.deepEqual(
        keys,
        ['agent:orion:bncr:direct:10001', 'agent:public:bncr:group:20002', 'legacy-no-agent'],
        'foreign and unattributable entries survive a scoped flush',
      );
      assert.equal(
        raw.prepare('SELECT retry_count FROM outbound_messages WHERE message_id = ?').get('m-orion')
          .retry_count,
        3,
        'own entry is rewritten by the scoped flush',
      );
    } finally {
      raw.close();
    }

    const scopedLoad = db.loadOutboundState({ agentId: 'orion' });
    assert.equal(scopedLoad.outbox.length, 1);
    assert.equal(scopedLoad.outbox[0].messageId, 'm-orion');
    assert.equal(scopedLoad.deadLetter.length, 0);

    const fullLoad = db.loadOutboundState();
    assert.equal(fullLoad.outbox.length, 2);
    assert.equal(fullLoad.deadLetter.length, 1);
    assert.equal(fullLoad.deadLetter[0].messageId, 'm-legacy');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('scoped save over a full multi-agent state survives surviving rows instead of hard-blocking', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-scoped-fullstate-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  const probe = () => new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.saveControlState({
      sessionRoutes: [
        scopedControlState('orion', 100).sessionRoutes[0],
        scopedControlState('public', 100).sessionRoutes[0],
      ],
      sceneRegistry: [
        scopedControlState('orion', 100).sceneRegistry[0],
        scopedControlState('public', 100).sceneRegistry[0],
      ],
      lastSessionByAccount: [],
      lastActivityByAccount: [{ accountId: 'Primary', updatedAt: 500 }],
      lastInboundByAccount: [],
      lastOutboundByAccount: [],
      lastDriftSnapshot: null,
    });

    // Pairing a db-level full load with a scoped save used to crash on the
    // session_key primary key / scene_key unique constraint; the flush must
    // now upsert and leave surviving foreign rows untouched.
    const full = db.loadControlState();
    db.saveControlState(full, { agentId: 'orion' });

    let raw = probe();
    try {
      const rows = raw.prepare('SELECT session_key FROM session_routes ORDER BY session_key').all();
      assert.deepEqual(
        rows.map((row) => row.session_key),
        ['agent:orion:bncr:direct:10001', 'agent:public:bncr:direct:10001'],
      );
      assert.equal(
        raw.prepare("SELECT COUNT(*) AS n FROM scenes WHERE agent_id = 'public'").get().n,
        1,
        'foreign scene survives a scoped flush',
      );
      assert.equal(
        raw
          .prepare(
            "SELECT event_at FROM account_activity WHERE account_id = 'Primary' AND activity_type = 'last_activity'",
          )
          .get().event_at,
        500,
        'shared activity merge is idempotent on equal event times',
      );
    } finally {
      raw.close();
    }

    // A scoped flush with stale activity still never clobbers the fresher row.
    db.saveControlState({ ...full, lastActivityByAccount: [] }, { agentId: 'orion' });
    raw = probe();
    try {
      assert.equal(
        raw
          .prepare(
            "SELECT event_at FROM account_activity WHERE account_id = 'Primary' AND activity_type = 'last_activity'",
          )
          .get().event_at,
        500,
      );
    } finally {
      raw.close();
    }

    assert.equal(db.loadControlState().sessionRoutes.length, 2, 'full load still sees both agents');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('scoped flush leaves a fresher foreign scene row untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-scene-freshness-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  const sceneRow = (agentId, status, groupReplyMode, lastSeenAt) => ({
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status,
    platform: 'tgBot',
    groupId: '-1001',
    agentId,
    groupReplyMode,
    lastSeenAt,
  });
  try {
    db.saveControlState({
      sessionRoutes: [],
      sceneRegistry: [
        sceneRow('orion', 'allowed', 'all', 100),
        sceneRow('public', 'allowed', 'mention', 300),
      ],
      lastSessionByAccount: [],
      lastActivityByAccount: [],
      lastInboundByAccount: [],
      lastOutboundByAccount: [],
      lastDriftSnapshot: null,
    });

    // A stale copy of the public row sits in this process's memory; flushing as
    // orion must not rewrite it with older settings.
    const full = db.loadControlState();
    const stale = full.sceneRegistry.map((scene) =>
      scene.agentId === 'public'
        ? { ...scene, status: 'denied', groupReplyMode: 'admin', lastSeenAt: 200 }
        : scene,
    );
    db.saveControlState({ ...full, sceneRegistry: stale, sessionRoutes: [] }, { agentId: 'orion' });

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const publicRow = raw
        .prepare(
          "SELECT status, group_reply_mode, last_seen_at FROM scenes WHERE scene_key = 'tgBot:-1001' AND agent_id = 'public'",
        )
        .get();
      assert.deepEqual(
        { ...publicRow },
        { status: 'allowed', group_reply_mode: 'mention', last_seen_at: 300 },
        'the newer foreign row keeps its settings',
      );
      const orionRow = raw
        .prepare(
          "SELECT status, group_reply_mode, last_seen_at FROM scenes WHERE scene_key = 'tgBot:-1001' AND agent_id = 'orion'",
        )
        .get();
      assert.deepEqual(
        { ...orionRow },
        { status: 'allowed', group_reply_mode: 'all', last_seen_at: 100 },
        'the flushing agent row is still rewritten',
      );
    } finally {
      raw.close();
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('scoped flush keeps legacy unowned scenes unowned and owns only new local scenes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-scene-legacy-'));
  const dbPath = join(dir, 'bncr.sqlite3');
  const db = createBncrSqliteStateDatabase(dbPath);
  db.setStoreMode('sqlite');
  const scene = (sceneKey, agentId) => ({
    sceneKey,
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: sceneKey.split(':')[1],
    ...(agentId ? { agentId } : {}),
    groupReplyMode: 'mention',
    lastSeenAt: 100,
  });
  try {
    db.saveControlState({
      sessionRoutes: [],
      sceneRegistry: [scene('tgBot:-2001')],
      lastSessionByAccount: [],
      lastActivityByAccount: [],
      lastInboundByAccount: [],
      lastOutboundByAccount: [],
      lastDriftSnapshot: null,
    });

    const full = db.loadControlState();
    db.saveControlState(
      { ...full, sceneRegistry: [...full.sceneRegistry, scene('tgBot:-2002')] },
      { agentId: 'public' },
    );

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = raw
        .prepare('SELECT scene_key, agent_id FROM scenes ORDER BY scene_key')
        .all()
        .map((row) => [row.scene_key, row.agent_id]);
      assert.deepEqual(
        rows,
        [
          ['tgBot:-2001', null],
          ['tgBot:-2002', 'public'],
        ],
        'legacy row stays unattributed; the locally created scene is owned by the flusher',
      );
    } finally {
      raw.close();
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
