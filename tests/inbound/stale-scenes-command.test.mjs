import assert from 'node:assert/strict';
import test from 'node:test';
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
  return { command: name, raw: '/bncr ' + name, body: '/bncr ' + name, argsText };
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
      return sessions.get(agentId + '|' + sessionKey) ?? null;
    },
    deleteSession: async ({ agentId, sessionKey, archiveTranscript }) => {
      deleted.push({ agentId, sessionKey, archiveTranscript });
      return true;
    },
    purgeSessionState: async ({ sceneKey, agentId, sessionKey }) => {
      purged.push({ sceneKey, agentId, sessionKey });
    },
  };
  // Only wire the reverse-lookup path when a test opts in, so the legacy
  // timestamp-only cases keep exercising the readSessionUpdatedAt fallback.
  if (args.nodes) {
    deps.readSessionNode = async ({ agentId, sessionKey }) => nodes.get(agentId + '|' + sessionKey);
  }
  return { deps, registry, deleted, purged, reads };
}

test('parse: /bncr stale lists, help is recognised, extra args are a usage error', () => {
  assert.deepEqual(parseStaleScenesCommand(command('stale')), {
    matched: true,
    valid: true,
    command: { action: 'list', filter: 'all' },
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
    assert.deepEqual(parseStaleScenesCommand(command('stale', filter)), {
      matched: true,
      valid: true,
      command: { action: 'list', filter },
    });
  }
});

test('help and usage take their filter list from the same source as parse', () => {
  const bracketed = '[' + STALE_SCENES_FILTERS.join('|') + ']';
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
      ['public|' + buildStaleSceneSessionKey(stale, 'public')]: NOW - 94 * DAY,
      ['public|' + buildStaleSceneSessionKey(active, 'public')]: NOW - 60 * 1000,
      ['orion|' + buildStaleSceneSessionKey(sessionAlive, 'orion')]: NOW - 11 * 60 * 60 * 1000,
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
    sessions: { ['public|' + buildStaleSceneSessionKey(row, 'public')]: NOW - 94 * DAY },
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

test('prune: refuses an active scene unless force is given', async () => {
  const row = groupRow({ lastSeenAt: NOW - 60 * 1000 });
  const { deps, registry, deleted } = buildDeps({
    rows: [row],
    sessions: { ['public|' + buildStaleSceneSessionKey(row, 'public')]: NOW - 60 * 1000 },
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

test('prune: a failing session delete still removes the row', async () => {
  const row = groupRow();
  const registry = new Map();
  setSceneRecord(registry, row);
  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, force: false },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionUpdatedAt: async () => NOW - 94 * DAY,
    deleteSession: async () => {
      throw new Error('store missing');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(registry.size, 0);
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
      ['public|' + buildStaleSceneSessionKey(deadWithSibling, 'public')]: NOW - 94 * DAY,
      ['public|' + buildStaleSceneSessionKey(sibling, 'public')]: NOW - 16 * 60 * 60 * 1000,
      ['public|' + buildStaleSceneSessionKey(deadAlone, 'public')]: NOW - 83 * DAY,
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
      ['public|' + buildStaleSceneSessionKey(dead, 'public')]: NOW - 94 * DAY,
      ['public|' + buildStaleSceneSessionKey(quietSibling, 'public')]: NOW - 17 * DAY,
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
      ['orion|' + buildStaleSceneSessionKey(row, 'orion')]: NOW - 73 * DAY,
      ['orion|' + buildStaleSceneSessionKey(otherPlatform, 'orion')]: NOW - 60 * 1000,
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
  const result = await executeStaleScenesCommand({
    command: { action: 'prune', sceneKey: row.sceneKey, force: false },
    sceneRegistry: registry,
    now: () => NOW,
    readSessionUpdatedAt: async () => null,
    deleteSession: async (args) => {
      deleted.push(args);
      return true;
    },
    purgeSessionState: async (args) => {
      purged.push(args);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(deleted.length, 0);
  assert.deepEqual(purged, [{ sceneKey: row.sceneKey, agentId: '', sessionKey: null }]);
  assert.equal(registry.size, 0);
});

test('list shows a per-row label when agents in one scene carry different names', async () => {
  const left = groupRow({ customName: '主群' });
  const right = groupRow({ agentId: 'orion', customName: '备份群' });
  const { deps } = buildDeps({
    rows: [left, right],
    sessions: {
      ['public|' + buildStaleSceneSessionKey(left, 'public')]: NOW - 94 * DAY,
      ['orion|' + buildStaleSceneSessionKey(right, 'orion')]: NOW - 94 * DAY,
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
    sessions: { ['public|' + buildStaleSceneSessionKey(groupRow(), 'public')]: NOW - 94 * DAY },
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

test('list caps a long listing and points at the filters', async () => {
  const rows = [];
  const sessions = {};
  for (let i = 0; i < 55; i += 1) {
    const row = groupRow({
      sceneKey: 'GewePlus:' + (50000000000 + i),
      groupId: String(50000000000 + i),
      groupName: 'chat-' + i,
    });
    rows.push(row);
    sessions['public|' + buildStaleSceneSessionKey(row, 'public')] = NOW - 94 * DAY;
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
      ['public|' + buildStaleSceneSessionKey(row, 'public')]: {
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

test('list: the archived filter surfaces a session archived from the UI', async () => {
  const row = groupRow({ lastSeenAt: NOW - 60 * 1000 });
  const archivedAt = NOW - 5 * DAY;
  const { deps } = buildDeps({
    rows: [row],
    nodes: {
      ['public|' + buildStaleSceneSessionKey(row, 'public')]: {
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
      ['public|' + buildStaleSceneSessionKey(row, 'public')]: {
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
  assert.equal(deleted.length, 1);
  assert.equal(registry.size, 0);
});

test('solo: session anomalies are not counted as a chat that simply went quiet', async () => {
  const quiet = groupRow({ sceneKey: 'GewePlus:60000000001', groupId: '60000000001' });
  const gone = groupRow({ sceneKey: 'GewePlus:60000000002', groupId: '60000000002' });
  const archived = groupRow({ sceneKey: 'GewePlus:60000000003', groupId: '60000000003' });
  const { deps } = buildDeps({
    rows: [quiet, gone, archived],
    sessions: {
      ['public|' + buildStaleSceneSessionKey(quiet, 'public')]: NOW - 94 * DAY,
      ['public|' + buildStaleSceneSessionKey(archived, 'public')]: NOW - 94 * DAY,
    },
    nodes: {
      ['public|' + buildStaleSceneSessionKey(quiet, 'public')]: {
        exists: true,
        archivedAt: null,
        updatedAt: NOW - 94 * DAY,
      },
      ['public|' + buildStaleSceneSessionKey(gone, 'public')]: {
        exists: false,
        archivedAt: null,
        updatedAt: null,
      },
      ['public|' + buildStaleSceneSessionKey(archived, 'public')]: {
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
    assert.match(all.text, new RegExp('GewePlus:' + key));
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
  const key = (row) => 'public|' + buildStaleSceneSessionKey(row, 'public');
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
  const key = 'public|' + buildStaleSceneSessionKey(row, 'public');
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
      ['public|' + buildStaleSceneSessionKey(unreadable, 'public')]: NOW - 3600 * 1000,
    },
    nodes: {
      ['public|' + buildStaleSceneSessionKey(dead, 'public')]: {
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
