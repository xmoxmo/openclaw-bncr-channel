import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeClientSceneStateList, unwrapClientRpcResult } from '../../src/channel.ts';
import { buildCanonicalBncrSessionKey } from '../../src/core/targets.ts';
import {
  buildStaleSceneSessionKey,
  executeStaleScenesCommand,
  parseStaleScenesCommand,
  STALE_SCENES_FILTERS,
  STALE_SCENES_HELP_TEXT,
} from '../../src/messaging/inbound/stale-scenes-command.ts';
import { setSceneRecord } from '../../src/plugin/scene-registry.ts';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function groupRow(overrides = {}) {
  return {
    sceneKey: 'GewePlus:51720530884',
    kind: 'group',
    status: 'allowed',
    platform: 'GewePlus',
    groupId: '51720530884',
    groupName: 'Golem_test',
    agentId: 'public',
    lastSeenAt: NOW - 94 * DAY,
    ...overrides,
  };
}

function directRow(overrides = {}) {
  return {
    sceneKey: 'qq:2705342113',
    kind: 'direct',
    status: 'allowed',
    platform: 'qq',
    userId: '2705342113',
    userName: '小陌',
    agentId: 'orion',
    lastSeenAt: NOW - 73 * DAY,
    ...overrides,
  };
}

function command(name, argsText = '') {
  return { command: name, raw: `/bncr ${name}`, body: `/bncr ${name}`, argsText };
}

function buildDeps(args) {
  const registry = new Map();
  for (const row of args.rows ?? []) setSceneRecord(registry, row);
  const deleted = [];
  const purged = [];
  const reads = [];
  const sessions = new Map(Object.entries(args.sessions ?? {}));
  const nodes = new Map(Object.entries(args.nodes ?? {}));
  const deps = {
    sceneRegistry: registry,
    now: () => NOW,
    readSessionUpdatedAt: async ({ agentId, sessionKey }) => {
      reads.push({ agentId, sessionKey });
      return sessions.get(`${agentId}|${sessionKey}`) ?? null;
    },
    deleteSession: async (args) => {
      deleted.push(args);
      return true;
    },
    purgeSessionState: async ({ sceneKey, agentId, sessionKey }) => {
      purged.push({ sceneKey, agentId, sessionKey });
    },
  };
  // Only wire the reverse-lookup path when a test opts in, so the legacy
  // timestamp-only cases keep exercising the readSessionUpdatedAt fallback.
  if (args.nodes) {
    deps.readSessionNode = async ({ agentId, sessionKey }) => nodes.get(`${agentId}|${sessionKey}`);
  }
  return { deps, registry, deleted, purged, reads };
}

test('parse: /bncr stale lists, help is recognised, extra args are a usage error', () => {
  // Bare stale is the cleanup view: half a year, clock only.
  assert.deepEqual(parseStaleScenesCommand(command('stale')), {
    matched: true,
    valid: true,
    command: { action: 'list', filter: 'all', days: 180, includeAnomalies: false },
  });
  assert.deepEqual(parseStaleScenesCommand(command('stale', 'help')), {
    matched: true,
    valid: true,
    command: { action: 'help' },
  });
  const invalid = parseStaleScenesCommand(command('stale', 'whatever'));
  assert.equal(invalid.matched, true);
  assert.equal(invalid.valid, false);
  assert.match(invalid.text, /Usage:/);
});

test('parse: stale accepts every filter, including the session anomalies', () => {
  assert.deepEqual([...STALE_SCENES_FILTERS], ['all', 'swapped', 'solo', 'missing', 'archived']);
  for (const filter of STALE_SCENES_FILTERS) {
    // Every filter word is the diagnostic view: 72h, session anomalies included.
    assert.deepEqual(parseStaleScenesCommand(command('stale', filter)), {
      matched: true,
      valid: true,
      command: { action: 'list', filter, includeAnomalies: true },
    });
  }
});

test('help and usage take their filter list from the same source as parse', () => {
  const bracketed = `[${STALE_SCENES_FILTERS.join('|')}]`;
  assert.ok(STALE_SCENES_HELP_TEXT.includes(bracketed), 'help must list every filter');
  const invalid = parseStaleScenesCommand(command('stale', 'whatever'));
  assert.equal(invalid.valid, false);
  assert.ok(invalid.text.includes(bracketed), 'usage must list every filter');
});

test('parse: prune requires an explicit SceneId and accepts an optional agent and force', () => {
  assert.deepEqual(parseStaleScenesCommand(command('prune', 'GewePlus:51720530884')), {
    matched: true,
    valid: true,
    command: { action: 'prune', sceneKey: 'GewePlus:51720530884', force: false },
  });
  assert.deepEqual(parseStaleScenesCommand(command('prune', 'GewePlus:51720530884 public force')), {
    matched: true,
    valid: true,
    command: {
      action: 'prune',
      sceneKey: 'GewePlus:51720530884',
      agentId: 'public',
      force: true,
    },
  });
  // No SceneId means the current chat, which is the one row an operator is
  // most likely to delete by accident.
  const invalid = parseStaleScenesCommand(command('prune', 'public'));
  assert.equal(invalid.valid, false);
  assert.match(invalid.text, /Usage:/);
  assert.equal(parseStaleScenesCommand(command('mode')).matched, false);
});

test('session key derives from the scene platform and id', () => {
  assert.equal(
    buildStaleSceneSessionKey(groupRow(), 'public'),
    buildCanonicalBncrSessionKey(
      { platform: 'GewePlus', groupId: '51720530884', userId: '0' },
      'public',
    ),
  );
  assert.equal(
    buildStaleSceneSessionKey(directRow(), 'orion'),
    buildCanonicalBncrSessionKey({ platform: 'qq', groupId: '0', userId: '2705342113' }, 'orion'),
  );
  assert.equal(buildStaleSceneSessionKey(groupRow({ agentId: undefined }), ''), null);
});

test('list: only rows whose scene and session are both older than 72h are listed', async () => {
  const stale = groupRow();
  const active = groupRow({
    sceneKey: 'GolemPlus:51720530884',
    platform: 'GolemPlus',
    lastSeenAt: NOW - 60 * 1000,
  });
  // Old row, live session: cron deliveries keep the session warm without
  // touching the bncr inbound row, so this one must not be listed.
  const sessionAlive = groupRow({
    sceneKey: 'tgBot:-5043812861',
    platform: 'tgBot',
    groupId: '-5043812861',
    groupName: 'wind_novel',
    agentId: 'orion',
    lastSeenAt: NOW - 103 * DAY,
  });
  const { deps } = buildDeps({
    rows: [stale, active, sessionAlive],
    sessions: {
      [`public|${buildStaleSceneSessionKey(stale, 'public')}`]: NOW - 94 * DAY,
      [`public|${buildStaleSceneSessionKey(active, 'public')}`]: NOW - 60 * 1000,
      [`orion|${buildStaleSceneSessionKey(sessionAlive, 'orion')}`]: NOW - 11 * 60 * 60 * 1000,
    },
  });

  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /1 of 3 scene rows/);
  assert.match(result.text, /GewePlus:51720530884/);
  assert.match(result.text, /GewePlus · Golem_test · 51720530884/);
  assert.doesNotMatch(result.text, /GolemPlus:51720530884/);
  assert.doesNotMatch(result.text, /wind_novel/);
});

test('list: a row without a host session counts as quiet once the row itself is old', async () => {
  const row = groupRow({ agentId: 'orion', lastSeenAt: NOW - 119 * DAY });
  const { deps } = buildDeps({ rows: [row] });
  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  assert.match(result.text, /GewePlus:51720530884/);
  assert.match(result.text, /session=none \(none\)/);
});

test('list: reports a clean registry instead of an empty body', async () => {
  const { deps } = buildDeps({ rows: [groupRow({ lastSeenAt: NOW - 60 * 1000 })] });
  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /No stale scenes/);
});

test('prune: deletes the host session first and then the scene row', async () => {
  const row = groupRow();
  const { deps, registry, deleted, purged } = buildDeps({
    rows: [row],
    sessions: { [`public|${buildStaleSceneSessionKey(row, 'public')}`]: NOW - 94 * DAY },
  });

  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, agentId: 'public', force: false },
    ...deps,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Pruned 1 scene row/);
  assert.match(result.text, /GewePlus · Golem_test · 51720530884/);
  assert.deepEqual(deleted, [
    {
      agentId: 'public',
      sessionKey: buildStaleSceneSessionKey(row, 'public'),
      archiveTranscript: true,
      expectedUpdatedAt: NOW - 94 * DAY,
    },
  ]);
  assert.deepEqual(purged, [
    {
      sceneKey: row.sceneKey,
      agentId: 'public',
      sessionKey: buildStaleSceneSessionKey(row, 'public'),
    },
  ]);
  assert.equal(registry.size, 0);
});

test('prune: conditional delete carries the exact host session snapshot', async () => {
  const row = groupRow();
  const sessionKey = buildStaleSceneSessionKey(row, 'public');
  const { deps, deleted } = buildDeps({
    rows: [row],
    nodes: {
      [`public|${sessionKey}`]: {
        exists: true,
        sessionId: 'session-generation-1',
        archivedAt: null,
        updatedAt: NOW - 94 * DAY,
        lastInteractionAt: NOW - 95 * DAY,
      },
    },
  });

  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, agentId: 'public', force: false },
    ...deps,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(deleted, [
    {
      agentId: 'public',
      sessionKey,
      archiveTranscript: true,
      expectedSessionId: 'session-generation-1',
      expectedUpdatedAt: NOW - 94 * DAY,
    },
  ]);
});

test('prune: refuses an active scene unless force is given', async () => {
  const row = groupRow({ lastSeenAt: NOW - 60 * 1000 });
  const { deps, registry, deleted } = buildDeps({
    rows: [row],
    sessions: { [`public|${buildStaleSceneSessionKey(row, 'public')}`]: NOW - 60 * 1000 },
  });

  const refused = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, force: false },
    ...deps,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /still active within 72h/);
  assert.match(refused.text, /force/);
  assert.equal(registry.size, 1);
  assert.equal(deleted.length, 0);

  const forced = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, force: true },
    ...deps,
  });
  assert.equal(forced.ok, true);
  assert.equal(registry.size, 0);
  assert.equal(deleted.length, 1);
});

test('prune: unknown scene and unknown agent both answer instead of deleting', async () => {
  const row = groupRow();
  const { deps, registry } = buildDeps({ rows: [row] });

  const missing = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: 'GewePlus:999', force: false },
    ...deps,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /Scene not found: GewePlus:999/);

  const wrongAgent = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, agentId: 'orion', force: false },
    ...deps,
  });
  assert.equal(wrongAgent.ok, false);
  assert.match(wrongAgent.text, /has no scene row for GewePlus:51720530884/);
  assert.match(wrongAgent.text, /Agents here: public/);
  assert.equal(registry.size, 1);
});

test('prune: a failed session delete keeps the row for a safe retry', async () => {
  const row = groupRow();
  const registry = new Map();
  setSceneRecord(registry, row);
  const purged = [];
  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, force: false },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionUpdatedAt: async () => NOW - 94 * DAY,
    deleteSession: async () => {
      throw new Error('store missing');
    },
    purgeSessionState: async (args) => {
      purged.push(args);
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Nothing pruned/);
  assert.match(result.text, /Skipped \(delete failed\)/);
  assert.doesNotMatch(result.text, /active again/);
  assert.equal(registry.size, 1);
  assert.equal(purged.length, 0);
});

test('prune: a conditional delete rejection keeps the scene row', async () => {
  const row = groupRow();
  const registry = new Map();
  setSceneRecord(registry, row);
  const purged = [];
  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, force: false },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionUpdatedAt: async () => NOW - 94 * DAY,
    deleteSession: async () => false,
    purgeSessionState: async (args) => {
      purged.push(args);
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Nothing pruned/);
  assert.match(result.text, /Skipped \(active again\)/);
  assert.equal(registry.size, 1);
  assert.equal(purged.length, 0);
});

test('prune: a scene revived during host delete is not purged', async () => {
  const row = groupRow();
  const registry = new Map();
  setSceneRecord(registry, row);
  let purges = 0;
  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, agentId: 'public', force: false },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionUpdatedAt: async () => NOW - 94 * DAY,
    deleteSession: async () => {
      setSceneRecord(registry, { ...row, lastSeenAt: NOW });
      return true;
    },
    purgeSessionState: async () => {
      purges += 1;
    },
  });

  assert.equal(result.ok, true);
  assert.match(result.text, /Skipped \(active again\)/);
  assert.equal(purges, 0, 'a scene that woke during delete keeps its bridge state');
  assert.equal(registry.size, 1);
});

test('sibling: another platform on the same group is marked, and filters split the list', async () => {
  const deadWithSibling = groupRow();
  const sibling = groupRow({
    sceneKey: 'GolemPlus:51720530884',
    platform: 'GolemPlus',
    lastSeenAt: NOW - 16 * 60 * 60 * 1000,
  });
  const deadAlone = groupRow({
    sceneKey: 'GewePlus:48643803541',
    groupId: '48643803541',
    groupName: '莓莓园区内部群',
    lastSeenAt: NOW - 83 * DAY,
  });
  const { deps } = buildDeps({
    rows: [deadWithSibling, sibling, deadAlone],
    sessions: {
      [`public|${buildStaleSceneSessionKey(deadWithSibling, 'public')}`]: NOW - 94 * DAY,
      [`public|${buildStaleSceneSessionKey(sibling, 'public')}`]: NOW - 16 * 60 * 60 * 1000,
      [`public|${buildStaleSceneSessionKey(deadAlone, 'public')}`]: NOW - 83 * DAY,
    },
  });

  const all = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  assert.match(all.text, /sibling=GolemPlus 16h \(active\)/);
  assert.match(all.text, /sibling=none/);

  const swapped = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'swapped' },
    ...deps,
  });
  assert.match(swapped.text, /GewePlus:51720530884/);
  assert.doesNotMatch(swapped.text, /48643803541/);
  assert.match(swapped.text, /swapped: another platform on the same group active within 24h/);

  const solo = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'solo' },
    ...deps,
  });
  assert.match(solo.text, /GewePlus:48643803541/);
  assert.doesNotMatch(solo.text, /51720530884/);
});

test('sibling: a quiet sibling is reported without the active mark', async () => {
  const dead = groupRow();
  const quietSibling = groupRow({
    sceneKey: 'GolemPlus:51720530884',
    platform: 'GolemPlus',
    lastSeenAt: NOW - 17 * DAY,
  });
  const { deps } = buildDeps({
    rows: [dead, quietSibling],
    sessions: {
      [`public|${buildStaleSceneSessionKey(dead, 'public')}`]: NOW - 94 * DAY,
      [`public|${buildStaleSceneSessionKey(quietSibling, 'public')}`]: NOW - 17 * DAY,
    },
  });
  const all = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  assert.match(all.text, /sibling=GolemPlus 17d\n/);
  assert.doesNotMatch(all.text, /\(active\)/);
});

test('sibling: direct chats never borrow a sibling across platforms', async () => {
  const row = directRow();
  const otherPlatform = directRow({
    sceneKey: 'wxWork:2705342113',
    platform: 'wxWork',
    lastSeenAt: NOW - 60 * 1000,
  });
  const { deps } = buildDeps({
    rows: [row, otherPlatform],
    sessions: {
      [`orion|${buildStaleSceneSessionKey(row, 'orion')}`]: NOW - 73 * DAY,
      [`orion|${buildStaleSceneSessionKey(otherPlatform, 'orion')}`]: NOW - 60 * 1000,
    },
  });
  const all = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  assert.match(all.text, /qq:2705342113/);
  assert.match(all.text, /sibling=none/);
});

test('internal config rows are never listed and cannot be pruned', async () => {
  const globalRow = {
    sceneKey: '__global__',
    kind: 'group',
    status: 'allowed',
    platform: 'bncr',
    downloadMedia: true,
    lastSeenAt: NOW - 100 * DAY,
  };
  const stale = groupRow();
  const { deps, registry } = buildDeps({ rows: [globalRow, stale] });

  const list = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  assert.match(list.text, /1 of 1 scene rows/);
  assert.doesNotMatch(list.text, /__global__/);

  const pruned = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: '__global__', force: true },
    ...deps,
  });
  assert.equal(pruned.ok, false);
  assert.match(pruned.text, /internal config row/);
  assert.equal(registry.size, 2);
});

test('prune skips a row that woke up between the listing and the delete', async () => {
  const row = groupRow();
  const registry = new Map();
  setSceneRecord(registry, row);
  const deleted = [];
  let refreshed = false;
  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, force: false },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionUpdatedAt: async () => {
      if (!refreshed) {
        refreshed = true;
        setSceneRecord(registry, { ...row, lastSeenAt: NOW - 60 * 1000 });
      }
      return NOW - 94 * DAY;
    },
    deleteSession: async () => {
      deleted.push('session');
      return true;
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Nothing pruned/);
  assert.match(result.text, /Skipped \(active again\)/);
  assert.equal(deleted.length, 0);
  assert.equal(registry.size, 1);
});

test('prune of an unowned row purges by scene without a session key', async () => {
  const row = groupRow({ agentId: undefined, lastSeenAt: NOW - 119 * DAY });
  const registry = new Map();
  setSceneRecord(registry, row);
  const deleted = [];
  const purged = [];
  let guardAtPurge;
  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, force: false },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionUpdatedAt: async () => null,
    deleteSession: async (args) => {
      deleted.push(args);
      return true;
    },
    purgeSessionState: async ({ assertCurrent, ...args }) => {
      guardAtPurge = assertCurrent?.();
      purged.push(args);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(deleted.length, 0);
  assert.equal(guardAtPurge, true);
  assert.deepEqual(purged, [{ sceneKey: row.sceneKey, agentId: '', sessionKey: null }]);
  assert.equal(registry.size, 0);
});

test('list shows a per-row label when agents in one scene carry different names', async () => {
  const left = groupRow({ customName: '主群' });
  const right = groupRow({ agentId: 'orion', customName: '备份群' });
  const { deps } = buildDeps({
    rows: [left, right],
    sessions: {
      [`public|${buildStaleSceneSessionKey(left, 'public')}`]: NOW - 94 * DAY,
      [`orion|${buildStaleSceneSessionKey(right, 'orion')}`]: NOW - 94 * DAY,
    },
  });
  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  assert.match(result.text, /label: GewePlus · 主群/);
  assert.match(result.text, /label: GewePlus · 备份群/);
});

test('list says when a filter matched nothing while stale rows exist', async () => {
  const { deps } = buildDeps({
    rows: [groupRow()],
    sessions: { [`public|${buildStaleSceneSessionKey(groupRow(), 'public')}`]: NOW - 94 * DAY },
  });
  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'swapped' },
    ...deps,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /No stale scene matched swapped: 1 stale row\(s\) exist/);
});

test('list treats an unreadable session store as unknown, never as dead', async () => {
  const row = groupRow();
  const registry = new Map();
  setSceneRecord(registry, row);
  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionUpdatedAt: async () => {
      throw new Error('store unavailable');
    },
    deleteSession: async () => true,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /No stale scenes/);
});

test('prune refuses while session activity cannot be read', async () => {
  const row = groupRow();
  const registry = new Map();
  setSceneRecord(registry, row);
  const deleted = [];
  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, force: false },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionUpdatedAt: async () => undefined,
    deleteSession: async () => {
      deleted.push('session');
      return true;
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /session activity could not be read/);
  assert.match(result.text, /session=unreadable \(unknown\)/);
  assert.equal(deleted.length, 0);
  assert.equal(registry.size, 1);
});

test('prune refuses an unknown session without a conditional-delete guard', async () => {
  const row = groupRow();
  const registry = new Map();
  setSceneRecord(registry, row);
  const deleted = [];
  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, agentId: 'public', force: false },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionNode: async () => undefined,
    readSessionUpdatedAt: async () => null,
    deleteSession: async (args) => {
      deleted.push(args);
      return true;
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /session activity could not be read/);
  assert.equal(deleted.length, 0);
  assert.equal(registry.size, 1);
});

test('prune force still permits an explicitly forced unknown delete', async () => {
  const row = groupRow();
  const registry = new Map();
  setSceneRecord(registry, row);
  const deleted = [];
  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, agentId: 'public', force: true },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionNode: async () => undefined,
    readSessionUpdatedAt: async () => null,
    deleteSession: async (args) => {
      deleted.push(args);
      return true;
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Pruned 1 scene row/);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].expectedSessionId, undefined);
  assert.equal(deleted[0].expectedUpdatedAt, undefined);
  assert.equal(registry.size, 0);
});

test('prune gives bridge-state purge the current-scene guard', async () => {
  const row = groupRow();
  const registry = new Map();
  setSceneRecord(registry, row);
  const checks = [];
  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, agentId: 'public', force: false },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionUpdatedAt: async () => NOW - 94 * DAY,
    deleteSession: async () => true,
    purgeSessionState: async ({ assertCurrent }) => {
      checks.push(assertCurrent?.());
      setSceneRecord(registry, { ...row, lastSeenAt: NOW });
      checks.push(assertCurrent?.());
    },
  });
  assert.deepEqual(checks, [true, false]);
  assert.match(result.text, /Skipped \(active again\)/);
  assert.equal(registry.size, 1);
});

test('list caps a long listing and points at the filters', async () => {
  const rows = [];
  const sessions = {};
  for (let i = 0; i < 55; i += 1) {
    const row = groupRow({
      sceneKey: `GewePlus:${50000000000 + i}`,
      groupId: String(50000000000 + i),
      groupName: `chat-${i}`,
    });
    rows.push(row);
    sessions[`public|${buildStaleSceneSessionKey(row, 'public')}`] = NOW - 94 * DAY;
  }
  const { deps } = buildDeps({ rows, sessions });
  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  assert.match(result.text, /55 of 55 scene rows/);
  assert.match(result.text, /… 5 more row\(s\)/);
});

test('parse: the internal row cannot be named as a prune target', () => {
  const parsed = parseStaleScenesCommand(command('prune', '__global__'));
  assert.equal(parsed.matched, true);
  assert.equal(parsed.valid, false);
  assert.match(parsed.text, /Usage:/);
});

test('list says how many rows were skipped because their session was unreadable', async () => {
  const row = groupRow();
  const registry = new Map();
  setSceneRecord(registry, row);
  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionUpdatedAt: async () => undefined,
    deleteSession: async () => true,
  });
  assert.match(result.text, /1 row\(s\) skipped: session unreadable/);
});

test('list: skipped rows are reported even when other rows are printed', async () => {
  const listed = groupRow();
  const skipped = groupRow({
    sceneKey: 'GewePlus:48643803541',
    groupId: '48643803541',
    groupName: 'another chat',
  });
  const registry = new Map();
  setSceneRecord(registry, listed);
  setSceneRecord(registry, skipped);
  const skippedKey = buildStaleSceneSessionKey(skipped, 'public');
  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionNode: async () => undefined,
    readSessionUpdatedAt: async ({ sessionKey }) => {
      if (sessionKey === skippedKey) throw new Error('store unavailable');
      return NOW - 94 * DAY;
    },
    deleteSession: async () => true,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /1 of 2 scene rows/);
  assert.match(result.text, /1 row\(s\) skipped: session unreadable/);
  assert.match(result.text, /GewePlus:51720530884/);
  assert.doesNotMatch(result.text, /48643803541/);
});

test('list: the missing filter surfaces a fresh row whose host session is gone', async () => {
  const row = groupRow({ lastSeenAt: NOW - 60 * 1000 });
  const { deps } = buildDeps({
    rows: [row],
    nodes: {
      [`public|${buildStaleSceneSessionKey(row, 'public')}`]: {
        exists: false,
        archivedAt: null,
        updatedAt: null,
      },
    },
  });

  const missing = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'missing' },
    ...deps,
  });
  assert.equal(missing.ok, true);
  assert.match(missing.text, /GewePlus:51720530884/);
  assert.match(missing.text, /session=missing \(no session row\)/);
  assert.match(missing.text, /missing: host session gone/);

  // The default list also includes it: a gone session is a cleanup candidate
  // even though the scene row itself is fresh.
  const all = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  assert.match(all.text, /GewePlus:51720530884/);
});

test('list: bare stale stays clock only, the filter views add the anomalies', async () => {
  // A fresh row whose session was deleted from the UI is an anomaly, not a
  // quiet chat: the 180d cleanup view must not list it, the 72h diagnostic
  // views must.
  const row = groupRow({ lastSeenAt: NOW - 60 * 1000 });
  const { deps } = buildDeps({
    rows: [row],
    nodes: {
      [`public|${buildStaleSceneSessionKey(row, 'public')}`]: {
        exists: false,
        archivedAt: null,
        updatedAt: null,
      },
    },
  });

  const cleanup = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all', days: 180, includeAnomalies: false },
    ...deps,
  });
  assert.equal(cleanup.ok, true);
  assert.doesNotMatch(cleanup.text, /51720530884/);
  assert.match(cleanup.text, /No stale scenes/);
  // The row is not lost silently: the view names the diagnostic command.
  assert.match(cleanup.text, /1 session anomaly row\(s\) not in this view: \/bncr stale all/);

  for (const filter of ['all', 'missing']) {
    const diagnostic = await executeStaleScenesCommand({
      command: { action: 'list', filter, includeAnomalies: true },
      ...deps,
    });
    assert.match(diagnostic.text, /51720530884/, filter);
  }
});

test('list: the clock view keeps a long-dead row whose session is gone too', async () => {
  // An anomaly is an extra reason to be a candidate, not a reason to hide the
  // row from the 180d cleanup view: this chat is quiet on both clocks.
  const row = groupRow({ lastSeenAt: NOW - 200 * DAY });
  const { deps } = buildDeps({
    rows: [row],
    nodes: {
      [`public|${buildStaleSceneSessionKey(row, 'public')}`]: {
        exists: false,
        archivedAt: null,
        updatedAt: null,
      },
    },
  });

  const cleanup = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all', days: 180, includeAnomalies: false },
    ...deps,
  });
  assert.equal(cleanup.ok, true);
  assert.match(cleanup.text, /51720530884/);
  assert.match(cleanup.text, /session=missing \(no session row\)/);
});

test('list: a clock-view listing still counts the anomalies it left out', async () => {
  const quiet = groupRow({ lastSeenAt: NOW - 200 * DAY });
  const fresh = directRow({ lastSeenAt: NOW - 60 * 1000 });
  const { deps } = buildDeps({
    rows: [quiet, fresh],
    nodes: {
      [`public|${buildStaleSceneSessionKey(quiet, 'public')}`]: {
        exists: true,
        archivedAt: null,
        updatedAt: NOW - 200 * DAY,
      },
      [`orion|${buildStaleSceneSessionKey(fresh, 'orion')}`]: {
        exists: false,
        archivedAt: null,
        updatedAt: null,
      },
    },
  });

  const cleanup = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all', days: 180, includeAnomalies: false },
    ...deps,
  });
  assert.match(cleanup.text, /51720530884/);
  assert.doesNotMatch(cleanup.text, /2705342113/);
  assert.match(cleanup.text, /1 session anomaly row\(s\) not in this view/);

  const diagnostic = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all', includeAnomalies: true },
    ...deps,
  });
  assert.match(diagnostic.text, /2705342113/);
  assert.doesNotMatch(diagnostic.text, /not in this view/);
});

test('list: the archived filter surfaces a session archived from the UI', async () => {
  const row = groupRow({ lastSeenAt: NOW - 60 * 1000 });
  const archivedAt = NOW - 5 * DAY;
  const { deps } = buildDeps({
    rows: [row],
    nodes: {
      [`public|${buildStaleSceneSessionKey(row, 'public')}`]: {
        exists: true,
        archivedAt,
        updatedAt: archivedAt,
      },
    },
  });

  const archived = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'archived' },
    ...deps,
  });
  assert.equal(archived.ok, true);
  assert.match(archived.text, /GewePlus:51720530884/);
  assert.match(archived.text, /session=archived /);
  assert.match(archived.text, /archived: host session archived from the UI/);

  const missing = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'missing' },
    ...deps,
  });
  assert.match(missing.text, /No stale scene matched missing/);
});

test('list: an unreadable session node falls back to the clock, never reported as deleted', async () => {
  const row = groupRow({ lastSeenAt: NOW - 119 * DAY });
  // An empty listing means the session store could not be read. The timestamp
  // reader still answers (null = no entry), so the row keeps the quiet rule and
  // must not be reported as missing — and the list must not go empty.
  const { deps } = buildDeps({ rows: [row], nodes: {} });
  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /GewePlus:51720530884/);
  assert.match(result.text, /session=none \(none\)/);
  assert.doesNotMatch(result.text, /session=missing/);
});

test('list: when both the listing and the clock fail, the row stays unknown', async () => {
  const row = groupRow({ lastSeenAt: NOW - 119 * DAY });
  const registry = new Map();
  setSceneRecord(registry, row);
  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionNode: async () => undefined,
    readSessionUpdatedAt: async () => undefined,
    deleteSession: async () => true,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /No stale scenes/);
  assert.match(result.text, /1 row\(s\) skipped: session unreadable/);
});

test('prune: a row whose host session is gone is prunable without force', async () => {
  const row = groupRow({ lastSeenAt: NOW - 60 * 1000 });
  const { deps, registry, deleted } = buildDeps({
    rows: [row],
    nodes: {
      [`public|${buildStaleSceneSessionKey(row, 'public')}`]: {
        exists: false,
        archivedAt: null,
        updatedAt: null,
      },
    },
  });

  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, force: false },
    ...deps,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Pruned 1 scene row/);
  assert.equal(deleted.length, 0, 'no host delete call when the session is already missing');
  assert.equal(registry.size, 0);
});

test('solo: session anomalies are not counted as a chat that simply went quiet', async () => {
  const quiet = groupRow({ sceneKey: 'GewePlus:60000000001', groupId: '60000000001' });
  const gone = groupRow({ sceneKey: 'GewePlus:60000000002', groupId: '60000000002' });
  const archived = groupRow({ sceneKey: 'GewePlus:60000000003', groupId: '60000000003' });
  const { deps } = buildDeps({
    rows: [quiet, gone, archived],
    sessions: {
      [`public|${buildStaleSceneSessionKey(quiet, 'public')}`]: NOW - 94 * DAY,
      [`public|${buildStaleSceneSessionKey(archived, 'public')}`]: NOW - 94 * DAY,
    },
    nodes: {
      [`public|${buildStaleSceneSessionKey(quiet, 'public')}`]: {
        exists: true,
        archivedAt: null,
        updatedAt: NOW - 94 * DAY,
      },
      [`public|${buildStaleSceneSessionKey(gone, 'public')}`]: {
        exists: false,
        archivedAt: null,
        updatedAt: null,
      },
      [`public|${buildStaleSceneSessionKey(archived, 'public')}`]: {
        exists: true,
        archivedAt: NOW - 3 * DAY,
        updatedAt: NOW - 94 * DAY,
      },
    },
  });

  const solo = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'solo' },
    ...deps,
  });
  assert.match(solo.text, /GewePlus:60000000001/);
  assert.doesNotMatch(solo.text, /GewePlus:60000000002/);
  assert.doesNotMatch(solo.text, /GewePlus:60000000003/);

  const all = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  for (const key of ['60000000001', '60000000002', '60000000003']) {
    assert.match(all.text, new RegExp(`GewePlus:${key}`));
  }
  assert.match(solo.text, /no sibling platform active within 24h and no session anomaly/);
});

test('sibling: an archived sibling does not count as a platform the chat moved to', async () => {
  const dead = groupRow({ sceneKey: 'GewePlus:70000000001', groupId: '70000000001' });
  const archivedSibling = groupRow({
    sceneKey: 'GolemPlus:70000000001',
    platform: 'GolemPlus',
    groupId: '70000000001',
    lastSeenAt: NOW - 200 * DAY,
  });
  const key = (row) => `public|${buildStaleSceneSessionKey(row, 'public')}`;
  const { deps } = buildDeps({
    rows: [dead, archivedSibling],
    nodes: {
      [key(dead)]: { exists: true, archivedAt: null, updatedAt: NOW - 94 * DAY },
      // Archiving writes to the store, so the archived row looks fresh by time.
      [key(archivedSibling)]: {
        exists: true,
        archivedAt: NOW - 3600 * 1000,
        updatedAt: NOW - 3600 * 1000,
      },
    },
  });

  const swapped = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'swapped' },
    ...deps,
  });
  assert.doesNotMatch(swapped.text, /No stale scene matched swapped: 0/);
  assert.doesNotMatch(swapped.text, /GewePlus:70000000001/);

  const all = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  assert.match(all.text, /sibling=GolemPlus 200d/);
  assert.doesNotMatch(all.text, /\(active\)/);
});

test('display: an archived row shows when it was archived, not the last store write', async () => {
  const row = groupRow({ sceneKey: 'GewePlus:80000000001', groupId: '80000000001' });
  const key = `public|${buildStaleSceneSessionKey(row, 'public')}`;
  const { deps } = buildDeps({
    rows: [row],
    nodes: {
      [key]: {
        exists: true,
        archivedAt: NOW - 30 * DAY,
        // A later write (cron delivery, label patch) must not be shown as the
        // archive time.
        updatedAt: NOW - 2 * DAY,
      },
    },
  });
  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'archived' },
    ...deps,
  });
  assert.match(result.text, /archived .*\(30d\)/);
  assert.doesNotMatch(result.text, /archived .*\(2d\)/);
});

test('sibling: an unreadable sibling session is not evidence the chat moved there', async () => {
  const dead = groupRow({ sceneKey: 'GewePlus:90000000001', groupId: '90000000001' });
  const unreadable = groupRow({
    sceneKey: 'GolemPlus:90000000001',
    platform: 'GolemPlus',
    groupId: '90000000001',
    lastSeenAt: NOW - 200 * DAY,
  });
  // No node entry for the sibling: the listing cannot be read, only the clock
  // answers, and it happens to look fresh.
  const { deps } = buildDeps({
    rows: [dead, unreadable],
    sessions: {
      [`public|${buildStaleSceneSessionKey(unreadable, 'public')}`]: NOW - 3600 * 1000,
    },
    nodes: {
      [`public|${buildStaleSceneSessionKey(dead, 'public')}`]: {
        exists: true,
        archivedAt: null,
        updatedAt: NOW - 94 * DAY,
      },
    },
  });

  const swapped = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'swapped' },
    ...deps,
  });
  assert.doesNotMatch(swapped.text, /GewePlus:90000000001/);
});

test('sibling: a store-only write does not count as recent chat activity', async () => {
  const dead = groupRow({ sceneKey: 'GewePlus:90000000002', groupId: '90000000002' });
  const sibling = groupRow({
    sceneKey: 'GolemPlus:90000000002',
    platform: 'GolemPlus',
    groupId: '90000000002',
    lastSeenAt: NOW - 200 * DAY,
  });
  const { deps } = buildDeps({
    rows: [dead, sibling],
    nodes: {
      [`public|${buildStaleSceneSessionKey(dead, 'public')}`]: {
        exists: true,
        sessionId: 'dead-session',
        archivedAt: null,
        updatedAt: NOW - 200 * DAY,
        lastInteractionAt: NOW - 200 * DAY,
      },
      [`public|${buildStaleSceneSessionKey(sibling, 'public')}`]: {
        exists: true,
        sessionId: 'sibling-session',
        archivedAt: null,
        // A label or maintenance write is recent; the last chat was not.
        updatedAt: NOW - 60 * 1000,
        lastInteractionAt: NOW - 200 * DAY,
      },
    },
  });

  const swapped = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'swapped' },
    ...deps,
  });
  assert.doesNotMatch(swapped.text, /GewePlus:90000000002/);
});

test('list: an empty registry says there are no scene rows yet', async () => {
  const { deps } = buildDeps({ rows: [] });
  const empty = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...deps,
  });
  assert.match(empty.text, /No scene rows yet: nothing to clean up\./);

  // Internal config rows are filtered out before the count, so a registry that
  // only holds `__global__` reads the same way.
  const internal = groupRow({ sceneKey: '__global__', kind: 'group', groupId: '_' });
  const onlyInternal = buildDeps({ rows: [internal] });
  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all' },
    ...onlyInternal.deps,
  });
  assert.match(result.text, /No scene rows yet/);
});

test('parse: batch prune takes a day window, defaults to 180 and accepts force', async () => {
  const { BNCR_STALE_SCENE_BATCH_DAYS } = await import(
    '../../src/messaging/inbound/stale-scenes-command.ts'
  );
  assert.equal(BNCR_STALE_SCENE_BATCH_DAYS, 180);
  assert.deepEqual(parseStaleScenesCommand(command('prune', 'stale')), {
    matched: true,
    valid: true,
    command: { action: 'prune-batch', days: 180, force: false },
  });
  assert.deepEqual(parseStaleScenesCommand(command('prune', 'stale 90')), {
    matched: true,
    valid: true,
    command: { action: 'prune-batch', days: 90, force: false },
  });
  assert.deepEqual(parseStaleScenesCommand(command('prune', 'stale 90 force')), {
    matched: true,
    valid: true,
    command: { action: 'prune-batch', days: 90, force: true },
  });
  for (const bad of ['stale 0', 'stale abc', 'stale 90 extra']) {
    const parsed = parseStaleScenesCommand(command('prune', bad));
    assert.equal(parsed.valid, false, bad);
  }
  // A bare day count on stale is the cleanup listing with that window, not a prune.
  assert.deepEqual(parseStaleScenesCommand(command('stale', '180')), {
    matched: true,
    valid: true,
    command: { action: 'list', filter: 'all', days: 180, includeAnomalies: false },
  });
});

test('the 180d listing is exactly what the 180d batch would delete', async () => {
  const quietAlive = groupRow({ lastSeenAt: NOW - 200 * DAY });
  const quietGone = groupRow({
    sceneKey: 'tgBot:-1001414451955',
    platform: 'tgBot',
    groupId: '-1001414451955',
    agentId: 'orion',
    lastSeenAt: NOW - 210 * DAY,
  });
  const freshAnomaly = directRow({ lastSeenAt: NOW - 60 * 1000 });
  const nodes = {
    [`public|${buildStaleSceneSessionKey(quietAlive, 'public')}`]: {
      exists: true,
      archivedAt: null,
      updatedAt: NOW - 200 * DAY,
    },
    [`orion|${buildStaleSceneSessionKey(quietGone, 'orion')}`]: {
      exists: false,
      archivedAt: null,
      updatedAt: null,
    },
    [`orion|${buildStaleSceneSessionKey(freshAnomaly, 'orion')}`]: {
      exists: false,
      archivedAt: null,
      updatedAt: null,
    },
  };
  const { deps, deleted } = buildDeps({
    rows: [quietAlive, quietGone, freshAnomaly],
    nodes,
  });

  const listed = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all', days: 180, includeAnomalies: false },
    ...deps,
  });
  assert.match(listed.text, /51720530884/);
  assert.match(listed.text, /-1001414451955/);
  assert.doesNotMatch(listed.text, /2705342113/);

  const pruned = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: false },
    ...deps,
    clearClientState: async () => ({ ok: true, cleared: 2 }),
  });
  assert.match(pruned.text, /Deleted 2 scene row\(s\)/);
  // Only the live session needs a host delete; the missing one has no entry.
  assert.equal(deleted.length, 1);
  assert.deepEqual(deleted.map((item) => item.sessionKey).sort(), [
    buildStaleSceneSessionKey(quietAlive, 'public'),
  ]);
});

test('batch prune: deletes quiet rows, hands their scene keys to the client once', async () => {
  const old = groupRow({ lastSeenAt: NOW - 200 * DAY });
  const older = groupRow({
    sceneKey: 'tgBot:-1001414451955',
    platform: 'tgBot',
    groupId: '-1001414451955',
    groupName: 'BncrJS',
    agentId: 'orion',
    lastSeenAt: NOW - 300 * DAY,
  });
  const fresh = groupRow({
    sceneKey: 'qq:2705342113',
    platform: 'qq',
    groupId: '0',
    agentId: 'public',
    lastSeenAt: NOW - 10 * DAY,
  });
  const { deps, deleted, registry } = buildDeps({
    rows: [old, older, fresh],
    sessions: {
      [`public|${buildStaleSceneSessionKey(old, 'public')}`]: NOW - 200 * DAY,
      [`orion|${buildStaleSceneSessionKey(older, 'orion')}`]: NOW - 310 * DAY,
      [`public|${buildStaleSceneSessionKey(fresh, 'public')}`]: NOW - 10 * DAY,
    },
  });
  const clearCalls = [];
  const result = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: false },
    ...deps,
    clearClientState: async (sceneKeys) => {
      clearCalls.push(sceneKeys);
      return { ok: true, cleared: sceneKeys.length };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(deleted.length, 2, 'only the two quiet rows are deleted');
  for (const entry of deleted) assert.equal(entry.archiveTranscript, true);
  assert.equal(clearCalls.length, 1, 'one RPC for the whole batch');
  assert.deepEqual(clearCalls[0].sort(), ['GewePlus:51720530884', 'tgBot:-1001414451955']);
  assert.equal(registry.size, 1, 'the fresh row survives');
  assert.match(result.text, /Deleted 2 scene row\(s\)/);
  assert.match(result.text, /Client state cleared: 2 key\(s\)/);
});

test('batch prune: an unreadable session is skipped unless force is set', async () => {
  const row = groupRow({ lastSeenAt: NOW - 400 * DAY });
  const { deps, deleted } = buildDeps({ rows: [row] });
  deps.readSessionNode = async () => undefined;
  deps.readSessionUpdatedAt = async () => undefined;

  const guarded = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: false },
    ...deps,
  });
  assert.equal(deleted.length, 0);
  assert.match(guarded.text, /skipped: session unreadable/);

  const forced = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: true },
    ...deps,
    clearClientState: async () => ({ ok: true, cleared: 0 }),
  });
  assert.equal(deleted.length, 1);
  assert.match(forced.text, /Deleted 1 scene row/);
  void row;
});

test('batch prune: a fresh unreadable row is not reported as skipped work', async () => {
  const row = groupRow({ lastSeenAt: NOW - 60 * 1000 });
  const { deps } = buildDeps({ rows: [row] });
  deps.readSessionNode = async () => undefined;
  deps.readSessionUpdatedAt = async () => undefined;

  const result = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: false },
    ...deps,
  });

  assert.equal(result.ok, true);
  assert.doesNotMatch(result.text, /session unreadable/);
});

test('batch prune: an unguarded unknown session is skipped without a host delete', async () => {
  const row = groupRow({ lastSeenAt: NOW - 400 * DAY });
  const { deps, registry, deleted } = buildDeps({ rows: [row] });
  deps.readSessionNode = async () => undefined;
  deps.readSessionUpdatedAt = async () => null;

  const result = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: false },
    ...deps,
  });

  assert.equal(result.ok, true);
  assert.match(result.text, /1 row\(s\) skipped: session unreadable/);
  assert.equal(deleted.length, 0);
  assert.equal(registry.size, 1);
});

test('batch prune: a conditional delete rejection keeps that scene row', async () => {
  const row = groupRow({ lastSeenAt: NOW - 400 * DAY });
  const { deps, registry } = buildDeps({ rows: [row] });
  deps.readSessionUpdatedAt = async () => NOW - 401 * DAY;
  deps.deleteSession = async () => false;

  const result = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: false },
    ...deps,
  });

  assert.equal(result.ok, true);
  assert.match(result.text, /Nothing pruned/);
  assert.match(result.text, /Skipped \(active again\)/);
  assert.equal(registry.size, 1);
});

test('batch prune: a delete failure is reported separately and keeps bridge state', async () => {
  const row = groupRow({ lastSeenAt: NOW - 400 * DAY });
  const { deps, registry } = buildDeps({ rows: [row] });
  let purges = 0;
  deps.readSessionUpdatedAt = async () => NOW - 401 * DAY;
  deps.deleteSession = async () => {
    throw new Error('store unavailable');
  };
  deps.purgeSessionState = async () => {
    purges += 1;
  };

  const result = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: false },
    ...deps,
  });

  assert.equal(result.ok, true);
  assert.match(result.text, /Skipped \(delete failed\)/);
  assert.doesNotMatch(result.text, /active again/);
  assert.equal(purges, 0);
  assert.equal(registry.size, 1);
});

test('batch prune: a scene another agent still uses keeps its client gate state', async () => {
  // 客户端 super gate 是场景级（state:<平台:群:用户>），没有 agent 维度。
  // 删掉 A 的行不能把 B 还在用的 mode/occ 一起清掉。
  const staleRow = groupRow({ lastSeenAt: NOW - 200 * DAY });
  const siblingRow = groupRow({
    agentId: 'orion',
    sceneKey: 'GewePlus:51720530884',
    lastSeenAt: NOW - 30 * 60 * 1000,
  });
  const calls = [];
  const { deps, registry } = buildDeps({
    rows: [staleRow, siblingRow],
    sessions: {
      [`public|${buildStaleSceneSessionKey(staleRow, 'public')}`]: NOW - 200 * DAY,
      [`orion|${buildStaleSceneSessionKey(siblingRow, 'orion')}`]: NOW - 30 * 60 * 1000,
    },
  });
  const result = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: false },
    ...deps,
    clearClientState: async (keys) => {
      calls.push(keys);
      return { ok: true, cleared: keys.length };
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Deleted 1 scene row\(s\)/);
  assert.deepEqual(calls, [], 'no RPC: the scene still has an agent row');
  assert.match(result.text, /Client state kept for 1 scene\(s\)/);
  assert.ok(registry.size > 0, 'the other agent row survives');
});

test('batch prune: clearing happens once the last agent row goes', async () => {
  const left = groupRow({ lastSeenAt: NOW - 200 * DAY });
  const right = groupRow({ agentId: 'orion', lastSeenAt: NOW - 210 * DAY });
  const calls = [];
  const { deps } = buildDeps({
    rows: [left, right],
    sessions: {
      [`public|${buildStaleSceneSessionKey(left, 'public')}`]: NOW - 200 * DAY,
      [`orion|${buildStaleSceneSessionKey(right, 'orion')}`]: NOW - 210 * DAY,
    },
  });
  const result = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: false },
    ...deps,
    clearClientState: async (keys) => {
      calls.push(keys);
      return { ok: true, cleared: keys.length };
    },
  });
  assert.deepEqual(calls, [['GewePlus:51720530884']]);
  assert.match(result.text, /Client state cleared: 1 key\(s\)/);
  assert.doesNotMatch(result.text, /Client state kept/);
});

test('prune: a single row on a shared scene leaves the client gate state alone', async () => {
  const target = groupRow({ lastSeenAt: NOW - 200 * DAY });
  const sibling = groupRow({ agentId: 'orion', lastSeenAt: NOW - 5 * 60 * 1000 });
  const calls = [];
  const { deps } = buildDeps({
    rows: [target, sibling],
    sessions: { [`public|${buildStaleSceneSessionKey(target, 'public')}`]: NOW - 200 * DAY },
  });
  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: 'GewePlus:51720530884', agentId: 'public', force: false },
    ...deps,
    clearClientState: async (keys) => {
      calls.push(keys);
      return { ok: true, cleared: keys.length };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, []);
  assert.match(
    result.text,
    /Client state kept for 1 scene\(s\) with another agent row still in use/,
  );
});

test('prune: the last row of a scene clears the client gate state', async () => {
  const target = groupRow({ lastSeenAt: NOW - 200 * DAY });
  const calls = [];
  const { deps } = buildDeps({
    rows: [target],
    sessions: { [`public|${buildStaleSceneSessionKey(target, 'public')}`]: NOW - 200 * DAY },
  });
  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: 'GewePlus:51720530884', force: false },
    ...deps,
    clearClientState: async (keys) => {
      calls.push(keys);
      return { ok: true, cleared: 3 };
    },
  });
  assert.deepEqual(calls, [['GewePlus:51720530884']]);
  assert.match(result.text, /Client state cleared: 3 key\(s\)/);
});

test('batch prune: an older client without the RPC is reported, not fatal', async () => {
  const row = groupRow({ lastSeenAt: NOW - 400 * DAY });
  const { deps } = buildDeps({
    rows: [row],
    sessions: { [`public|${buildStaleSceneSessionKey(row, 'public')}`]: NOW - 400 * DAY },
  });
  const result = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: false },
    ...deps,
    clearClientState: async () => ({ ok: false, unsupported: true }),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /too old to expose bncr.state.clear/);
});

test('list with a day window keeps the 72h default wording out of the header', async () => {
  const row = groupRow({ lastSeenAt: NOW - 200 * DAY });
  const { deps } = buildDeps({
    rows: [row],
    sessions: { [`public|${buildStaleSceneSessionKey(row, 'public')}`]: NOW - 200 * DAY },
  });
  const result = await executeStaleScenesCommand({
    command: { action: 'list', filter: 'all', days: 180, includeAnomalies: false },
    ...deps,
  });
  assert.match(result.text, /quiet 180d\+/);
  assert.doesNotMatch(result.text, /quiet 72h/);
  // The day views are clock only, and the header has to say so.
  assert.match(result.text, /clock only/);
  assert.doesNotMatch(result.text, /session missing\/archived/);
});

test('batch prune: an unknown RPC method on an old client reads as a version gap', async () => {
  const row = groupRow({ lastSeenAt: NOW - 400 * DAY });
  const { deps } = buildDeps({
    rows: [row],
    sessions: { [`public|${buildStaleSceneSessionKey(row, 'public')}`]: NOW - 400 * DAY },
  });
  const result = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: false },
    ...deps,
    clearClientState: async () => {
      throw new Error('bncr client RPC method not found: bncr.state.clear');
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /too old to expose bncr.state.clear/);
  assert.match(result.text, /Deleted 1 scene row\(s\)/);
});

test('batch prune: an archived session on a chat still in use is not swept', async () => {
  // The single prune treats the anomaly as a candidate on its own; the sweep
  // must not, or an operator who archived a session yesterday and kept talking
  // would lose the scene row.
  const row = groupRow({ lastSeenAt: NOW - 2 * DAY });
  const { deps, deleted } = buildDeps({
    rows: [row],
    nodes: {
      [`public|${buildStaleSceneSessionKey(row, 'public')}`]: {
        exists: true,
        archivedAt: NOW - DAY,
        updatedAt: NOW - DAY,
      },
    },
  });
  const result = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: false },
    ...deps,
  });
  assert.equal(deleted.length, 0);
  assert.match(result.text, /No scene row is quiet 180d\+/);
});

test('prune persists the registry once, even when the purge step throws', async () => {
  const rows = [
    groupRow({ lastSeenAt: NOW - 400 * DAY }),
    groupRow({
      sceneKey: 'tgBot:-1001414451955',
      platform: 'tgBot',
      groupId: '-1001414451955',
      groupName: 'BncrJS',
      agentId: 'orion',
      lastSeenAt: NOW - 500 * DAY,
    }),
  ];
  const { deps } = buildDeps({
    rows,
    sessions: {
      [`public|${buildStaleSceneSessionKey(rows[0], 'public')}`]: NOW - 400 * DAY,
      [`orion|${buildStaleSceneSessionKey(rows[1], 'orion')}`]: NOW - 500 * DAY,
    },
  });
  let saves = 0;
  const result = await executeStaleScenesCommand({
    command: { action: 'prune-batch', days: 180, force: false },
    ...deps,
    purgeSessionState: () => {
      throw new Error('purge exploded');
    },
    onSceneChange: () => {
      saves += 1;
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Deleted 2 scene row\(s\)/);
  assert.equal(saves, 1, 'one save per sweep, not one per row');

  let singleSaves = 0;
  const single = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: 'GewePlus:51720530884', force: true },
    ...buildDeps({ rows: [groupRow({ lastSeenAt: NOW - 400 * DAY })] }).deps,
    purgeSessionState: () => {
      throw new Error('purge exploded');
    },
    onSceneChange: () => {
      singleSaves += 1;
    },
  });
  assert.equal(single.ok, true);
  assert.equal(singleSaves, 1);
});

test('parse: /bncr stale orphans is its own view, not a row filter', () => {
  assert.deepEqual(parseStaleScenesCommand(command('stale', 'orphans')), {
    matched: true,
    valid: true,
    command: { action: 'orphans' },
  });
  // 过滤器列表不受影响：orphans 比对的是客户端表，不是场景行。
  assert.equal(STALE_SCENES_FILTERS.includes('orphans'), false);
  assert.match(STALE_SCENES_HELP_TEXT, /\/bncr stale orphans/);
});

test('orphans: lists client gate rows whose scene row is gone, and nothing else', async () => {
  const { deps, registry, deleted, purged } = buildDeps({
    rows: [groupRow({ lastSeenAt: NOW - DAY })],
  });
  const before = registry.size;
  const result = await executeStaleScenesCommand({
    command: { action: 'orphans' },
    ...deps,
    listClientState: async () => ({
      ok: true,
      entries: [
        {
          sceneKey: 'GewePlus:51720530884',
          scope: 'group-scope',
          enabled: true,
          mode: 'admin',
          rev: NOW - 2 * DAY,
        },
        {
          sceneKey: 'qq:2705342113',
          scope: 'direct-scope',
          enabled: true,
          mode: 'all',
          rev: NOW - 3 * DAY,
        },
        { sceneKey: '__media', scope: 'internal', enabled: true, mode: 'all', rev: NOW },
      ],
      invalid: 2,
    }),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Orphan client state — client has, scene table has none/);
  assert.match(result.text, /1 of 3 state entries/);
  assert.match(result.text, /2 unreadable state key\(s\) skipped\./);
  // 有场景行的那个不算孤儿，内部配置行也不算。
  assert.equal(result.text.includes('GewePlus:51720530884'), false);
  assert.equal(result.text.includes('__media'), false);
  assert.match(result.text, /qq:2705342113/);
  assert.match(result.text, /gate on · opened .* \(\d+d\) · mode all/);
  // 只读：不删会话、不删行、不动场景表。
  assert.deepEqual(deleted, []);
  assert.deepEqual(purged, []);
  assert.equal(registry.size, before);
});

test('orphans: platform case differences never fake an orphan', async () => {
  const { deps } = buildDeps({ rows: [groupRow({ lastSeenAt: NOW - DAY })] });
  const result = await executeStaleScenesCommand({
    command: { action: 'orphans' },
    ...deps,
    listClientState: async () => ({
      ok: true,
      entries: [{ sceneKey: 'geweplus:51720530884', enabled: false, rev: 0 }],
    }),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /None: every client scene gate state has a scene row/);
});

test('orphans: an empty client table says so instead of inventing rows', async () => {
  const { deps } = buildDeps({ rows: [groupRow()] });
  const result = await executeStaleScenesCommand({
    command: { action: 'orphans' },
    ...deps,
    listClientState: async () => ({ ok: true, entries: [] }),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /None: the client holds no scene gate state at all./);
});

test('orphans: an old client or a failed read is reported, not swallowed', async () => {
  const { deps } = buildDeps({ rows: [] });
  const tooOld = await executeStaleScenesCommand({
    command: { action: 'orphans' },
    ...deps,
    listClientState: async () => {
      throw new Error('bncr client RPC failed: method not found');
    },
  });
  assert.equal(tooOld.ok, false);
  assert.match(tooOld.text, /too old to expose bncr.state.list/);

  const unsupported = await executeStaleScenesCommand({
    command: { action: 'orphans' },
    ...deps,
    listClientState: async () => ({ ok: false, unsupported: true }),
  });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.text, /too old to expose bncr.state.list/);

  const noRpc = await executeStaleScenesCommand({ command: { action: 'orphans' }, ...deps });
  assert.equal(noRpc.ok, false);
  assert.match(noRpc.text, /No Bncr client RPC available/);

  const failed = await executeStaleScenesCommand({
    command: { action: 'orphans' },
    ...deps,
    listClientState: async () => ({ ok: false, error: 'store locked' }),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.text, /Client gate read failed: store locked/);
});

test('client RPC envelope:只认 { result } 这一层，其余形状当空结果', () => {
  assert.deepEqual(unwrapClientRpcResult({ result: { ok: true, entries: [] } }), {
    ok: true,
    entries: [],
  });
  assert.deepEqual(unwrapClientRpcResult({ result: null }), {});
  assert.deepEqual(unwrapClientRpcResult({ result: 'nope' }), {});
  assert.deepEqual(unwrapClientRpcResult(null), {});
  assert.deepEqual(unwrapClientRpcResult(undefined), {});
});

test('client RPC envelope:bncr.state.list 的结果收敛成维护视图读的形状', () => {
  const list = normalizeClientSceneStateList({
    ok: true,
    invalid: 2,
    entries: [
      { sceneKey: '  GewePlus:123  ', scope: 'aa', enabled: true, mode: 'admin', rev: 170 },
      // 空场景键、非对象条目直接丢掉，不能让下游拿 undefined 去比场景表
      { sceneKey: '   ', enabled: true },
      { sceneKey: 'qq:9', enabled: 'yes', mode: 5, rev: '170' },
      null,
      'nope',
    ],
  });
  assert.equal(list.ok, true);
  assert.equal(list.invalid, 2);
  assert.deepEqual(
    list.entries.map((entry) => entry.sceneKey),
    ['GewePlus:123', 'qq:9'],
  );
  assert.equal(list.entries[0].mode, 'admin');
  assert.equal(list.entries[0].rev, 170);
  // 类型不对的字段不硬转：enabled 只有 true 才算开，mode/rev 非字符串非数字就不带
  assert.equal(list.entries[1].enabled, false);
  assert.equal('mode' in list.entries[1], false);
  assert.equal('rev' in list.entries[1], false);
  // ok:false / unsupported / error 照传，让命令层给出对应文案
  const failed = normalizeClientSceneStateList({ ok: false, error: 'boom' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'boom');
  assert.deepEqual(failed.entries, []);
  assert.equal(normalizeClientSceneStateList({ unsupported: true }).unsupported, true);
});

test('parse: /bncr prune state takes a bare SceneId and an optional force', () => {
  assert.deepEqual(parseStaleScenesCommand(command('prune', 'state HumanTG:8561283152')), {
    matched: true,
    valid: true,
    command: { action: 'prune-state', sceneKey: 'HumanTG:8561283152', force: false },
  });
  assert.deepEqual(parseStaleScenesCommand(command('prune', 'state HumanTG:8561283152 force')), {
    matched: true,
    valid: true,
    command: { action: 'prune-state', sceneKey: 'HumanTG:8561283152', force: true },
  });
  // 客户端门控是场景级：带 agent 会连坐兄弟 agent，按用法错误处理
  assert.equal(
    parseStaleScenesCommand(command('prune', 'state HumanTG:8561283152 public')).valid,
    false,
  );
  assert.equal(parseStaleScenesCommand(command('prune', 'state')).valid, false);
});

function orphanDeps(args = {}) {
  const built = buildDeps({ rows: args.rows ?? [] });
  const cleared = [];
  built.deps.listClientState = async () => {
    if (args.onList) args.onList(built.registry);
    return (
      args.listed ?? {
        ok: true,
        entries: [
          { sceneKey: 'HumanTG:8561283152', enabled: true, mode: 'admin', rev: NOW - 3 * DAY },
        ],
      }
    );
  };
  built.deps.clearClientState = async (sceneKeys) => {
    cleared.push(...sceneKeys);
    if (args.onClear) args.onClear(built.registry);
    return args.clearResult ?? { ok: true, cleared: sceneKeys.length };
  };
  return { ...built, cleared };
}

const runPruneState = (deps, spec) =>
  executeStaleScenesCommand({ command: { action: 'prune-state', ...spec }, ...deps });

test('execute: prune state clears only the client gate for an orphan scene', async () => {
  const { deps, cleared, deleted, purged, registry } = orphanDeps();
  const result = await runPruneState(deps, { sceneKey: 'HumanTG:8561283152', force: false });
  assert.equal(result.ok, true);
  assert.match(result.text, /Cleared 1 client gate key/);
  assert.deepEqual(cleared, ['HumanTG:8561283152']);
  assert.deepEqual(deleted, []);
  assert.deepEqual(purged, []);
  assert.equal(registry.size, 0);
});

test('execute: prune state refuses while the scene table still has a row', async () => {
  const { deps, cleared } = orphanDeps({ rows: [groupRow({ sceneKey: 'HumanTG:8561283152' })] });
  const result = await runPruneState(deps, { sceneKey: 'HumanTG:8561283152', force: false });
  assert.equal(result.ok, false);
  assert.match(result.text, /Scene table still has 1 row/);
  assert.match(result.text, /\/bncr prune HumanTG:8561283152/);
  assert.deepEqual(cleared, []);
});

test('execute: a gate opened inside 72h needs force, and force clears it', async () => {
  const fresh = {
    ok: true,
    entries: [{ sceneKey: 'HumanTG:8561283152', enabled: true, mode: 'admin', rev: NOW - DAY }],
  };
  const refused = orphanDeps({ listed: fresh });
  const blocked = await runPruneState(refused.deps, {
    sceneKey: 'HumanTG:8561283152',
    force: false,
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.text, /needs force/);
  assert.deepEqual(refused.cleared, []);

  const forced = orphanDeps({ listed: fresh });
  const clearedResult = await runPruneState(forced.deps, {
    sceneKey: 'HumanTG:8561283152',
    force: true,
  });
  assert.equal(clearedResult.ok, true);
  assert.deepEqual(forced.cleared, ['HumanTG:8561283152']);
});

test('execute: prune state reports a missing entry, a race, and an old client', async () => {
  const missing = orphanDeps({ listed: { ok: true, entries: [] } });
  const missingResult = await runPruneState(missing.deps, {
    sceneKey: 'HumanTG:8561283152',
    force: true,
  });
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.text, /No client gate state/);

  // 读门控时场景行被建出来：不是孤儿，什么都不清
  const raced = orphanDeps({
    onList: (registry) => setSceneRecord(registry, groupRow({ sceneKey: 'HumanTG:8561283152' })),
  });
  const racedResult = await runPruneState(raced.deps, {
    sceneKey: 'HumanTG:8561283152',
    force: true,
  });
  assert.equal(racedResult.ok, false);
  assert.match(racedResult.text, /A scene row appeared/);
  assert.deepEqual(raced.cleared, []);

  const old = orphanDeps({ listed: { unsupported: true } });
  const oldResult = await runPruneState(old.deps, {
    sceneKey: 'HumanTG:8561283152',
    force: true,
  });
  assert.equal(oldResult.ok, false);
  assert.match(oldResult.text, /too old/);
});
