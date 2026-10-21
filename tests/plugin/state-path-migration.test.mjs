import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  prepareBncrStateDirectory,
  resolveBncrStatePaths,
} from '../../src/plugin/state-path-migration.ts';

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function createMarkerDatabase(dbPath, marker) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE migration_marker (value TEXT NOT NULL)');
  db.prepare('INSERT INTO migration_marker (value) VALUES (?)').run(marker);
  return db;
}

function readMarker(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT value FROM migration_marker').get()?.value;
  } finally {
    db.close();
  }
}

test('prepareBncrStateDirectory copies legacy json and backups without deleting rollback copies', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'bncr-state-migration-json-'));
  const paths = resolveBncrStatePaths(stateDir);
  const legacyState = JSON.stringify({ outbox: [], deadLetter: [], sessionRoutes: [] });
  const backupName = 'bncr-bridge-state.pre-sqlite-20260814100401.json';

  try {
    await writeFile(paths.legacyStatePath, legacyState, 'utf8');
    await writeFile(path.join(stateDir, backupName), legacyState, 'utf8');

    const result = await prepareBncrStateDirectory(stateDir);

    assert.equal(await readFile(paths.statePath, 'utf8'), legacyState);
    assert.equal(await readFile(paths.legacyStatePath, 'utf8'), legacyState);
    assert.equal(await readFile(path.join(paths.backupDir, backupName), 'utf8'), legacyState);
    assert.deepEqual(
      new Set(result.copied),
      new Set([paths.statePath, path.join(paths.backupDir, backupName)]),
    );

    await writeFile(paths.statePath, '{"authoritative":true}', 'utf8');
    await prepareBncrStateDirectory(stateDir);
    assert.equal(await readFile(paths.statePath, 'utf8'), '{"authoritative":true}');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('prepareBncrStateDirectory migrates a live WAL source with committed rows', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'bncr-state-migration-wal-'));
  const paths = resolveBncrStatePaths(stateDir);
  let source;

  try {
    source = createMarkerDatabase(paths.legacySqlitePath, 'legacy-wal-row');
    assert.equal(await exists(`${paths.legacySqlitePath}-wal`), true);

    const result = await prepareBncrStateDirectory(stateDir);

    assert.equal(readMarker(paths.sqlitePath), 'legacy-wal-row');
    assert.equal(await exists(paths.legacySqlitePath), true);
    assert.deepEqual(result.copied, [paths.sqlitePath]);
  } finally {
    source?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('prepareBncrStateDirectory keeps a complete database during concurrent startup migration', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'bncr-state-migration-concurrent-'));
  const paths = resolveBncrStatePaths(stateDir);
  let source;

  try {
    source = createMarkerDatabase(paths.legacySqlitePath, 'concurrent-row');

    const results = await Promise.all([
      prepareBncrStateDirectory(stateDir),
      prepareBncrStateDirectory(stateDir),
    ]);

    assert.equal(readMarker(paths.sqlitePath), 'concurrent-row');
    assert.equal(results.filter((result) => result.copied.includes(paths.sqlitePath)).length, 1);
  } finally {
    source?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('prepareBncrStateDirectory never overwrites an existing new database', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'bncr-state-migration-new-wins-'));
  const paths = resolveBncrStatePaths(stateDir);
  let legacy;
  let current;

  try {
    await mkdir(paths.pluginStateDir, { recursive: true });
    legacy = createMarkerDatabase(paths.legacySqlitePath, 'legacy-row');
    current = createMarkerDatabase(paths.sqlitePath, 'current-row');

    const result = await prepareBncrStateDirectory(stateDir);

    assert.equal(readMarker(paths.sqlitePath), 'current-row');
    assert.equal(readMarker(paths.legacySqlitePath), 'legacy-row');
    assert.deepEqual(result.copied, []);
  } finally {
    legacy?.close();
    current?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('prepareBncrStateDirectory creates the plugin state layout for a fresh install', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'bncr-state-migration-fresh-'));
  const paths = resolveBncrStatePaths(stateDir);

  try {
    const result = await prepareBncrStateDirectory(stateDir);

    assert.equal(await exists(paths.pluginStateDir), true);
    assert.equal(await exists(paths.backupDir), true);
    assert.equal(await exists(paths.statePath), false);
    assert.equal(await exists(paths.sqlitePath), false);
    assert.deepEqual(result.copied, []);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('prepareBncrStateDirectory stores migrated state with owner-only permissions', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'bncr-state-migration-mode-'));
  const paths = resolveBncrStatePaths(stateDir);
  const legacyState = JSON.stringify({ outbox: [], deadLetter: [], sessionRoutes: [] });
  const backupName = 'bncr-bridge-state.pre-sqlite-20260814100401.json';

  try {
    await writeFile(paths.legacyStatePath, legacyState, 'utf8');
    await chmod(paths.legacyStatePath, 0o644);
    await writeFile(path.join(stateDir, backupName), legacyState, 'utf8');
    await chmod(path.join(stateDir, backupName), 0o644);

    await prepareBncrStateDirectory(stateDir);

    assert.equal((await stat(paths.pluginStateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.backupDir)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.statePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(paths.backupDir, backupName))).mode & 0o777, 0o600);

    await chmod(paths.pluginStateDir, 0o755);
    await chmod(paths.statePath, 0o644);
    await prepareBncrStateDirectory(stateDir);

    assert.equal((await stat(paths.pluginStateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.statePath)).mode & 0o777, 0o600);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
