import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { shouldEnableBncrSqliteState } from '../../src/plugin/state-transient-runtime-group.ts';

test('shouldEnableBncrSqliteState requires a state path and honors explicit opt-out', () => {
  assert.equal(shouldEnableBncrSqliteState(null), false);
  assert.equal(shouldEnableBncrSqliteState(''), false);
});

test('shouldEnableBncrSqliteState honors explicit env opt-in and opt-out', async () => {
  const originalStore = process.env.BNCR_SQLITE_STORE;
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-detect-env-'));
  try {
    const statePath = join(dir, 'bncr-bridge-state.json');
    process.env.BNCR_SQLITE_STORE = '1';
    assert.equal(shouldEnableBncrSqliteState(statePath), true);
    process.env.BNCR_SQLITE_STORE = '0';
    await writeFile(join(dir, 'bncr.sqlite3'), '', 'utf8');
    assert.equal(shouldEnableBncrSqliteState(statePath), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (originalStore === undefined) delete process.env.BNCR_SQLITE_STORE;
    else process.env.BNCR_SQLITE_STORE = originalStore;
  }
});

test('shouldEnableBncrSqliteState detects an existing sqlite database without env opt-in', async () => {
  const originalStore = process.env.BNCR_SQLITE_STORE;
  delete process.env.BNCR_SQLITE_STORE;
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-detect-'));
  try {
    const statePath = join(dir, 'bncr-bridge-state.json');
    await writeFile(statePath, '{}', 'utf8');
    await writeFile(join(dir, 'bncr.sqlite3'), '', 'utf8');
    assert.equal(shouldEnableBncrSqliteState(statePath), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (originalStore === undefined) delete process.env.BNCR_SQLITE_STORE;
    else process.env.BNCR_SQLITE_STORE = originalStore;
  }
});

test('shouldEnableBncrSqliteState treats missing database as disabled without env opt-in', async () => {
  const originalStore = process.env.BNCR_SQLITE_STORE;
  delete process.env.BNCR_SQLITE_STORE;
  const dir = await mkdtemp(join(tmpdir(), 'bncr-sqlite-detect-missing-'));
  try {
    const statePath = join(dir, 'bncr-bridge-state.json');
    await writeFile(statePath, '{}', 'utf8');
    assert.equal(shouldEnableBncrSqliteState(statePath), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (originalStore === undefined) delete process.env.BNCR_SQLITE_STORE;
    else process.env.BNCR_SQLITE_STORE = originalStore;
  }
});
