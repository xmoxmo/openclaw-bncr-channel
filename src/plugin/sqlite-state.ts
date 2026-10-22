import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BNCR_DEFAULT_ACCOUNT_ID, normalizeAccountId } from '../core/accounts.ts';
import { emitBncrLog } from '../core/logging.ts';
import {
  dumpRegisterDriftSnapshot,
  normalizeRegisterDriftSnapshot,
  type RegisterDriftSnapshot,
} from '../core/register-trace.ts';
import type { BncrRoute, OutboxEntry } from '../core/types.ts';
import {
  normalizePersistedHistoryKey,
  resolvePersistedHistoryAccountId,
  resolvePersistedHistoryKey,
} from '../messaging/inbound/conversation-history.ts';
import type {
  BncrGroupReplyMode,
  BncrPersistedAccountTimestamp,
  BncrPersistedConversationHistoryBucket,
  BncrPersistedConversationHistoryEntry,
  BncrPersistedLastSession,
  BncrPersistedOutboundReplayBucket,
  BncrPersistedOutboundReplayEntry,
  BncrPersistedSessionRoute,
  BncrSceneRecord,
} from './channel-runtime-types.ts';

export type BncrSqliteStoreMode = 'json' | 'dual' | 'sqlite';

export type BncrSqliteControlState = {
  sessionRoutes: BncrPersistedSessionRoute[];
  sceneRegistry: BncrSceneRecord[];
  lastSessionByAccount: BncrPersistedLastSession[];
  lastActivityByAccount: BncrPersistedAccountTimestamp[];
  lastInboundByAccount: BncrPersistedAccountTimestamp[];
  lastOutboundByAccount: BncrPersistedAccountTimestamp[];
  lastDriftSnapshot: RegisterDriftSnapshot | null;
};

export type BncrSqliteHistoryState = {
  historyBuckets: BncrPersistedConversationHistoryBucket[];
  replayBuckets: BncrPersistedOutboundReplayBucket[];
};

export type BncrSqliteOutboundState = {
  outbox: OutboxEntry[];
  deadLetter: OutboxEntry[];
};

export type BncrHistoryShardCreateInput = {
  historyKey: string;
  accountId?: string;
  payloadJson: string;
  messageIds: readonly string[];
  bufferKeys: readonly string[];
};

export type BncrHistoryShardCreateResult = {
  shardId: number;
  created: boolean;
};

export type BncrHistoryShardRow = {
  id: number;
  historyKey: string;
  accountId: string | null;
  status: string;
  attempts: number;
  payloadJson: string;
  messageIds: string[];
  bufferKeys: string[];
  lastError: string | null;
  nextAttemptAt: number | null;
  owner?: string;
};

export type BncrHistoryShardFailureResult = {
  attempts: number;
  terminal: boolean;
};

export type BncrHistoryShardQueue = {
  createHistoryShard: (input: BncrHistoryShardCreateInput) => BncrHistoryShardCreateResult | null;
  claimNextHistoryShard: (owner?: string) => BncrHistoryShardRow | null;
  reconcileHistoryMemory?: (historyKey?: string) => void | Promise<void>;
  markHistoryShardProcessing: (shardId: number, owner?: string) => boolean;
  markHistoryShardFailed: (
    shardId: number,
    error: unknown,
    owner?: string,
  ) => BncrHistoryShardFailureResult;
  markHistoryShardCompleted: (shardId: number, owner?: string) => boolean;
  renewHistoryShardLease: (shardId: number, owner?: string) => boolean;
  completeHistoryShard: (shardId: number, owner?: string) => void;
};

export type BncrSqliteStateDatabase = {
  getPath: () => string;
  close: () => void;
  rotateSnapshot: () => string | null;
  getStoreMode: () => BncrSqliteStoreMode | null;
  isControlStateImported: () => boolean;
  isHistoryImported: () => boolean;
  setStoreMode: (mode: BncrSqliteStoreMode) => void;
  getMeta: (key: string) => string | null;
  setMeta: (key: string, value: string) => void;
  ensureMigrated: () => void;
  importControlState: (
    state: BncrSqliteControlState,
    options?: {
      storeMode?: BncrSqliteStoreMode;
      legacyJsonPath?: string;
      legacyJsonSha256?: string;
    },
  ) => void;
  loadControlState: () => BncrSqliteControlState;
  saveControlState: (
    state: BncrSqliteControlState,
    scope?: { agentId?: string | null },
    removedScenes?: readonly BncrRemovedSceneRow[],
  ) => void;
  importHistoryState: (
    historyBuckets: BncrPersistedConversationHistoryBucket[],
    replayBuckets: BncrPersistedOutboundReplayBucket[],
  ) => void;
  loadHistoryState: (skipHistoryKeys?: readonly string[], owner?: string) => BncrSqliteHistoryState;
  getHistoryStateRevision: () => number;
  saveHistoryState: (
    historyBuckets: BncrPersistedConversationHistoryBucket[],
    replayBuckets: BncrPersistedOutboundReplayBucket[],
    expectedRevision?: number,
  ) => void;
  isOutboundImported: () => boolean;
  importOutboundState: (outbox: OutboxEntry[], deadLetter: OutboxEntry[]) => void;
  loadOutboundState: (scope?: { agentId?: string | null }) => BncrSqliteOutboundState;
  saveOutboundState: (
    outbox: OutboxEntry[],
    deadLetter: OutboxEntry[],
    scope?: { agentId?: string | null },
  ) => void;
  createHistoryShard: (input: BncrHistoryShardCreateInput) => BncrHistoryShardCreateResult;
  markHistoryShardProcessing: (shardId: number, owner?: string) => boolean;
  markHistoryShardFailed: (
    shardId: number,
    error: unknown,
    owner?: string,
  ) => BncrHistoryShardFailureResult;
  markHistoryShardCompleted: (shardId: number, owner?: string) => boolean;
  renewHistoryShardLease: (shardId: number, owner?: string) => boolean;
  completeHistoryShard: (shardId: number, owner?: string) => void;
  recoverHistoryShards: (skipHistoryKeys?: readonly string[], owner?: string) => number;
  recoverInFlightHistoryShards: (skipHistoryKeys?: readonly string[], owner?: string) => number;
  restoreTerminalHistoryShardsToActive: () => BncrSqliteHistoryState;
  claimNextHistoryShard: (
    skipHistoryKeys?: readonly string[],
    owner?: string,
  ) => BncrHistoryShardRow | null;
  cleanupCompletedHistoryShards: () => number;
  listHistoryShards: () => BncrHistoryShardRow[];
};

type Migration = {
  version: number;
  name: string;
  up: string;
};

const SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'bncr-sqlite-control-state',
    up: `
CREATE TABLE state_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE routes (
  id INTEGER PRIMARY KEY,
  route_key TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  group_id TEXT NOT NULL DEFAULT '0',
  user_id TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_routes_identity ON routes(platform, group_id, user_id);

CREATE TABLE session_routes (
  session_key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE RESTRICT,
  platform TEXT NOT NULL,
  group_id TEXT NOT NULL DEFAULT '0',
  user_id TEXT NOT NULL DEFAULT '0',
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_session_routes_account ON session_routes(account_id, updated_at);
CREATE INDEX idx_session_routes_route ON session_routes(platform, group_id, user_id, account_id);

CREATE TABLE scenes (
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
);

CREATE INDEX idx_scenes_status ON scenes(status, kind, platform);
CREATE INDEX idx_scenes_last_seen ON scenes(last_seen_at);

CREATE TABLE account_activity (
  account_id TEXT NOT NULL,
  activity_type TEXT NOT NULL CHECK (
    activity_type IN ('last_session','last_activity','last_inbound','last_outbound')
  ),
  session_key TEXT,
  session_scope TEXT,
  event_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, activity_type)
);

CREATE INDEX idx_account_activity_updated ON account_activity(updated_at);

CREATE TABLE history_shards (
  id INTEGER PRIMARY KEY,
  account_id TEXT,
  history_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued','claimed','processing','completed','failed','abandoned')
  ),
  payload_json TEXT NOT NULL,
  message_ids_json TEXT NOT NULL DEFAULT '[]',
  buffer_keys_json TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER,
  claim_token TEXT UNIQUE,
  claim_owner TEXT,
  claimed_at INTEGER,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  queued_at INTEGER NOT NULL,
  upload_started_at INTEGER,
  upload_completed_at INTEGER,
  cleanup_started_at INTEGER,
  cleanup_completed_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_history_shards_ready ON history_shards(status, next_attempt_at, id);
CREATE INDEX idx_history_shards_key ON history_shards(account_id, history_key, id);

CREATE TABLE conversation_messages (
  id INTEGER PRIMARY KEY,
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('history','replay')),
  history_key TEXT NOT NULL,
  buffer_key TEXT NOT NULL,
  account_id TEXT,
  sender TEXT NOT NULL,
  sender_id TEXT,
  role TEXT CHECK (role IN ('user','assistant','system')),
  body TEXT NOT NULL,
  message_ts INTEGER,
  message_id TEXT,
  media_json TEXT NOT NULL DEFAULT '[]',
  session_key TEXT,
  replay_status TEXT CHECK (replay_status IN ('pushed','acked')),
  outbound_type TEXT,
  media_url TEXT,
  outbound_created_at INTEGER,
  route_platform TEXT,
  route_group_id TEXT,
  route_user_id TEXT,
  shard_id INTEGER REFERENCES history_shards(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_conv_pending ON conversation_messages(history_key, storage_kind, shard_id, id);
CREATE INDEX idx_conv_buffer ON conversation_messages(buffer_key, storage_kind, id);
CREATE INDEX idx_conv_message_id ON conversation_messages(history_key, message_id);
CREATE INDEX idx_conv_shard ON conversation_messages(shard_id);

CREATE TABLE outbound_messages (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  route_platform TEXT NOT NULL,
  route_group_id TEXT NOT NULL DEFAULT '0',
  route_user_id TEXT NOT NULL DEFAULT '0',
  payload_json TEXT NOT NULL,
  queue_state TEXT NOT NULL DEFAULT 'queued' CHECK (
    queue_state IN ('queued','claimed','dead','completed','removed')
  ),
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_error TEXT,
  last_push_at INTEGER,
  last_push_conn_id TEXT,
  last_push_client_id TEXT,
  route_attempt_conn_ids_json TEXT NOT NULL DEFAULT '[]',
  route_attempt_round INTEGER NOT NULL DEFAULT 0,
  fast_reroute_pending INTEGER NOT NULL DEFAULT 0,
  awaiting_retry_push INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_outbound_ready ON outbound_messages(queue_state, next_attempt_at, id);
CREATE INDEX idx_outbound_account ON outbound_messages(account_id, created_at);
CREATE INDEX idx_outbound_dead ON outbound_messages(queue_state, created_at);

CREATE TABLE register_drift (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  captured_at INTEGER NOT NULL,
  register_count INTEGER NOT NULL,
  api_generation INTEGER NOT NULL,
  post_warmup_register_count INTEGER NOT NULL,
  api_instance_id TEXT NOT NULL,
  registry_fingerprint TEXT NOT NULL,
  dominant_bucket TEXT,
  source_buckets_json TEXT NOT NULL DEFAULT '{}',
  trace_window_size INTEGER NOT NULL,
  trace_recent_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'bncr-conversation-active-message-dedupe',
    up: `
DELETE FROM conversation_messages
WHERE shard_id IS NULL
  AND message_id IS NOT NULL
  AND message_id != ''
  AND id NOT IN (
    SELECT MIN(id)
    FROM conversation_messages
    WHERE shard_id IS NULL
      AND message_id IS NOT NULL
      AND message_id != ''
    GROUP BY storage_kind, message_id
  );

CREATE UNIQUE INDEX idx_conv_dedupe_active
  ON conversation_messages(storage_kind, message_id)
  WHERE shard_id IS NULL AND message_id IS NOT NULL AND message_id != '';
`,
  },
  {
    version: 3,
    name: 'bncr-history-shard-dedupe-key',
    up: `
ALTER TABLE history_shards ADD COLUMN dedupe_key TEXT;
UPDATE history_shards SET dedupe_key = 'legacy:' || id WHERE dedupe_key IS NULL;
CREATE UNIQUE INDEX idx_history_shards_dedupe_key ON history_shards(dedupe_key);
`,
  },
  {
    version: 4,
    name: 'bncr-conversation-scoped-active-dedupe',
    up: `
DELETE FROM conversation_messages
WHERE shard_id IS NULL
  AND message_id IS NOT NULL
  AND message_id != ''
  AND id NOT IN (
    SELECT MIN(id)
    FROM conversation_messages
    WHERE shard_id IS NULL
      AND message_id IS NOT NULL
      AND message_id != ''
    GROUP BY storage_kind,
      CASE WHEN storage_kind = 'history' THEN history_key ELSE buffer_key END,
      message_id
  );

DROP INDEX IF EXISTS idx_conv_dedupe_active;
CREATE UNIQUE INDEX idx_conv_history_dedupe_active
  ON conversation_messages(history_key, message_id)
  WHERE storage_kind = 'history'
    AND shard_id IS NULL
    AND message_id IS NOT NULL
    AND message_id != '';
    CREATE UNIQUE INDEX idx_conv_replay_dedupe_active
      ON conversation_messages(buffer_key, message_id)
      WHERE storage_kind = 'replay'
        AND shard_id IS NULL
        AND message_id IS NOT NULL
        AND message_id != '';
`,
  },
  {
    version: 5,
    name: 'bncr-history-consumed-message-tombstones',
    up: `
CREATE TABLE history_message_consumed (
  id INTEGER PRIMARY KEY,
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('history','replay')),
  history_key TEXT NOT NULL,
  buffer_key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  consumed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (storage_kind, history_key, buffer_key, message_id)
);

CREATE INDEX idx_history_message_consumed_at ON history_message_consumed(consumed_at);
`,
  },
  {
    version: 6,
    name: 'bncr-scenes-agent-scoped-identity',
    up: `
CREATE TABLE scenes_scoped (
  id INTEGER PRIMARY KEY,
  scene_key TEXT NOT NULL,
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
);

INSERT INTO scenes_scoped (
  id, scene_key, kind, status, platform, user_id, user_name, group_id, group_name,
  agent_id, group_reply_mode, history_limit, history_force, download_media,
  last_seen_at, created_at, updated_at
)
SELECT id, scene_key, kind, status, platform, user_id, user_name, group_id, group_name,
       agent_id, group_reply_mode, history_limit, history_force, download_media,
       last_seen_at, created_at, updated_at
FROM scenes;

DROP TABLE scenes;
ALTER TABLE scenes_scoped RENAME TO scenes;

CREATE INDEX idx_scenes_status ON scenes(status, kind, platform);
CREATE INDEX idx_scenes_last_seen ON scenes(last_seen_at);
CREATE UNIQUE INDEX idx_scenes_agent_scene ON scenes(COALESCE(agent_id, ''), scene_key);
`,
  },
  {
    version: 7,
    name: 'bncr-scenes-explicit-approval',
    up: `
ALTER TABLE scenes ADD COLUMN approved_at INTEGER;
`,
  },
];

const HISTORY_SHARD_LEASE_MS = 5 * 60 * 1000;
const HISTORY_SHARD_MAX_ATTEMPTS = 8;
const HISTORY_SHARD_RETRY_BASE_MS = 5_000;
const HISTORY_SHARD_RETRY_MAX_MS = 5 * 60 * 1000;
const HISTORY_CONSUMED_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Startup integrity-class failure: open failure, quick_check, foreign-key violations, or
 * structural contract drift. Eligible for automatic recovery from a verified snapshot.
 */
export class BncrSqliteIntegrityFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BncrSqliteIntegrityFailure';
  }
}

/**
 * Migration lineage failure: the database carries migrations this plugin cannot map
 * (future version or name drift). Must fail closed; never eligible for snapshot recovery.
 */
export class BncrSqliteMigrationLineageFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BncrSqliteMigrationLineageFailure';
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Early local 0.6.x databases were created before checksum enforcement. These exact values
// identify known schema lineage and are normalized to the current checksum during startup.
const LEGACY_MIGRATION_CHECKSUMS: Readonly<Record<number, readonly string[]>> = {
  2: ['2f750f4526fa72b07676d8043a5829c6e392dcbb6a5ad9a0fa42171b82065ce8'],
};

function migrationChecksum(migration: Migration): string {
  return createHash('sha256')
    .update(`${migration.version}:${migration.name}:${migration.up}`)
    .digest('hex');
}

type AppliedMigrationRow = {
  version: number;
  name: string;
  checksum: string;
};

function assertAppliedMigrations(rows: AppliedMigrationRow[]): void {
  const expectedByVersion = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));
  for (const row of rows) {
    const expected = expectedByVersion.get(row.version);
    if (!expected) {
      throw new BncrSqliteMigrationLineageFailure(
        `bncr sqlite migration ${row.version} is newer than this plugin supports`,
      );
    }
    if (row.name !== expected.name) {
      throw new BncrSqliteMigrationLineageFailure(
        `bncr sqlite migration ${row.version} name mismatch`,
      );
    }
  }
}

function normalizeAppliedMigrationChecksums(db: DatabaseSync, rows: AppliedMigrationRow[]): number {
  const expectedByVersion = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));
  const update = db.prepare(
    'UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum = ?',
  );
  let normalized = 0;
  for (const row of rows) {
    const expected = expectedByVersion.get(row.version);
    if (!expected) continue;
    const expectedChecksum = migrationChecksum(expected);
    if (row.checksum === expectedChecksum) continue;
    const acceptedChecksums = LEGACY_MIGRATION_CHECKSUMS[row.version] ?? [];
    if (!acceptedChecksums.includes(row.checksum)) continue;
    normalized += Number(update.run(expectedChecksum, row.version, row.checksum).changes);
  }
  return normalized;
}

function normalizeSchemaSql(sql: string | null): string {
  if (!sql) return '';
  let normalized = '';
  let pendingSpace = false;
  let quote: "'" | '"' | '`' | ']' | null = null;
  for (const character of sql.trim()) {
    if (quote) {
      normalized += character;
      if (quote === ']' ? character === ']' : character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      if (pendingSpace && normalized && !normalized.endsWith('(')) normalized += ' ';
      pendingSpace = false;
      quote = character;
      normalized += character;
      continue;
    }
    if (character === '[') {
      if (pendingSpace && normalized && !normalized.endsWith('(')) normalized += ' ';
      pendingSpace = false;
      quote = ']';
      normalized += character;
      continue;
    }
    if (/\s/.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (character === '(' || character === ')' || character === ',') {
      normalized = normalized.trimEnd() + character;
      pendingSpace = false;
      continue;
    }
    if (pendingSpace && normalized && !normalized.endsWith('(')) normalized += ' ';
    pendingSpace = false;
    normalized += character;
  }
  return normalized.trim();
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

type SchemaContractRow = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};

type TableInfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
};

type ForeignKeyRow = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
  match: string;
};

type IndexListRow = {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
};

type IndexInfoRow = {
  seqno: number;
  cid: number;
  name: string | null;
  desc: number;
  coll: string | null;
  key: number;
};

function inspectSqliteSchemaContract(db: DatabaseSync): string[] {
  const objects = db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND type IN ('table', 'index', 'trigger', 'view')
       ORDER BY type ASC, name ASC`,
    )
    .all() as SchemaContractRow[];
  const contract: string[] = [];
  for (const object of objects) {
    contract.push(
      `object|${object.type}|${object.name}|${object.tbl_name}|${normalizeSchemaSql(object.sql)}`,
    );
  }

  for (const table of objects.filter((object) => object.type === 'table')) {
    const identifier = quoteSqliteIdentifier(table.name);
    const columns = db.prepare(`PRAGMA table_xinfo(${identifier})`).all() as TableInfoRow[];
    for (const column of columns) {
      contract.push(
        `column|${table.name}|${column.cid}|${column.name}|${column.type}|${column.notnull}|${normalizeSchemaSql(column.dflt_value)}|${column.pk}|${column.hidden}`,
      );
    }

    const foreignKeys = db
      .prepare(`PRAGMA foreign_key_list(${identifier})`)
      .all() as ForeignKeyRow[];
    for (const foreignKey of foreignKeys) {
      contract.push(
        `foreign-key|${table.name}|${foreignKey.id}|${foreignKey.seq}|${foreignKey.table}|${foreignKey.from}|${foreignKey.to ?? ''}|${foreignKey.on_update}|${foreignKey.on_delete}|${foreignKey.match}`,
      );
    }

    const indexes = (db.prepare(`PRAGMA index_list(${identifier})`).all() as IndexListRow[]).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const index of indexes) {
      contract.push(
        `index|${table.name}|${index.name}|${index.unique}|${index.origin}|${index.partial}`,
      );
      const indexInfo = db
        .prepare(`PRAGMA index_xinfo(${quoteSqliteIdentifier(index.name)})`)
        .all() as IndexInfoRow[];
      for (const item of indexInfo) {
        contract.push(
          `index-column|${table.name}|${index.name}|${item.seqno}|${item.cid}|${item.name ?? ''}|${item.desc}|${item.coll ?? ''}|${item.key}`,
        );
      }
    }
  }
  return contract.sort();
}

let expectedSchemaContract: readonly string[] | null = null;

function getExpectedSchemaContract(): readonly string[] {
  if (expectedSchemaContract) return expectedSchemaContract;
  const reference = new DatabaseSync(':memory:');
  try {
    applyMigrations(reference, () => 0, false);
    expectedSchemaContract = inspectSqliteSchemaContract(reference);
    return expectedSchemaContract;
  } finally {
    reference.close();
  }
}

function assertSqliteWriteContract(db: DatabaseSync): void {
  const expected = getExpectedSchemaContract();
  const actual = inspectSqliteSchemaContract(db);
  const expectedTables = new Set(
    expected
      .filter((entry) => entry.startsWith('object|table|'))
      .map((entry) => entry.split('|')[2]),
  );
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((entry) => !actualSet.has(entry));
  const unexpected = actual.filter((entry) => {
    if (expectedSet.has(entry)) return false;
    const [kind, owner, name, tableName] = entry.split('|');
    if (kind === 'object' && (owner === 'trigger' || owner === 'view')) return false;
    if (kind === 'object' && owner === 'table') return expectedTables.has(name);
    if (kind === 'object' && owner === 'index') return expectedTables.has(tableName);
    return expectedTables.has(owner);
  });
  if (missing.length === 0 && unexpected.length === 0) return;
  const describe = (entries: readonly string[]) =>
    entries.slice(0, 3).join(' | ') + (entries.length > 3 ? ` | +${entries.length - 3} more` : '');
  const details = [
    missing.length > 0 ? `missing ${describe(missing)}` : '',
    unexpected.length > 0 ? `unexpected ${describe(unexpected)}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  throw new Error(`bncr sqlite write contract mismatch: ${details}`);
}

function assertSqliteDatabaseHealth(db: DatabaseSync): void {
  const quickCheck = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
  const invalid = quickCheck.filter((row) => row.quick_check !== 'ok');
  if (invalid.length > 0) {
    throw new Error(
      `bncr sqlite integrity check failed: ${invalid.map((row) => row.quick_check).join(' | ')}`,
    );
  }
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyViolations.length > 0) {
    throw new Error(
      `bncr sqlite foreign key check failed: ${foreignKeyViolations.length} violation(s)`,
    );
  }
}

function runWriteTransaction<T>(db: DatabaseSync, write: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    assertSqliteWriteContract(db);
    const result = write();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original write or contract failure.
    }
    throw error;
  }
}

function applyMigrations(db: DatabaseSync, now: () => number, validateWriteContract = true): void {
  try {
    db.exec(SCHEMA_MIGRATIONS);
  } catch (error) {
    throw new BncrSqliteIntegrityFailure(
      `bncr sqlite schema initialization failed: ${errorMessageOf(error)}`,
      { cause: error },
    );
  }

  for (const migration of MIGRATIONS) {
    const checksum = migrationChecksum(migration);
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db
        .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC')
        .all() as AppliedMigrationRow[];
      assertAppliedMigrations(rows);
      normalizeAppliedMigrationChecksums(db, rows);
      if (rows.some((row) => row.version === migration.version)) {
        db.exec('COMMIT');
        continue;
      }
      db.exec(migration.up);
      db.prepare(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(migration.version, migration.name, checksum, now());
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original migration failure.
      }
      if (error instanceof BncrSqliteMigrationLineageFailure) throw error;
      throw new BncrSqliteIntegrityFailure(
        `bncr sqlite migration ${migration.version} failed: ${errorMessageOf(error)}`,
        { cause: error },
      );
    }
  }
  try {
    assertSqliteDatabaseHealth(db);
  } catch (error) {
    throw new BncrSqliteIntegrityFailure(
      `bncr sqlite startup health check failed: ${errorMessageOf(error)}`,
      { cause: error },
    );
  }
  if (validateWriteContract) {
    try {
      assertSqliteWriteContract(db);
    } catch (error) {
      throw new BncrSqliteIntegrityFailure(
        `bncr sqlite startup write contract check failed: ${errorMessageOf(error)}`,
        { cause: error },
      );
    }
  }
}

function buildRouteKey(route: BncrRoute): string {
  const platform = String(route?.platform || '').trim();
  const groupId = String(route?.groupId || '0').trim() || '0';
  const userId = String(route?.userId || '0').trim() || '0';
  return `${platform}:${groupId}:${userId}`;
}

function agentSessionKeyLike(agentId: string): string {
  const escaped = agentId.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  return `agent:${escaped}:bncr:%`;
}

export type BncrRemovedSceneRow = {
  sceneKey: string;
  agentId?: string | null;
  lastSeenAt?: number;
};

function replaceControlState(
  db: DatabaseSync,
  state: BncrSqliteControlState,
  now: () => number,
  agentId?: string | null,
  removedScenes?: readonly BncrRemovedSceneRow[],
): void {
  const scope = String(agentId ?? '').trim();
  runWriteTransaction(db, () => {
    if (scope) {
      // Agent-scoped persistence: only touch the rows this agent owns, so
      // concurrent agent instances sharing one state DB never overwrite each
      // other's session routes or scenes.
      db.prepare(`DELETE FROM session_routes WHERE session_key LIKE ? ESCAPE '\\'`).run(
        agentSessionKeyLike(scope),
      );
      db.prepare('DELETE FROM routes WHERE id NOT IN (SELECT route_id FROM session_routes)').run();
      db.prepare('DELETE FROM scenes WHERE agent_id = ?').run(scope);
    } else {
      // An unscoped flush has no owner to prove ownership of agent-scoped
      // rows. Never blanket-clear shared tables here: another agent's access
      // settings may have been written after this process loaded its snapshot.
      // Only unowned legacy scenes are rewritten; owned rows are merged below.
      db.exec("DELETE FROM scenes WHERE COALESCE(agent_id, '') = ''");
    }

    // Scenes removed from the live registry were revoked on purpose. The scoped
    // delete above only covers this agent's rows, so apply explicit removals for
    // rows owned by another agent as well.
    if (removedScenes?.length) {
      const deleteSceneFresh = db.prepare(
        "DELETE FROM scenes WHERE scene_key = ? AND COALESCE(agent_id, '') = ? AND last_seen_at <= ?",
      );
      const deleteSceneAny = db.prepare(
        "DELETE FROM scenes WHERE scene_key = ? AND COALESCE(agent_id, '') = ?",
      );
      for (const removal of removedScenes) {
        const sceneKey = String(removal?.sceneKey || '').trim();
        if (!sceneKey) continue;
        const sceneAgent = String(removal?.agentId ?? '').trim();
        const seen = Number(removal?.lastSeenAt);
        // A row another process re-created after this process loaded it is newer
        // than the removal snapshot; deleting it would undo that process's write.
        if (Number.isFinite(seen)) deleteSceneFresh.run(sceneKey, sceneAgent, seen);
        else deleteSceneAny.run(sceneKey, sceneAgent);
      }
    }

    const insertRoute = db.prepare(
      `INSERT INTO routes (route_key, platform, group_id, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(route_key) DO UPDATE SET updated_at = excluded.updated_at`,
    );
    const selectRoute = db.prepare('SELECT id FROM routes WHERE route_key = ?');
    // Scoped saves only delete this agent's session rows; surviving rows
    // (other agents, unattributed legacy) must never hard-block the flush,
    // so inserts upsert instead of crashing on the session_key primary key.
    const insertSessionRoute = db.prepare(
      `INSERT INTO session_routes (
         session_key, account_id, route_id, platform, group_id, user_id, updated_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_key) DO UPDATE SET updated_at = excluded.updated_at`,
    );

    const timestamp = now();
    for (const entry of state.sessionRoutes) {
      const route = entry.route;
      if (!route?.platform) continue;
      const routeKey = buildRouteKey(route);
      const created = Number(entry.updatedAt) || timestamp;
      insertRoute.run(
        routeKey,
        route.platform,
        route.groupId || '0',
        route.userId || '0',
        created,
        created,
      );
      const routeRow = selectRoute.get(routeKey) as { id: number } | undefined;
      if (!routeRow) continue;
      insertSessionRoute.run(
        entry.sessionKey,
        entry.accountId,
        routeRow.id,
        route.platform,
        route.groupId || '0',
        route.userId || '0',
        Number(entry.updatedAt) || timestamp,
        created,
      );
    }

    // Scenes are identified per agent: two agents may watch the same chat, so the
    // row identity is (agent_id, scene_key). A conflicting row of the same agent is
    // rewritten in place (self-healing); foreign rows cannot absorb this flush.
    const insertScene = db.prepare(
      `INSERT INTO scenes (
         scene_key, kind, status, platform, user_id, user_name, group_id, group_name,
         agent_id, group_reply_mode, history_limit, history_force, download_media,
         approved_at, last_seen_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(COALESCE(agent_id, ''), scene_key) DO UPDATE SET
         kind = excluded.kind,
         status = excluded.status,
         platform = excluded.platform,
         user_id = excluded.user_id,
         user_name = excluded.user_name,
         group_id = excluded.group_id,
         group_name = excluded.group_name,
         group_reply_mode = excluded.group_reply_mode,
         history_limit = excluded.history_limit,
         history_force = excluded.history_force,
         download_media = excluded.download_media,
         approved_at = excluded.approved_at,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at
       WHERE excluded.last_seen_at >= scenes.last_seen_at`,
    );
    // A row that already exists without an owner stays unattributed: attributing
    // it to this flush would leave the legacy row behind and duplicate the scene
    // as a second, agent-owned row. Only locally created unowned scenes get the
    // flushing agent as their owner.
    const hasUnownedScene = db.prepare(
      "SELECT 1 AS hit FROM scenes WHERE scene_key = ? AND COALESCE(agent_id, '') = '' LIMIT 1",
    );
    for (const scene of state.sceneRegistry) {
      let sceneAgentId = scene.agentId ?? null;
      if (!sceneAgentId && scope && !hasUnownedScene.get(scene.sceneKey)) sceneAgentId = scope;
      insertScene.run(
        scene.sceneKey,
        scene.kind,
        scene.status,
        scene.platform,
        scene.userId ?? null,
        scene.userName ?? null,
        scene.groupId ?? null,
        scene.groupName ?? null,
        sceneAgentId,
        scene.groupReplyMode ?? null,
        scene.historyLimit ?? null,
        scene.historyForce === undefined ? null : scene.historyForce ? 1 : 0,
        scene.downloadMedia === undefined ? null : scene.downloadMedia ? 1 : 0,
        typeof scene.approvedAt === 'number' && scene.approvedAt > 0 ? scene.approvedAt : null,
        Number(scene.lastSeenAt) || timestamp,
        timestamp,
        timestamp,
      );
    }

    // account_activity is account-level and shared across agents: a scoped flush
    // merges instead of rewriting; only a newer-or-equal activity event wins
    // (flush time alone must not let a stale entry clobber a fresher one).
    const insertActivity = db.prepare(
      `INSERT INTO account_activity (
         account_id, activity_type, session_key, session_scope, event_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, activity_type) DO UPDATE SET
         session_key = excluded.session_key,
         session_scope = excluded.session_scope,
         event_at = excluded.event_at,
         updated_at = excluded.updated_at
       WHERE excluded.event_at >= account_activity.event_at`,
    );
    const insertActivityAt = (accountId: string, activityType: string, value: number) => {
      insertActivity.run(
        accountId,
        activityType,
        null,
        null,
        Number(value) || timestamp,
        timestamp,
      );
    };
    for (const entry of state.lastSessionByAccount) {
      insertActivity.run(
        entry.accountId,
        'last_session',
        entry.sessionKey,
        entry.scope,
        Number(entry.updatedAt) || timestamp,
        timestamp,
      );
    }
    for (const entry of state.lastActivityByAccount)
      insertActivityAt(entry.accountId, 'last_activity', entry.updatedAt);
    for (const entry of state.lastInboundByAccount)
      insertActivityAt(entry.accountId, 'last_inbound', entry.updatedAt);
    for (const entry of state.lastOutboundByAccount)
      insertActivityAt(entry.accountId, 'last_outbound', entry.updatedAt);

    const drift = dumpRegisterDriftSnapshot(state.lastDriftSnapshot);
    if (drift) {
      const insertDrift = db.prepare(
        `INSERT INTO register_drift (
           id, captured_at, register_count, api_generation, post_warmup_register_count,
           api_instance_id, registry_fingerprint, dominant_bucket, source_buckets_json,
           trace_window_size, trace_recent_json, updated_at
         ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           captured_at = excluded.captured_at,
           register_count = excluded.register_count,
           api_generation = excluded.api_generation,
           post_warmup_register_count = excluded.post_warmup_register_count,
           api_instance_id = excluded.api_instance_id,
           registry_fingerprint = excluded.registry_fingerprint,
           dominant_bucket = excluded.dominant_bucket,
           source_buckets_json = excluded.source_buckets_json,
           trace_window_size = excluded.trace_window_size,
           trace_recent_json = excluded.trace_recent_json,
           updated_at = excluded.updated_at`,
      );
      insertDrift.run(
        drift.capturedAt,
        drift.registerCount,
        drift.apiGeneration,
        drift.postWarmupRegisterCount,
        drift.apiInstanceId,
        drift.registryFingerprint,
        drift.dominantBucket,
        JSON.stringify(drift.sourceBuckets),
        drift.traceWindowSize,
        JSON.stringify(drift.traceRecent),
        timestamp,
      );
    }
  });
}

function loadControlState(db: DatabaseSync): BncrSqliteControlState {
  const sessionRoutes = (
    db
      .prepare(
        `SELECT sr.session_key, sr.account_id, sr.platform, sr.group_id, sr.user_id, sr.updated_at
     FROM session_routes sr
     ORDER BY sr.updated_at ASC, sr.session_key ASC`,
      )
      .all() as Array<{
      session_key: string;
      account_id: string;
      platform: string;
      group_id: string;
      user_id: string;
      updated_at: number;
    }>
  ).map((row) => ({
    sessionKey: row.session_key,
    accountId: row.account_id,
    route: {
      platform: row.platform,
      groupId: row.group_id || '0',
      userId: row.user_id || '0',
    },
    updatedAt: row.updated_at,
  }));

  const sceneRegistry = (
    db
      .prepare(
        `SELECT scene_key, kind, status, platform, user_id, user_name, group_id, group_name,
            agent_id, group_reply_mode, history_limit, history_force, download_media,
            approved_at, last_seen_at
     FROM scenes
     ORDER BY last_seen_at ASC, scene_key ASC`,
      )
      .all() as Array<{
      scene_key: string;
      kind: BncrSceneRecord['kind'];
      status: BncrSceneRecord['status'];
      platform: string;
      user_id: string | null;
      user_name: string | null;
      group_id: string | null;
      group_name: string | null;
      agent_id: string | null;
      group_reply_mode: BncrGroupReplyMode | null;
      history_limit: number | null;
      history_force: number | null;
      download_media: number | null;
      approved_at: number | null;
      last_seen_at: number;
    }>
  ).map((row) => {
    const scene: BncrSceneRecord = {
      sceneKey: row.scene_key,
      kind: row.kind,
      status: row.status,
      platform: row.platform,
      lastSeenAt: row.last_seen_at,
    };
    if (row.user_id !== null) scene.userId = row.user_id;
    if (row.user_name !== null) scene.userName = row.user_name;
    if (row.group_id !== null) scene.groupId = row.group_id;
    if (row.group_name !== null) scene.groupName = row.group_name;
    if (row.agent_id !== null) scene.agentId = row.agent_id;
    if (row.group_reply_mode !== null) scene.groupReplyMode = row.group_reply_mode;
    if (row.history_limit !== null) scene.historyLimit = row.history_limit;
    if (row.history_force !== null) scene.historyForce = row.history_force === 1;
    if (row.download_media !== null) scene.downloadMedia = row.download_media === 1;
    if (row.approved_at !== null) scene.approvedAt = row.approved_at;
    return scene;
  });

  const activity = db
    .prepare(
      `SELECT account_id, activity_type, session_key, session_scope, event_at
     FROM account_activity
     ORDER BY updated_at ASC, account_id ASC`,
    )
    .all() as Array<{
    account_id: string;
    activity_type: string;
    session_key: string | null;
    session_scope: string | null;
    event_at: number;
  }>;

  const lastSessionByAccount: BncrPersistedLastSession[] = [];
  const lastActivityByAccount: BncrPersistedAccountTimestamp[] = [];
  const lastInboundByAccount: BncrPersistedAccountTimestamp[] = [];
  const lastOutboundByAccount: BncrPersistedAccountTimestamp[] = [];
  for (const row of activity) {
    const item = { accountId: row.account_id, updatedAt: row.event_at };
    if (row.activity_type === 'last_session' && row.session_key) {
      lastSessionByAccount.push({
        accountId: row.account_id,
        sessionKey: row.session_key,
        scope: row.session_scope ?? '',
        updatedAt: row.event_at,
      });
    } else if (row.activity_type === 'last_activity') {
      lastActivityByAccount.push(item);
    } else if (row.activity_type === 'last_inbound') {
      lastInboundByAccount.push(item);
    } else if (row.activity_type === 'last_outbound') {
      lastOutboundByAccount.push(item);
    }
  }

  const driftRow = db
    .prepare(
      `SELECT captured_at, register_count, api_generation, post_warmup_register_count,
            api_instance_id, registry_fingerprint, dominant_bucket, source_buckets_json,
            trace_window_size, trace_recent_json
     FROM register_drift
     WHERE id = 1`,
    )
    .get() as
    | {
        captured_at: number;
        register_count: number;
        api_generation: number;
        post_warmup_register_count: number;
        api_instance_id: string;
        registry_fingerprint: string;
        dominant_bucket: string | null;
        source_buckets_json: string;
        trace_window_size: number;
        trace_recent_json: string;
      }
    | undefined;

  const lastDriftSnapshot = driftRow
    ? normalizeRegisterDriftSnapshot({
        capturedAt: driftRow.captured_at,
        registerCount: driftRow.register_count,
        apiGeneration: driftRow.api_generation,
        postWarmupRegisterCount: driftRow.post_warmup_register_count,
        apiInstanceId: driftRow.api_instance_id,
        registryFingerprint: driftRow.registry_fingerprint,
        dominantBucket: driftRow.dominant_bucket,
        sourceBuckets: JSON.parse(driftRow.source_buckets_json ?? '{}'),
        traceWindowSize: driftRow.trace_window_size,
        traceRecent: JSON.parse(driftRow.trace_recent_json ?? '[]'),
      })
    : null;

  return {
    sessionRoutes,
    sceneRegistry,
    lastSessionByAccount,
    lastActivityByAccount,
    lastInboundByAccount,
    lastOutboundByAccount,
    lastDriftSnapshot,
  };
}

function deriveHistoryKeyFromRoute(args: {
  accountId?: string | null;
  platform?: string;
  groupId?: string;
  userId?: string;
}): string | null {
  const accountId = normalizeAccountId(args.accountId);
  const platform = String(args.platform || '').trim();
  const groupId = String(args.groupId || '0').trim() || '0';
  const userId = String(args.userId || '0').trim() || '0';
  if (!platform) return null;
  if (groupId !== '0') return `${accountId}:${platform}:${groupId}`;
  if (userId !== '0') return `${accountId}:${platform}:${userId}`;
  return null;
}

function parseMediaJson(value: string) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function replaceHistoryMessages(
  db: DatabaseSync,
  historyBuckets: BncrPersistedConversationHistoryBucket[],
  replayBuckets: BncrPersistedOutboundReplayBucket[],
  now: () => number,
  expectedRevision?: number,
): void {
  const timestamp = now();
  runWriteTransaction(db, () => {
    const currentRevisionRow = db
      .prepare("SELECT meta_value FROM state_meta WHERE meta_key = 'history_revision'")
      .get() as { meta_value: string } | undefined;
    const currentRevision = Number(currentRevisionRow?.meta_value ?? 0);
    if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
      throw new Error(
        `bncr sqlite history revision conflict: expected ${expectedRevision}, got ${currentRevision}`,
      );
    }
    db.exec('DELETE FROM conversation_messages WHERE shard_id IS NULL');

    const insert = db.prepare(
      `INSERT INTO conversation_messages (
         storage_kind, history_key, buffer_key, account_id, sender, sender_id, role,
         body, message_ts, message_id, media_json, session_key, replay_status,
         outbound_type, media_url, outbound_created_at, route_platform,
         route_group_id, route_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const isShardOwnedHistoryMessage = db.prepare(
      `SELECT 1 FROM conversation_messages
       WHERE shard_id IS NOT NULL
         AND storage_kind = ?
         AND history_key = ?
         AND message_id = ?
       LIMIT 1`,
    );
    const isShardOwnedReplayMessage = db.prepare(
      `SELECT 1 FROM conversation_messages
       WHERE shard_id IS NOT NULL
         AND storage_kind = ?
         AND buffer_key = ?
         AND message_id = ?
       LIMIT 1`,
    );
    const isConsumedHistoryMessage = db.prepare(
      `SELECT 1 FROM history_message_consumed
       WHERE storage_kind = 'history'
         AND history_key = ?
         AND message_id = ?
       LIMIT 1`,
    );
    const isConsumedReplayMessage = db.prepare(
      `SELECT 1 FROM history_message_consumed
       WHERE storage_kind = 'replay'
         AND buffer_key = ?
         AND message_id = ?
       LIMIT 1`,
    );
    const seenHistoryMessageIds = new Map<string, Set<string>>();
    const seenReplayMessageIds = new Map<string, Set<string>>();

    for (const bucket of historyBuckets) {
      const historyKey = normalizePersistedHistoryKey(String(bucket.key || '').trim());
      if (!historyKey) continue;
      for (const entry of Array.isArray(bucket.entries) ? bucket.entries : []) {
        const sender = String(entry?.sender || '').trim();
        const body = String(entry?.body || '').trim();
        if (!sender || !body) continue;
        if (entry.messageId) {
          const seen = seenHistoryMessageIds.get(historyKey) ?? new Set<string>();
          if (seen.has(entry.messageId)) continue;
          seen.add(entry.messageId);
          seenHistoryMessageIds.set(historyKey, seen);
        }
        if (
          entry.messageId &&
          isShardOwnedHistoryMessage.get('history', historyKey, entry.messageId)
        ) {
          continue;
        }
        if (entry.messageId && isConsumedHistoryMessage.get(historyKey, entry.messageId)) {
          continue;
        }
        insert.run(
          'history',
          historyKey,
          historyKey,
          null,
          sender,
          entry.senderId ?? null,
          entry.role ?? null,
          body,
          typeof entry.timestamp === 'number' ? entry.timestamp : null,
          entry.messageId ?? null,
          JSON.stringify(entry.media ?? []),
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          typeof entry.timestamp === 'number' ? entry.timestamp || timestamp : timestamp,
          timestamp,
        );
      }
    }

    for (const bucket of replayBuckets) {
      const bucketKey = normalizePersistedHistoryKey(String(bucket.key || '').trim());
      if (!bucketKey) continue;
      for (const entry of Array.isArray(bucket.entries) ? bucket.entries : []) {
        const sender = String(entry?.sender || '').trim();
        const body = String(entry?.body || '').trim();
        if (!sender || !body) continue;
        const entryAccountId = entry.accountId
          ? normalizeAccountId(entry.accountId)
          : resolvePersistedHistoryAccountId(bucketKey);
        const routeHistoryKey = deriveHistoryKeyFromRoute({
          accountId: entryAccountId,
          platform: entry.route?.platform,
          groupId: entry.route?.groupId,
          userId: entry.route?.userId,
        });
        const bufferKey = routeHistoryKey || resolvePersistedHistoryKey(bucketKey, entryAccountId);
        if (entry.messageId) {
          const seen = seenReplayMessageIds.get(bufferKey) ?? new Set<string>();
          if (seen.has(entry.messageId)) continue;
          seen.add(entry.messageId);
          seenReplayMessageIds.set(bufferKey, seen);
        }
        if (
          entry.messageId &&
          isShardOwnedReplayMessage.get('replay', bufferKey, entry.messageId)
        ) {
          continue;
        }
        if (entry.messageId && isConsumedReplayMessage.get(bufferKey, entry.messageId)) {
          continue;
        }
        const historyKey = routeHistoryKey || bufferKey;
        insert.run(
          'replay',
          historyKey ?? '',
          bufferKey,
          entryAccountId,
          sender,
          entry.senderId ?? null,
          'assistant',
          body,
          typeof entry.timestamp === 'number' ? entry.timestamp : null,
          entry.messageId ?? null,
          JSON.stringify(entry.media ?? []),
          entry.sessionKey ?? null,
          entry.status ?? null,
          entry.type ?? null,
          entry.mediaUrl ?? null,
          typeof entry.createdAt === 'number' ? entry.createdAt : null,
          entry.route?.platform ?? null,
          entry.route?.groupId ?? '0',
          entry.route?.userId ?? '0',
          typeof entry.createdAt === 'number' ? entry.createdAt || timestamp : timestamp,
          timestamp,
        );
      }
    }
    db.prepare(
      `INSERT INTO state_meta (meta_key, meta_value, updated_at)
       VALUES ('history_imported_at', ?, ?)
       ON CONFLICT(meta_key) DO NOTHING`,
    ).run(String(timestamp), timestamp);
    db.prepare(
      `INSERT INTO state_meta (meta_key, meta_value, updated_at)
       VALUES ('history_revision', ?, ?)
       ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
    ).run(String(currentRevision + 1), timestamp);
  });
}

type BncrHistoryMessageRow = {
  id: number;
  storage_kind: string;
  history_key: string;
  buffer_key: string;
  account_id: string | null;
  sender: string;
  sender_id: string | null;
  role: 'user' | 'assistant' | 'system' | null;
  body: string;
  message_ts: number | null;
  message_id: string | null;
  media_json: string;
  session_key: string | null;
  replay_status: 'pushed' | 'acked' | null;
  outbound_type: string | null;
  media_url: string | null;
  outbound_created_at: number | null;
  route_platform: string | null;
  route_group_id: string | null;
  route_user_id: string | null;
};

function historyStateFromRows(rows: readonly BncrHistoryMessageRow[]): BncrSqliteHistoryState {
  const historyBuckets = new Map<string, BncrPersistedConversationHistoryBucket>();
  const replayBuckets = new Map<string, BncrPersistedOutboundReplayBucket>();
  for (const row of rows) {
    if (row.storage_kind === 'history') {
      const key = row.history_key;
      if (!key) continue;
      const media = parseMediaJson(row.media_json);
      const entry: BncrPersistedConversationHistoryEntry = {
        sender: row.sender,
        body: row.body,
      };
      if (row.sender_id !== null) entry.senderId = row.sender_id;
      if (row.role !== null) entry.role = row.role;
      if (row.message_ts !== null) entry.timestamp = row.message_ts;
      if (row.message_id !== null) entry.messageId = row.message_id;
      if (media.length > 0) entry.media = media;
      const bucket = historyBuckets.get(key) ?? { key, entries: [] };
      bucket.entries.push(entry);
      historyBuckets.set(key, bucket);
      continue;
    }

    if (row.storage_kind === 'replay') {
      const key = row.buffer_key;
      if (!key) continue;
      const media = parseMediaJson(row.media_json);
      const entry: BncrPersistedOutboundReplayEntry = {
        sender: row.sender,
        body: row.body,
        route: {
          platform: row.route_platform ?? '',
          groupId: row.route_group_id ?? '0',
          userId: row.route_user_id ?? '0',
        },
      };
      if (row.sender_id !== null) entry.senderId = row.sender_id;
      if (row.message_ts !== null) entry.timestamp = row.message_ts;
      if (row.message_id !== null) entry.messageId = row.message_id;
      if (media.length > 0) entry.media = media;
      if (row.account_id !== null) entry.accountId = row.account_id;
      if (row.session_key !== null) entry.sessionKey = row.session_key;
      if (row.replay_status !== null) entry.status = row.replay_status;
      if (row.outbound_type !== null) entry.type = row.outbound_type;
      if (row.media_url !== null) entry.mediaUrl = row.media_url;
      if (row.outbound_created_at !== null) entry.createdAt = row.outbound_created_at;
      const bucket = replayBuckets.get(key) ?? { key, entries: [] };
      bucket.entries.push(entry);
      replayBuckets.set(key, bucket);
    }
  }
  return {
    historyBuckets: Array.from(historyBuckets.values()),
    replayBuckets: Array.from(replayBuckets.values()),
  };
}

function restoreTerminalHistoryShardsToActive(
  db: DatabaseSync,
  timestamp: number = Date.now(),
): BncrSqliteHistoryState {
  return runWriteTransaction(db, () => {
    const terminal = (
      db
        .prepare(
          `SELECT id
           FROM history_shards
           WHERE status = 'failed'
             AND attempts >= ?
             AND next_attempt_at IS NULL`,
        )
        .all(HISTORY_SHARD_MAX_ATTEMPTS) as Array<{ id: number }>
    ).map((row) => row.id);
    if (terminal.length === 0) {
      return { historyBuckets: [], replayBuckets: [] };
    }
    const placeholders = terminal.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT cm.id, cm.storage_kind, cm.history_key, cm.buffer_key, cm.account_id,
                cm.sender, cm.sender_id, cm.role, cm.body, cm.message_ts, cm.message_id,
                cm.media_json, cm.session_key, cm.replay_status, cm.outbound_type,
                cm.media_url, cm.outbound_created_at, cm.route_platform,
                cm.route_group_id, cm.route_user_id
         FROM conversation_messages cm
         WHERE cm.shard_id IN (${placeholders})
         ORDER BY cm.id ASC`,
      )
      .all(...terminal) as BncrHistoryMessageRow[];
    const restoreMessages = db.prepare(
      `UPDATE conversation_messages SET shard_id = NULL WHERE shard_id IN (${placeholders})`,
    );
    const deleteShards = db.prepare(`DELETE FROM history_shards WHERE id IN (${placeholders})`);
    const deleteConsumed = db.prepare(
      `DELETE FROM conversation_messages
       WHERE shard_id IN (${placeholders})
         AND message_id IS NOT NULL
         AND message_id != ''
         AND EXISTS (
           SELECT 1 FROM history_message_consumed t
           WHERE t.storage_kind = conversation_messages.storage_kind
             AND t.history_key = conversation_messages.history_key
             AND t.buffer_key = conversation_messages.buffer_key
             AND t.message_id = conversation_messages.message_id
         )`,
    );
    deleteConsumed.run(...terminal);
    restoreMessages.run(...terminal);
    // Once the messages are active again the terminal shard row has no further
    // queueing value and must not block later SQLite-only cutover.
    deleteShards.run(...terminal);
    const revisionRow = db
      .prepare("SELECT meta_value FROM state_meta WHERE meta_key = 'history_revision'")
      .get() as { meta_value: string } | undefined;
    const nextRevision = Number(revisionRow?.meta_value ?? 0) + 1;
    db.prepare(
      `INSERT INTO state_meta (meta_key, meta_value, updated_at)
       VALUES ('history_revision', ?, ?)
       ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
    ).run(String(nextRevision), timestamp);
    const isConsumed = db.prepare(
      `SELECT 1 FROM history_message_consumed
       WHERE storage_kind = ?
         AND history_key = ?
         AND buffer_key = ?
         AND message_id = ?
       LIMIT 1`,
    );
    return historyStateFromRows(
      rows.filter(
        (row) => !isConsumed.get(row.storage_kind, row.history_key, row.buffer_key, row.message_id),
      ),
    );
  });
}

function loadHistoryState(db: DatabaseSync, now: number = Date.now()): BncrSqliteHistoryState {
  cleanupExpiredHistoryMessageTombstones(db, now);
  cleanupCompletedHistoryShards(db, now);
  restoreTerminalHistoryShardsToActive(db, now);
  const rows = db
    .prepare(
      `SELECT cm.id, cm.storage_kind, cm.history_key, cm.buffer_key, cm.account_id,
              cm.sender, cm.sender_id, cm.role, cm.body, cm.message_ts, cm.message_id,
              cm.media_json, cm.session_key, cm.replay_status, cm.outbound_type,
              cm.media_url, cm.outbound_created_at, cm.route_platform,
              cm.route_group_id, cm.route_user_id
       FROM conversation_messages cm
       WHERE cm.shard_id IS NULL
       ORDER BY cm.id ASC`,
    )
    .all() as BncrHistoryMessageRow[];
  return historyStateFromRows(rows);
}

function cleanupExpiredHistoryMessageTombstones(
  db: DatabaseSync,
  now: number,
  retentionMs = HISTORY_CONSUMED_TOMBSTONE_RETENTION_MS,
): number {
  return runWriteTransaction(db, () => {
    const result = db
      .prepare('DELETE FROM history_message_consumed WHERE consumed_at < ?')
      .run(now - retentionMs);
    return Number(result.changes);
  });
}

function cleanupCompletedHistoryShards(db: DatabaseSync, timestamp: number = Date.now()): number {
  return runWriteTransaction(db, () => {
    const completed = (
      db.prepare(`SELECT id FROM history_shards WHERE status = 'completed'`).all() as Array<{
        id: number;
      }>
    ).map((row) => row.id);
    if (completed.length === 0) {
      return 0;
    }
    const deleteMessages = db.prepare('DELETE FROM conversation_messages WHERE shard_id = ?');
    const deleteShard = db.prepare('DELETE FROM history_shards WHERE id = ?');
    for (const id of completed) {
      recordConsumedHistoryShardMessages(db, id, timestamp);
      deleteMessages.run(id);
      deleteShard.run(id);
    }
    return completed.length;
  });
}

function recordConsumedHistoryShardMessages(
  db: DatabaseSync,
  shardId: number,
  timestamp: number,
): number {
  const rows = db
    .prepare(
      `SELECT DISTINCT storage_kind, history_key, buffer_key, message_id
       FROM conversation_messages
       WHERE shard_id = ?
         AND message_id IS NOT NULL
         AND message_id != ''`,
    )
    .all(shardId) as Array<{
    storage_kind: 'history' | 'replay';
    history_key: string;
    buffer_key: string;
    message_id: string;
  }>;
  const consumed = rows.length;
  const insert = db.prepare(
    `INSERT INTO history_message_consumed (
       storage_kind, history_key, buffer_key, message_id, consumed_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(storage_kind, history_key, buffer_key, message_id) DO NOTHING`,
  );
  const deleteConsumedHistory = db.prepare(
    `DELETE FROM conversation_messages
     WHERE shard_id IS NULL
       AND storage_kind = 'history'
       AND history_key = ?
       AND message_id = ?`,
  );
  const deleteConsumedReplay = db.prepare(
    `DELETE FROM conversation_messages
     WHERE shard_id IS NULL
       AND storage_kind = 'replay'
       AND buffer_key = ?
       AND message_id = ?`,
  );
  const insertConsumed = (
    storageKind: 'history' | 'replay',
    historyKey: string,
    bufferKey: string,
    messageId: string,
  ) => {
    if (!historyKey || !bufferKey || !messageId) return;
    insert.run(storageKind, historyKey, bufferKey, messageId, timestamp, timestamp);
  };
  for (const row of rows) {
    insertConsumed(row.storage_kind, row.history_key, row.buffer_key, row.message_id);
  }
  const shard = db
    .prepare(
      `SELECT history_key, message_ids_json, buffer_keys_json
       FROM history_shards
       WHERE id = ?`,
    )
    .get(shardId) as
    | { history_key: string; message_ids_json: string; buffer_keys_json: string }
    | undefined;
  if (shard) {
    const historyKey = String(shard.history_key || '').trim();
    const messageIds = parseOutboundStringArray(shard.message_ids_json);
    const bufferKeys = parseOutboundStringArray(shard.buffer_keys_json);
    for (const messageId of messageIds) {
      if (historyKey) {
        insertConsumed('history', historyKey, historyKey, messageId);
        deleteConsumedHistory.run(historyKey, messageId);
      }
    }
    for (const bufferKey of bufferKeys.length > 0 ? bufferKeys : [historyKey]) {
      for (const messageId of messageIds) {
        insertConsumed('replay', historyKey || bufferKey, bufferKey, messageId);
        deleteConsumedReplay.run(bufferKey, messageId);
      }
    }
  }
  return consumed;
}

function parseOutboundPayloadJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseOutboundStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function replaceOutboundState(
  db: DatabaseSync,
  outbox: readonly OutboxEntry[],
  deadLetter: readonly OutboxEntry[],
  now: () => number,
  agentId?: string | null,
): void {
  const scope = String(agentId ?? '').trim();
  const prefix = scope ? `agent:${scope}:bncr:` : null;
  const timestamp = now();
  runWriteTransaction(db, () => {
    if (scope) {
      // Agent-scoped: rewrite only this agent's entries; rows of other agents and
      // unattributable legacy entries stay untouched.
      db.prepare(`DELETE FROM outbound_messages WHERE session_key LIKE ? ESCAPE '\\'`).run(
        agentSessionKeyLike(scope),
      );
    } else {
      db.exec('DELETE FROM outbound_messages');
    }
    const insert = db.prepare(
      `INSERT INTO outbound_messages (
         message_id, account_id, session_key, route_platform, route_group_id,
         route_user_id, payload_json, queue_state, retry_count, next_attempt_at,
         last_attempt_at, last_error, last_push_at, last_push_conn_id,
         last_push_client_id, route_attempt_conn_ids_json, route_attempt_round,
         fast_reroute_pending, awaiting_retry_push, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const write = (entry: OutboxEntry, queueState: 'queued' | 'dead') => {
      insert.run(
        entry.messageId,
        entry.accountId,
        entry.sessionKey,
        entry.route.platform,
        entry.route.groupId || '0',
        entry.route.userId || '0',
        JSON.stringify(entry.payload ?? {}),
        queueState,
        Number(entry.retryCount) || 0,
        Number(entry.nextAttemptAt) || timestamp,
        typeof entry.lastAttemptAt === 'number' ? entry.lastAttemptAt : null,
        entry.lastError ?? null,
        typeof entry.lastPushAt === 'number' ? entry.lastPushAt : null,
        entry.lastPushConnId ?? null,
        entry.lastPushClientId ?? null,
        JSON.stringify(Array.isArray(entry.routeAttemptConnIds) ? entry.routeAttemptConnIds : []),
        typeof entry.routeAttemptRound === 'number' ? entry.routeAttemptRound : 0,
        entry.fastReroutePending ? 1 : 0,
        entry.awaitingRetryPush ? 1 : 0,
        Number(entry.createdAt) || timestamp,
        timestamp,
      );
    };

    const scopedOutbox = prefix
      ? (outbox as OutboxEntry[]).filter((entry) => entry.sessionKey.startsWith(prefix))
      : (outbox as OutboxEntry[]);
    const scopedDeadLetter = prefix
      ? (deadLetter as OutboxEntry[]).filter((entry) => entry.sessionKey.startsWith(prefix))
      : (deadLetter as OutboxEntry[]);
    for (const entry of scopedOutbox) write(entry, 'queued');
    for (const entry of scopedDeadLetter) write(entry, 'dead');
    db.prepare(
      `INSERT INTO state_meta (meta_key, meta_value, updated_at)
       VALUES ('outbound_imported_at', ?, ?)
       ON CONFLICT(meta_key) DO NOTHING`,
    ).run(String(timestamp), timestamp);
  });
}

function loadOutboundState(db: DatabaseSync, agentId?: string | null): BncrSqliteOutboundState {
  const scope = String(agentId ?? '').trim();
  const rows = (
    scope
      ? db
          .prepare(
            `SELECT message_id, account_id, session_key, route_platform, route_group_id,
                    route_user_id, payload_json, queue_state, retry_count, next_attempt_at,
                    last_attempt_at, last_error, last_push_at, last_push_conn_id,
                    last_push_client_id, route_attempt_conn_ids_json, route_attempt_round,
                    fast_reroute_pending, awaiting_retry_push, created_at
             FROM outbound_messages
             WHERE session_key LIKE ? ESCAPE '\\'
             ORDER BY id ASC`,
          )
          .all(agentSessionKeyLike(scope))
      : db
          .prepare(
            `SELECT message_id, account_id, session_key, route_platform, route_group_id,
                    route_user_id, payload_json, queue_state, retry_count, next_attempt_at,
                    last_attempt_at, last_error, last_push_at, last_push_conn_id,
                    last_push_client_id, route_attempt_conn_ids_json, route_attempt_round,
                    fast_reroute_pending, awaiting_retry_push, created_at
             FROM outbound_messages
             ORDER BY id ASC`,
          )
          .all()
  ) as Array<{
    message_id: string;
    account_id: string;
    session_key: string;
    route_platform: string;
    route_group_id: string;
    route_user_id: string;
    payload_json: string;
    queue_state: string;
    retry_count: number;
    next_attempt_at: number;
    last_attempt_at: number | null;
    last_error: string | null;
    last_push_at: number | null;
    last_push_conn_id: string | null;
    last_push_client_id: string | null;
    route_attempt_conn_ids_json: string;
    route_attempt_round: number | null;
    fast_reroute_pending: number;
    awaiting_retry_push: number;
    created_at: number;
  }>;

  const outbox: OutboxEntry[] = [];
  const deadLetter: OutboxEntry[] = [];
  for (const row of rows) {
    const entry: OutboxEntry = {
      messageId: row.message_id,
      accountId: row.account_id,
      sessionKey: row.session_key,
      route: {
        platform: row.route_platform,
        groupId: row.route_group_id || '0',
        userId: row.route_user_id || '0',
      },
      payload: parseOutboundPayloadJson(row.payload_json),
      createdAt: row.created_at,
      retryCount: row.retry_count,
      nextAttemptAt: row.next_attempt_at,
    };
    if (row.last_attempt_at !== null) entry.lastAttemptAt = row.last_attempt_at;
    if (row.last_error !== null) entry.lastError = row.last_error;
    if (row.last_push_at !== null) entry.lastPushAt = row.last_push_at;
    if (row.last_push_conn_id !== null) entry.lastPushConnId = row.last_push_conn_id;
    if (row.last_push_client_id !== null) entry.lastPushClientId = row.last_push_client_id;
    const routeAttemptConnIds = parseOutboundStringArray(row.route_attempt_conn_ids_json);
    if (routeAttemptConnIds.length > 0) entry.routeAttemptConnIds = routeAttemptConnIds;
    if (row.route_attempt_round !== null) entry.routeAttemptRound = row.route_attempt_round;
    entry.fastReroutePending = row.fast_reroute_pending === 1;
    entry.awaitingRetryPush = row.awaiting_retry_push === 1;
    if (row.queue_state === 'dead') deadLetter.push(entry);
    else outbox.push(entry);
  }
  return { outbox, deadLetter };
}

const LEGACY_ALIAS_ACCOUNT_TABLES = [
  'outbound_messages',
  'session_routes',
  'account_activity',
] as const;

/**
 * One-shot startup normalization for legacy alias account ids (empty string, 'default',
 * 'primary'). Only values with a deterministic mapping are rewritten; unknown legacy ids
 * have no trustworthy target and stay in place (they remain visible to the
 * legacy-account-residue probe).
 */
export function normalizeLegacyAliasAccountIds(db: DatabaseSync): number {
  let rewritten = 0;
  for (const table of LEGACY_ALIAS_ACCOUNT_TABLES) {
    const rows = db.prepare(`SELECT DISTINCT account_id FROM ${table}`).all() as Array<{
      account_id: unknown;
    }>;
    for (const row of rows) {
      const stored = String(row.account_id);
      const raw = stored.trim();
      if (!raw || raw === BNCR_DEFAULT_ACCOUNT_ID) continue;
      const normalized = normalizeAccountId(raw);
      if (normalized === raw) continue;
      if (table === 'account_activity') {
        rewritten += mergeAccountActivityAliases(db, stored, normalized);
        continue;
      }
      const result = db
        .prepare(`UPDATE ${table} SET account_id = ? WHERE account_id = ?`)
        .run(normalized, stored);
      rewritten += Number(result.changes);
    }
  }
  if (rewritten > 0) {
    emitBncrLog(
      'info',
      'sqlite',
      `normalized ${rewritten} legacy alias account id row(s) at startup`,
    );
  }
  return rewritten;
}

/**
 * account_activity is UNIQUE(account_id, activity_type): renaming an alias row can
 * collide with the canonical row of the same activity type. Colliding pairs merge
 * (canonical row keeps the newest timestamps, alias row is removed); non-colliding
 * rows are renamed in place.
 */
function mergeAccountActivityAliases(
  db: DatabaseSync,
  aliasValue: string,
  normalizedValue: string,
): number {
  let merged = 0;
  const aliasRows = db
    .prepare(
      'SELECT activity_type, event_at, updated_at FROM account_activity WHERE account_id = ?',
    )
    .all(aliasValue) as Array<{ activity_type: string; event_at: number; updated_at: number }>;
  for (const aliasRow of aliasRows) {
    const canonical = db
      .prepare(
        'SELECT event_at, updated_at FROM account_activity WHERE account_id = ? AND activity_type = ?',
      )
      .get(normalizedValue, aliasRow.activity_type) as
      | { event_at: number; updated_at: number }
      | undefined;
    if (canonical) {
      db.prepare(
        'UPDATE account_activity SET event_at = MAX(event_at, ?), updated_at = MAX(updated_at, ?) WHERE account_id = ? AND activity_type = ?',
      ).run(aliasRow.event_at, aliasRow.updated_at, normalizedValue, aliasRow.activity_type);
      db.prepare('DELETE FROM account_activity WHERE account_id = ? AND activity_type = ?').run(
        aliasValue,
        aliasRow.activity_type,
      );
      merged += 1;
      continue;
    }
    merged += Number(
      db
        .prepare(
          'UPDATE account_activity SET account_id = ? WHERE account_id = ? AND activity_type = ?',
        )
        .run(normalizedValue, aliasValue, aliasRow.activity_type).changes,
    );
  }
  return merged;
}

const SQLITE_SNAPSHOT_NAME_PREFIX = 'bncr.sqlite3.snap';
const SQLITE_SNAPSHOT_RETENTION = 3;
const SQLITE_CORRUPT_ARCHIVE_RETENTION = 3;
const SQLITE_RECOVERY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SQLITE_RECOVERY_CANDIDATE_LIMIT = 8;

function sqliteSnapshotBackupDir(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'backups');
}

function sqliteSnapshotTimestamp(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

function quoteSqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function listSqliteSnapshots(
  backupDir: string,
): Array<{ filePath: string; name: string; mtimeMs: number }> {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => name.startsWith(`${SQLITE_SNAPSHOT_NAME_PREFIX}-`))
    .map((name) => {
      const filePath = path.join(backupDir, name);
      return { filePath, name, mtimeMs: statSync(filePath).mtimeMs };
    });
}

function assertSqliteSnapshotHealth(db: DatabaseSync): void {
  const quickCheck = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
  const invalid = quickCheck.filter((row) => row.quick_check !== 'ok');
  if (invalid.length > 0) {
    throw new Error(
      `bncr sqlite snapshot quick_check failed: ${invalid.map((row) => row.quick_check).join(' | ')}`,
    );
  }
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyViolations.length > 0) {
    throw new Error(
      `bncr sqlite snapshot has ${foreignKeyViolations.length} foreign key violation(s)`,
    );
  }
}

/**
 * An eligible snapshot passes the same read-only gates as startup (quick_check, foreign
 * keys, migration lineage, write contract). A snapshot that carries a future migration
 * or name drift is rejected: promoting it would discard data the newer schema holds.
 */
function isSqliteSnapshotEligible(snapshotPath: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(snapshotPath, { readOnly: true });
    assertSqliteSnapshotHealth(db);
    const rows = db
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC')
      .all() as AppliedMigrationRow[];
    assertAppliedMigrations(rows);
    assertSqliteWriteContract(db);
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // Preserve the original snapshot rejection.
    }
  }
}

function archiveCorruptSqliteFiles(dbPath: string, now: number): void {
  const baseDir = path.dirname(dbPath);
  const baseName = path.basename(dbPath);
  const archiveBase = `${baseName}.corrupt-${sqliteSnapshotTimestamp(now)}`;
  let suffixIndex = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    const source = suffix === '' ? dbPath : `${dbPath}${suffix}`;
    if (!existsSync(source)) continue;
    let target =
      suffix === ''
        ? path.join(baseDir, archiveBase)
        : path.join(baseDir, `${archiveBase}${suffix}`);
    while (existsSync(target)) {
      suffixIndex += 1;
      target =
        suffix === ''
          ? path.join(baseDir, `${archiveBase}-${suffixIndex}`)
          : path.join(baseDir, `${archiveBase}${suffix}-${suffixIndex}`);
    }
    renameSync(source, target);
  }
  // Keep only the newest corrupt archives; these are plugin forensic files, not user data.
  const archives = readdirSync(baseDir)
    .filter((name) => name.startsWith(`${baseName}.corrupt-`))
    .map((name) => ({ name, mtimeMs: statSync(path.join(baseDir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  for (const archive of archives.slice(SQLITE_CORRUPT_ARCHIVE_RETENTION)) {
    rmSync(path.join(baseDir, archive.name), { force: true });
  }
}

/**
 * Promote a verified snapshot to the live path: VACUUM INTO produces a fresh standalone
 * file, the corrupt live set is archived for rollback, and the promoted file is published
 * exclusively (never overwrites an existing live file). Returns false when the live path
 * reappeared concurrently (EEXIST) so the caller can retry a plain open.
 */
function promoteSqliteSnapshot(snapshotPath: string, dbPath: string): boolean {
  const baseDir = path.dirname(dbPath);
  const staging = path.join(baseDir, `.${path.basename(dbPath)}.promote.${randomUUID()}.tmp`);
  const source = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO ${quoteSqliteLiteral(staging)}`);
  } finally {
    source.close();
  }
  let promoted = true;
  try {
    chmodSync(staging, 0o600);
    linkSync(staging, dbPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      promoted = false;
    } else {
      throw error;
    }
  } finally {
    rmSync(staging, { force: true });
  }
  return promoted;
}

/**
 * Publish a verified snapshot of the live database into the state backups directory.
 * Exclusive hardlink publish: existing files are never overwritten, same-second publishes
 * get an incrementing suffix, and only the newest SQLITE_SNAPSHOT_RETENTION snapshots are
 * kept. JSON cutover backups in the same directory are never touched.
 */
export function rotateSqliteSnapshot(options: {
  db: DatabaseSync;
  dbPath: string;
  now?: () => number;
}): string | null {
  const now = options.now ?? (() => Date.now());
  const backupDir = sqliteSnapshotBackupDir(options.dbPath);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  const temporary = path.join(backupDir, `.${path.basename(options.dbPath)}.${randomUUID()}.tmp`);
  options.db.exec(`VACUUM INTO ${quoteSqliteLiteral(temporary)}`);
  let destination: string | null = null;
  try {
    const probe = new DatabaseSync(temporary, { readOnly: true });
    try {
      const quickCheck = probe.prepare('PRAGMA quick_check').all() as Array<{
        quick_check: string;
      }>;
      if (quickCheck.some((row) => row.quick_check !== 'ok')) return null;
    } finally {
      probe.close();
    }
    const timestamp = sqliteSnapshotTimestamp(now());
    destination = path.join(backupDir, `${SQLITE_SNAPSHOT_NAME_PREFIX}-${timestamp}`);
    for (let suffix = 1; existsSync(destination); suffix += 1) {
      destination = path.join(backupDir, `${SQLITE_SNAPSHOT_NAME_PREFIX}-${timestamp}-${suffix}`);
    }
    linkSync(temporary, destination);
    chmodSync(destination, 0o600);
    const snapshots = listSqliteSnapshots(backupDir)
      .filter((entry) => entry.filePath !== destination)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    for (const stale of snapshots.slice(SQLITE_SNAPSHOT_RETENTION - 1)) {
      rmSync(stale.filePath, { force: true });
    }
    return destination;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Startup self-recovery: when the live database fails an integrity-class gate, promote
 * the newest eligible snapshot (verified read-only against the full startup gate set,
 * bounded by age) so the plugin keeps running from a last-known-good state. The corrupt
 * live files are archived for rollback. Returns the promoted snapshot name, or null when
 * no eligible candidate exists (the original error must then propagate, fail closed).
 */
export function recoverSqliteFromSnapshot(options: {
  dbPath: string;
  now?: () => number;
}): string | null {
  const now = options.now ?? (() => Date.now());
  const candidates = listSqliteSnapshots(sqliteSnapshotBackupDir(options.dbPath))
    .filter((candidate) => {
      const ageMs = now() - candidate.mtimeMs;
      return ageMs >= 0 && ageMs <= SQLITE_RECOVERY_MAX_AGE_MS;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
    .slice(0, SQLITE_RECOVERY_CANDIDATE_LIMIT);
  for (const candidate of candidates) {
    if (!isSqliteSnapshotEligible(candidate.filePath)) continue;
    archiveCorruptSqliteFiles(options.dbPath, now());
    if (!promoteSqliteSnapshot(candidate.filePath, options.dbPath)) break;
    return candidate.name;
  }
  return null;
}

function openLiveSqliteDatabase(dbPath: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=WAL');
    for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        chmodSync(filePath, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('PRAGMA busy_timeout=5000');
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the original open failure.
    }
    throw new BncrSqliteIntegrityFailure(`bncr sqlite open failed: ${errorMessageOf(error)}`, {
      cause: error,
    });
  }
}

export function createBncrSqliteStateDatabase(
  dbPath: string,
  options: {
    now?: () => number;
    storeMode?: BncrSqliteStoreMode;
  } = {},
): BncrSqliteStateDatabase {
  const now = options.now ?? (() => Date.now());
  let liveConnection: DatabaseSync | undefined;
  let recoveryMeta: { from: string; at: number; reason: string } | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const connection = openLiveSqliteDatabase(dbPath);
      liveConnection = connection;
      applyMigrations(connection, now);
      runWriteTransaction(connection, () => {
        normalizeLegacyAliasAccountIds(connection);
      });
      if (options.storeMode) setMeta('store_mode', options.storeMode);
      break;
    } catch (error) {
      if (liveConnection) {
        try {
          liveConnection.close();
        } catch {
          // Preserve the startup failure that made the connection unusable.
        }
      }
      liveConnection = undefined;
      if (attempt === 0 && error instanceof BncrSqliteIntegrityFailure) {
        const recoveredFrom = recoverSqliteFromSnapshot({ dbPath, now });
        if (recoveredFrom) {
          recoveryMeta = {
            from: recoveredFrom,
            at: now(),
            reason: errorMessageOf(error).slice(0, 200),
          };
          continue;
        }
      }
      throw error;
    }
  }
  if (liveConnection === undefined) {
    throw new BncrSqliteIntegrityFailure('bncr sqlite startup exited without an open connection');
  }
  const db = liveConnection;
  if (recoveryMeta) {
    setMeta('sqlite_last_recovery_at', String(recoveryMeta.at));
    setMeta('sqlite_last_recovery_from', recoveryMeta.from);
    setMeta('sqlite_last_recovery_reason', recoveryMeta.reason);
    emitBncrLog(
      'warn',
      'sqlite',
      `startup recovered from snapshot ${recoveryMeta.from}: ${recoveryMeta.reason}`,
    );
  }

  function getMeta(key: string): string | null {
    const row = db.prepare('SELECT meta_value FROM state_meta WHERE meta_key = ?').get(key) as
      | { meta_value: string }
      | undefined;
    return row?.meta_value ?? null;
  }

  function setMeta(key: string, value: string): void {
    runWriteTransaction(db, () => {
      db.prepare(
        `INSERT INTO state_meta (meta_key, meta_value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
      ).run(key, value, now());
    });
  }

  function getStoreMode(): BncrSqliteStoreMode | null {
    const mode = getMeta('store_mode');
    return mode === 'dual' || mode === 'sqlite' || mode === 'json' ? mode : null;
  }

  function assertWritable(mode: BncrSqliteStoreMode | null): asserts mode is 'dual' | 'sqlite' {
    if (mode !== 'dual' && mode !== 'sqlite') {
      throw new Error(`bncr sqlite state is not writable in store_mode=${String(mode)}`);
    }
  }

  function buildHistoryShardDedupeKey(
    historyKey: string,
    accountId: string | null,
    bufferKeys: readonly string[],
    messageIds: readonly string[],
  ): string {
    const normalized = Array.from(new Set(messageIds.map((id) => String(id || '').trim())))
      .filter(Boolean)
      .sort();
    return createHash('sha256')
      .update(
        JSON.stringify({
          historyKey,
          accountId,
          bufferKeys: [...bufferKeys].sort(),
          messageIds: normalized,
        }),
      )
      .digest('hex');
  }

  function createHistoryShard(input: BncrHistoryShardCreateInput): BncrHistoryShardCreateResult {
    const mode = getStoreMode();
    assertWritable(mode);
    const historyKey = String(input.historyKey || '').trim();
    if (!historyKey) throw new Error('bncr sqlite history shard requires historyKey');
    const timestamp = now();
    const accountId = String(input.accountId || '').trim() || null;
    const bufferKeys = Array.from(
      new Set(input.bufferKeys.map((key) => String(key || '').trim()).filter(Boolean)),
    ).sort();
    const messageIds = Array.from(
      new Set(
        input.messageIds
          .map((messageId) => String(messageId || '').trim())
          .filter((messageId) => Boolean(messageId)),
      ),
    );
    const dedupeKey =
      messageIds.length > 0
        ? buildHistoryShardDedupeKey(historyKey, accountId, bufferKeys, messageIds)
        : `empty:${timestamp}:${Math.random().toString(36).slice(2)}`;
    const messagePlaceholders = messageIds.map(() => '?').join(', ') || 'NULL';
    return runWriteTransaction(db, () => {
      const existing = db
        .prepare(
          `SELECT id FROM history_shards
           WHERE dedupe_key = ?
             OR (
               history_key = ?
               AND message_ids_json = ?
               AND buffer_keys_json = ?
               AND ((? IS NULL AND account_id IS NULL) OR account_id = ?)
             )`,
        )
        .get(
          dedupeKey,
          historyKey,
          JSON.stringify(messageIds),
          JSON.stringify(bufferKeys),
          accountId,
          accountId,
        ) as { id: number } | undefined;
      if (existing) {
        const shardId = Number(existing.id);
        const bufferPlaceholders = bufferKeys.map(() => '?').join(', ') || 'NULL';
        const historyCondition =
          messageIds.length > 0
            ? `(storage_kind = 'history' AND history_key = ? AND message_id IN (${messagePlaceholders}))`
            : `0 = 1`;
        const replayAccountCondition = accountId
          ? ` AND (account_id IS NULL OR account_id = ?)`
          : '';
        const replayCondition =
          bufferKeys.length > 0 && messageIds.length > 0
            ? `(storage_kind = 'replay' AND buffer_key IN (${bufferPlaceholders})${replayAccountCondition} AND message_id IN (${messagePlaceholders}))`
            : `0 = 1`;
        const historyParams = messageIds.length > 0 ? [historyKey, ...messageIds] : [];
        const replayParams =
          messageIds.length > 0 && bufferKeys.length > 0
            ? accountId
              ? [...bufferKeys, accountId, ...messageIds]
              : [...bufferKeys, ...messageIds]
            : [];
        db.prepare(
          `UPDATE conversation_messages SET shard_id = ?
           WHERE shard_id IS NULL
             AND (
               ${historyCondition}
               OR ${replayCondition}
             )`,
        ).run(shardId, ...historyParams, ...replayParams);
        return { shardId, created: false };
      }

      const insert = db
        .prepare(
          `INSERT INTO history_shards (
             dedupe_key, account_id, history_key, payload_json, message_ids_json,
             buffer_keys_json, created_at, queued_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          dedupeKey,
          accountId,
          historyKey,
          input.payloadJson,
          JSON.stringify(messageIds),
          JSON.stringify(bufferKeys),
          timestamp,
          timestamp,
          timestamp,
        );
      const shardId = Number(insert.lastInsertRowid);
      const bufferPlaceholders = bufferKeys.map(() => '?').join(', ') || 'NULL';
      const historyCondition =
        messageIds.length > 0
          ? `(storage_kind = 'history' AND history_key = ? AND message_id IN (${messagePlaceholders}))`
          : `0 = 1`;
      const replayAccountCondition = accountId ? ` AND (account_id IS NULL OR account_id = ?)` : '';
      const replayCondition =
        bufferKeys.length > 0 && messageIds.length > 0
          ? `(storage_kind = 'replay' AND buffer_key IN (${bufferPlaceholders})${replayAccountCondition} AND message_id IN (${messagePlaceholders}))`
          : `0 = 1`;
      const historyParams = messageIds.length > 0 ? [historyKey, ...messageIds] : [];
      const replayParams =
        messageIds.length > 0 && bufferKeys.length > 0
          ? accountId
            ? [...bufferKeys, accountId, ...messageIds]
            : [...bufferKeys, ...messageIds]
          : [];
      db.prepare(
        `UPDATE conversation_messages SET shard_id = ?
         WHERE shard_id IS NULL
           AND (
             ${historyCondition}
             OR ${replayCondition}
           )`,
      ).run(shardId, ...historyParams, ...replayParams);
      return { shardId, created: true };
    });
  }

  function markHistoryShardProcessing(shardId: number, owner = 'bncr-node'): boolean {
    const timestamp = now();
    const claimToken = `bncr:${shardId}:${timestamp}:${Math.random().toString(36).slice(2)}`;
    const ownerCondition = owner
      ? ` AND (claim_owner IS NULL OR claim_owner = ? OR status IN ('queued','failed','abandoned'))`
      : '';
    return runWriteTransaction(db, () => {
      const result = db
        .prepare(
          `UPDATE history_shards
       SET status = 'processing',
           claim_token = ?,
           claim_owner = ?,
           claimed_at = ?,
           lease_expires_at = ?,
           upload_started_at = ?,
           updated_at = ?
       WHERE id = ? AND status IN ('queued', 'failed', 'abandoned', 'claimed')${ownerCondition}`,
        )
        .run(
          claimToken,
          owner,
          timestamp,
          timestamp + HISTORY_SHARD_LEASE_MS,
          timestamp,
          timestamp,
          shardId,
          ...(owner ? [owner] : []),
        );
      return Number(result.changes) > 0;
    });
  }

  function markHistoryShardFailed(
    shardId: number,
    error: unknown,
    owner?: string,
  ): BncrHistoryShardFailureResult {
    const timestamp = now();
    const message =
      typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
    return runWriteTransaction(db, () => {
      const existing = db
        .prepare('SELECT attempts, claim_owner FROM history_shards WHERE id = ?')
        .get(shardId) as { attempts: number; claim_owner: string | null } | undefined;
      if (owner && existing?.claim_owner && existing.claim_owner !== owner) {
        return {
          attempts: existing.attempts,
          terminal: existing.attempts >= HISTORY_SHARD_MAX_ATTEMPTS,
        };
      }
      const attempts = (existing?.attempts ?? 0) + 1;
      const backoffMs = Math.min(
        HISTORY_SHARD_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
        HISTORY_SHARD_RETRY_MAX_MS,
      );
      const ownerCondition = owner ? ' AND (claim_owner IS NULL OR claim_owner = ?)' : '';
      const updateResult = db
        .prepare(
          `UPDATE history_shards
         SET status = 'failed',
             attempts = ?,
             last_error = ?,
             claim_token = NULL,
             claim_owner = NULL,
             claimed_at = NULL,
             lease_expires_at = NULL,
             next_attempt_at = ?,
             updated_at = ?
         WHERE id = ? AND status IN ('queued', 'claimed', 'processing')${ownerCondition}`,
        )
        .run(
          attempts,
          message,
          attempts >= HISTORY_SHARD_MAX_ATTEMPTS ? null : timestamp + backoffMs,
          timestamp,
          shardId,
          ...(owner ? [owner] : []),
        );
      if (owner && Number(updateResult.changes) === 0) {
        const current = db
          .prepare('SELECT attempts FROM history_shards WHERE id = ?')
          .get(shardId) as { attempts: number } | undefined;
        const currentAttempts = Number(current?.attempts ?? 0);
        return {
          attempts: currentAttempts,
          terminal: currentAttempts >= HISTORY_SHARD_MAX_ATTEMPTS,
        };
      }
      return {
        attempts,
        terminal: attempts >= HISTORY_SHARD_MAX_ATTEMPTS,
      };
    });
  }

  function markHistoryShardCompleted(shardId: number, owner?: string): boolean {
    const timestamp = now();
    const ownerCondition = owner ? ' AND (claim_owner IS NULL OR claim_owner = ?)' : '';
    return runWriteTransaction(db, () => {
      const result = db
        .prepare(
          `UPDATE history_shards
         SET status = 'completed',
             claim_token = NULL,
             claim_owner = NULL,
             claimed_at = NULL,
             lease_expires_at = NULL,
             upload_completed_at = ?,
             completed_at = ?,
             updated_at = ?
         WHERE id = ? AND status = 'processing'${ownerCondition}`,
        )
        .run(timestamp, timestamp, timestamp, shardId, ...(owner ? [owner] : []));
      return Number(result.changes) > 0;
    });
  }

  function renewHistoryShardLease(shardId: number, owner?: string): boolean {
    const timestamp = now();
    const ownerCondition = owner ? ' AND (claim_owner IS NULL OR claim_owner = ?)' : '';
    return runWriteTransaction(db, () => {
      const result = db
        .prepare(
          `UPDATE history_shards
         SET lease_expires_at = ?,
             updated_at = ?
         WHERE id = ?
           AND status IN ('claimed', 'processing')${ownerCondition}`,
        )
        .run(timestamp + HISTORY_SHARD_LEASE_MS, timestamp, shardId, ...(owner ? [owner] : []));
      return Number(result.changes) > 0;
    });
  }

  function completeHistoryShard(shardId: number, owner?: string): void {
    const isOwnedByCurrentOwner = () => {
      if (!owner) return true;
      const row = db.prepare('SELECT claim_owner FROM history_shards WHERE id = ?').get(shardId) as
        | { claim_owner: string | null }
        | undefined;
      return !row?.claim_owner || row.claim_owner === owner;
    };
    if (!isOwnedByCurrentOwner()) return;
    let markedCompleted = false;
    try {
      // Persist the upload-completed fact before deleting the shard. If cleanup
      // fails, recovery sees 'completed' and only retries cleanup, never upload.
      markedCompleted = markHistoryShardCompleted(shardId, owner);
    } catch {
      // The caller only reaches this point after upload has settled. A failed
      // marker write must not leave the shard retryable or it would upload the
      // same snapshot twice, so cleanup still proceeds below.
    }
    if (owner && !isOwnedByCurrentOwner()) return;
    try {
      runWriteTransaction(db, () => {
        const currentShard = db
          .prepare(
            `SELECT status, claim_owner
             FROM history_shards
             WHERE id = ?`,
          )
          .get(shardId) as { status: string; claim_owner: string | null } | undefined;
        if (
          !currentShard ||
          (owner && currentShard.claim_owner && currentShard.claim_owner !== owner) ||
          (currentShard.status !== 'processing' && currentShard.status !== 'completed')
        ) {
          return;
        }
        recordConsumedHistoryShardMessages(db, shardId, now());
        db.prepare('DELETE FROM conversation_messages WHERE shard_id = ?').run(shardId);
        db.prepare('DELETE FROM history_shards WHERE id = ?').run(shardId);
      });
    } catch (error) {
      if (!markedCompleted) {
        try {
          markHistoryShardCompleted(shardId, owner);
        } catch {
          // Preserve the original cleanup error.
        }
      }
      throw error;
    }
  }

  function recoverHistoryShards(skipHistoryKeys: readonly string[] = [], owner?: string): number {
    const skipped = normalizeHistoryKeySkipList(skipHistoryKeys);
    return recoverHistoryShardsWithSkip(skipped, owner);
  }

  function normalizeHistoryKeySkipList(skipHistoryKeys: readonly string[] | undefined): string[] {
    const normalized: string[] = [];
    for (const rawKey of skipHistoryKeys ?? []) {
      const key = String(rawKey || '').trim();
      if (!key) continue;
      normalized.push(key);
      const legacyKey = toLegacyHistoryKey(key);
      if (legacyKey && legacyKey !== key) normalized.push(legacyKey);
    }
    return Array.from(new Set(normalized));
  }

  function toLegacyHistoryKey(historyKey: string): string {
    const firstColon = historyKey.indexOf(':');
    if (firstColon <= 0) return '';
    const secondColon = historyKey.indexOf(':', firstColon + 1);
    if (secondColon <= firstColon + 1) return '';
    return historyKey.slice(firstColon + 1);
  }

  function buildHistoryKeySkipCondition(skipped: readonly string[]): string {
    return skipped.length > 0
      ? ` AND history_key NOT IN (${skipped.map(() => '?').join(', ')})`
      : '';
  }

  function recoverHistoryShardsWithSkip(skipped: readonly string[], owner?: string): number {
    const timestamp = now();
    const skipCondition = buildHistoryKeySkipCondition(skipped);
    const ownerCondition = owner
      ? ` AND (claim_owner IS NULL OR claim_owner = 'bncr-node' OR claim_owner = ? OR claim_owner LIKE ?)`
      : '';
    const ownerParams = owner ? [owner, `${String(owner).split(':')[0]}:%`] : [];
    return runWriteTransaction(db, () => {
      const result = db
        .prepare(
          `UPDATE history_shards
         SET status = 'queued',
             last_error = 'stale lease recovered',
             next_attempt_at = NULL,
             claim_token = NULL,
             claim_owner = NULL,
             claimed_at = NULL,
             lease_expires_at = NULL,
             updated_at = ?
         WHERE status IN ('claimed', 'processing')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < ?${skipCondition}${ownerCondition}`,
        )
        .run(timestamp, timestamp, ...skipped, ...ownerParams);
      return Number(result.changes);
    });
  }

  function recoverInFlightHistoryShards(
    skipHistoryKeys: readonly string[] = [],
    owner?: string,
  ): number {
    const timestamp = now();
    const skipped = normalizeHistoryKeySkipList(skipHistoryKeys);
    const skipCondition = buildHistoryKeySkipCondition(skipped);
    const ownerCondition = owner
      ? ` AND (claim_owner IS NULL OR claim_owner = 'bncr-node' OR claim_owner = ? OR claim_owner LIKE ?)`
      : '';
    const ownerParams = owner ? [owner, `${String(owner).split(':')[0]}:%`] : [];
    return runWriteTransaction(db, () => {
      const result = db
        .prepare(
          `UPDATE history_shards
         SET status = 'queued',
             last_error = 'startup in-flight recovered',
             next_attempt_at = NULL,
             claim_token = NULL,
             claim_owner = NULL,
             claimed_at = NULL,
             lease_expires_at = NULL,
             updated_at = ?
         WHERE status IN ('claimed', 'processing', 'abandoned')${skipCondition}${ownerCondition}`,
        )
        .run(timestamp, ...skipped, ...ownerParams);
      return Number(result.changes);
    });
  }

  function claimNextHistoryShard(
    skipHistoryKeys: readonly string[] = [],
    owner = 'bncr-node',
  ): BncrHistoryShardRow | null {
    const timestamp = now();
    const skipped = normalizeHistoryKeySkipList(skipHistoryKeys);
    const skipCondition = buildHistoryKeySkipCondition(skipped);
    const ownerCondition = owner
      ? ` AND (claim_owner IS NULL OR claim_owner = 'bncr-node' OR claim_owner = ? OR claim_owner LIKE ?)`
      : '';
    const ownerParams = owner ? [owner, `${String(owner).split(':')[0]}:%`] : [];
    return runWriteTransaction(db, () => {
      db.prepare(
        `UPDATE history_shards
         SET status = 'queued',
             last_error = 'stale lease recovered',
             next_attempt_at = NULL,
             claim_token = NULL,
             claim_owner = NULL,
             claimed_at = NULL,
             lease_expires_at = NULL,
             updated_at = ?
         WHERE status IN ('claimed', 'processing')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < ?${skipCondition}${ownerCondition}`,
      ).run(timestamp, timestamp, ...skipped, ...ownerParams);

      const row = db
        .prepare(
          `SELECT id, history_key, account_id, status, attempts, payload_json,
                  message_ids_json, buffer_keys_json, last_error, next_attempt_at,
                  claim_owner
           FROM history_shards
           WHERE status IN ('queued', 'failed')
             AND (
               (status = 'queued' AND next_attempt_at IS NULL AND attempts < ?)
               OR (next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
             )${skipCondition}
           ORDER BY queued_at ASC, id ASC
           LIMIT 1`,
        )
        .get(HISTORY_SHARD_MAX_ATTEMPTS, timestamp, ...skipped) as
        | {
            id: number;
            history_key: string;
            account_id: string | null;
            status: string;
            attempts: number;
            payload_json: string;
            message_ids_json: string;
            buffer_keys_json: string;
            last_error: string | null;
            next_attempt_at: number | null;
            claim_owner: string | null;
          }
        | undefined;
      if (!row) {
        return null;
      }
      const claimToken = `bncr:${row.id}:${timestamp}:${Math.random().toString(36).slice(2)}`;
      db.prepare(
        `UPDATE history_shards
         SET status = 'claimed',
             claim_token = ?,
             claim_owner = ?,
             claimed_at = ?,
             lease_expires_at = ?,
             updated_at = ?
         WHERE id = ? AND status IN ('queued', 'failed')`,
      ).run(claimToken, owner, timestamp, timestamp + HISTORY_SHARD_LEASE_MS, timestamp, row.id);
      return {
        id: row.id,
        historyKey: row.history_key,
        accountId: row.account_id,
        status: 'claimed',
        attempts: row.attempts,
        payloadJson: row.payload_json,
        messageIds: parseOutboundStringArray(row.message_ids_json),
        bufferKeys: parseOutboundStringArray(row.buffer_keys_json),
        lastError: row.last_error,
        nextAttemptAt: row.next_attempt_at,
        ...(owner ? { owner } : {}),
      };
    });
  }

  function listHistoryShards() {
    const rows = db
      .prepare(
        `SELECT id, history_key, account_id, status, attempts, payload_json,
                message_ids_json, buffer_keys_json, last_error, next_attempt_at,
                claim_owner
         FROM history_shards
         ORDER BY id ASC`,
      )
      .all() as Array<{
      id: number;
      history_key: string;
      account_id: string | null;
      status: string;
      attempts: number;
      payload_json: string;
      message_ids_json: string;
      buffer_keys_json: string;
      last_error: string | null;
      next_attempt_at: number | null;
      claim_owner: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      historyKey: row.history_key,
      accountId: row.account_id,
      status: row.status,
      attempts: row.attempts,
      payloadJson: row.payload_json,
      messageIds: parseOutboundStringArray(row.message_ids_json),
      bufferKeys: parseOutboundStringArray(row.buffer_keys_json),
      lastError: row.last_error,
      nextAttemptAt: row.next_attempt_at,
      ...(row.claim_owner ? { owner: row.claim_owner } : {}),
    }));
  }

  return {
    getPath: () => dbPath,
    close: () => db.close(),
    rotateSnapshot: () => rotateSqliteSnapshot({ db, dbPath, now }),
    getStoreMode,
    isControlStateImported: () => getMeta('legacy_json_imported_at') !== null,
    isHistoryImported: () => getMeta('history_imported_at') !== null,
    setStoreMode: (mode) => setMeta('store_mode', mode),
    getMeta,
    setMeta,
    ensureMigrated: () => applyMigrations(db, now),
    importControlState: (state, importOptions = {}) => {
      replaceControlState(db, state, now);
      setMeta('legacy_json_path', importOptions.legacyJsonPath ?? '');
      if (importOptions.legacyJsonSha256)
        setMeta('legacy_json_sha256', importOptions.legacyJsonSha256);
      setMeta('legacy_json_imported_at', String(now()));
      setMeta('store_mode', importOptions.storeMode ?? 'dual');
    },
    loadControlState: () => loadControlState(db),
    saveControlState: (state, scope, removedScenes) => {
      const mode = getStoreMode();
      assertWritable(mode);
      replaceControlState(db, state, now, scope?.agentId ?? null, removedScenes);
    },
    importHistoryState: (historyBuckets, replayBuckets) => {
      const mode = getStoreMode();
      assertWritable(mode);
      replaceHistoryMessages(db, historyBuckets, replayBuckets, now);
    },
    loadHistoryState: (skipHistoryKeys?: readonly string[], owner?: string) => {
      recoverHistoryShards(skipHistoryKeys, owner);
      return loadHistoryState(db, now());
    },
    getHistoryStateRevision: () => {
      const row = db
        .prepare("SELECT meta_value FROM state_meta WHERE meta_key = 'history_revision'")
        .get() as { meta_value: string } | undefined;
      return Number(row?.meta_value ?? 0);
    },
    saveHistoryState: (historyBuckets, replayBuckets, expectedRevision) => {
      const mode = getStoreMode();
      assertWritable(mode);
      replaceHistoryMessages(db, historyBuckets, replayBuckets, now, expectedRevision);
    },
    isOutboundImported: () => getMeta('outbound_imported_at') !== null,
    importOutboundState: (outbox, deadLetter) => {
      const mode = getStoreMode();
      assertWritable(mode);
      replaceOutboundState(db, outbox, deadLetter, now);
    },
    loadOutboundState: (scope) => loadOutboundState(db, scope?.agentId ?? null),
    saveOutboundState: (outbox, deadLetter, scope) => {
      const mode = getStoreMode();
      assertWritable(mode);
      replaceOutboundState(db, outbox, deadLetter, now, scope?.agentId ?? null);
    },
    createHistoryShard,
    markHistoryShardProcessing,
    markHistoryShardFailed,
    markHistoryShardCompleted,
    renewHistoryShardLease,
    completeHistoryShard,
    recoverHistoryShards,
    recoverInFlightHistoryShards,
    restoreTerminalHistoryShardsToActive: () => restoreTerminalHistoryShardsToActive(db, now()),
    claimNextHistoryShard,
    cleanupCompletedHistoryShards: () => cleanupCompletedHistoryShards(db, now()),
    listHistoryShards,
  };
}

export function validateSqliteMigrationChecksums(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC')
      .all() as AppliedMigrationRow[];
    assertAppliedMigrations(rows);
    assertSqliteDatabaseHealth(db);
    assertSqliteWriteContract(db);
    return rows.map((row) => `${row.version}:${row.checksum}`);
  } finally {
    db.close();
  }
}

export function createEmptyBncrSqliteControlState(): BncrSqliteControlState {
  return {
    sessionRoutes: [],
    sceneRegistry: [],
    lastSessionByAccount: [],
    lastActivityByAccount: [],
    lastInboundByAccount: [],
    lastOutboundByAccount: [],
    lastDriftSnapshot: null,
  };
}
