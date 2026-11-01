import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCanonicalBncrSessionKey } from '../../src/core/targets.ts';
import {
  BNCR_SESSION_CLEANUP_DEFAULT_DAYS,
  BNCR_SESSION_CLEANUP_MAX_BATCH,
  executeSessionCleanupCommand,
  parseSessionCleanupCommand,
  SESSION_CLEANUP_HELP_TEXT,
} from '../../src/messaging/inbound/session-cleanup-command.ts';
import { setSceneRecord } from '../../src/plugin/scene-registry.ts';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function command(argsText = '') {
  return { command: 'sessions', raw: '/bncr sessions', body: '/bncr sessions', argsText };
}

function groupKey(agentId, groupId, platform = 'tgBot') {
  return buildCanonicalBncrSessionKey({ platform, groupId, userId: '0' }, agentId);
}

function directKey(agentId, userId, platform = 'qq') {
  return buildCanonicalBncrSessionKey({ platform, groupId: '0', userId }, agentId);
}

function sceneRow(overrides = {}) {
  return {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    groupName: 'wind_bncr',
    agentId: 'orion',
    lastSeenAt: NOW - 400 * DAY,
    ...overrides,
  };
}

function buildDeps(args = {}) {
  const registry = new Map();
  for (const row of args.rows ?? []) setSceneRecord(registry, row);
  const deleted = [];
  const stored = new Map();
  for (const entry of args.sessions ?? []) {
    const bucket = stored.get(entry.agentId) ?? [];
    bucket.push(entry);
    stored.set(entry.agentId, bucket);
  }
  const deps = {
    now: () => NOW,
    agentIds: args.agentIds ?? ['orion', 'public'],
    sceneRegistry: registry,
    listSessions: async (agentId) => {
      if ((args.unreadable ?? []).includes(agentId)) return undefined;
      return (stored.get(agentId) ?? []).map((entry) => ({
        sessionKey: entry.sessionKey,
        lastActivityAt: entry.lastActivityAt,
        ...(entry.hasInteractionAt === false ? { hasInteractionAt: false } : {}),
        archivedAt: entry.archivedAt ?? null,
      }));
    },
    deleteSession: async ({ agentId, sessionKey, archiveTranscript }) => {
      deleted.push({ agentId, sessionKey, archiveTranscript });
      return true;
    },
  };
  if (args.readSession) deps.readSession = args.readSession;
  return { deps, registry, deleted };
}

test('parse: default window, explicit days, prune and help', () => {
  assert.deepEqual(parseSessionCleanupCommand(command('')), {
    matched: true,
    valid: true,
    command: { action: 'list', days: BNCR_SESSION_CLEANUP_DEFAULT_DAYS },
  });
  assert.deepEqual(parseSessionCleanupCommand(command('180')), {
    matched: true,
    valid: true,
    command: { action: 'list', days: 180 },
  });
  assert.deepEqual(parseSessionCleanupCommand(command('prune 45')), {
    matched: true,
    valid: true,
    command: { action: 'prune', days: 45 },
  });
  assert.deepEqual(parseSessionCleanupCommand(command('prune')), {
    matched: true,
    valid: true,
    command: { action: 'prune', days: BNCR_SESSION_CLEANUP_DEFAULT_DAYS },
  });
  assert.deepEqual(parseSessionCleanupCommand(command('help')), {
    matched: true,
    valid: true,
    command: { action: 'help' },
  });
});

test('parse: bad arguments are a usage error, other commands stay untouched', () => {
  for (const bad of ['0', 'abc', '-5', '30 60', 'prune 0', 'prune abc', 'prune 30 extra']) {
    const parsed = parseSessionCleanupCommand(command(bad));
    assert.equal(parsed.matched, true, bad);
    assert.equal(parsed.valid, false, bad);
  }
  assert.deepEqual(parseSessionCleanupCommand({ command: 'stale', argsText: '' }), {
    matched: false,
  });
});

test('execute: lists only bncr sessions quiet for the window, oldest first', async () => {
  const { deps } = buildDeps({
    rows: [sceneRow()],
    sessions: [
      { agentId: 'orion', sessionKey: groupKey('orion', '-1001'), lastActivityAt: NOW - 121 * DAY },
      { agentId: 'orion', sessionKey: groupKey('orion', '-2002'), lastActivityAt: NOW - 40 * DAY },
      { agentId: 'orion', sessionKey: groupKey('orion', '-3003'), lastActivityAt: NOW - 2 * DAY },
      // Not a bncr chat key: must never appear, never be deleted.
      {
        agentId: 'orion',
        sessionKey: 'agent:orion:telegram:dm:42',
        lastActivityAt: NOW - 300 * DAY,
      },
    ],
  });
  const result = await executeSessionCleanupCommand({
    command: { action: 'list', days: 30 },
    ...deps,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /3 bncr session\(s\), 2 quiet 30d\+/);
  assert.match(result.text, /121d/);
  assert.match(result.text, /40d/);
  assert.doesNotMatch(result.text, /2d\b/);
  assert.doesNotMatch(result.text, /telegram/);
  // Scene row exists for -1001, the other group has none.
  assert.match(result.text, /scene=kept/);
  assert.match(result.text, /scene=missing \(orphan\)/);
  // Oldest band comes first.
  assert.ok(result.text.indexOf('121d') < result.text.indexOf('40d'));
});

test('execute: a missing scene row still shows a readable label from the key', async () => {
  const { deps } = buildDeps({
    sessions: [
      { agentId: 'orion', sessionKey: groupKey('orion', '-1001'), lastActivityAt: NOW - 63 * DAY },
    ],
  });
  const result = await executeSessionCleanupCommand({
    command: { action: 'list', days: 30 },
    ...deps,
  });
  assert.match(result.text, /tgBot:-1001 \(no label\)/);
  assert.match(result.text, /orphan/);
});

test('execute: an unreadable store is reported, not treated as empty', async () => {
  const { deps } = buildDeps({
    unreadable: ['orion'],
    sessions: [
      { agentId: 'public', sessionKey: groupKey('public', '-9'), lastActivityAt: NOW - 99 * DAY },
    ],
  });
  const result = await executeSessionCleanupCommand({
    command: { action: 'list', days: 30 },
    ...deps,
  });
  assert.match(result.text, /unreadable for orion/);
  assert.match(result.text, /99d/);
});

test('execute: prune deletes only the quiet batch and archives transcripts', async () => {
  const { deps, deleted } = buildDeps({
    sessions: [
      { agentId: 'orion', sessionKey: groupKey('orion', '-1001'), lastActivityAt: NOW - 121 * DAY },
      { agentId: 'orion', sessionKey: groupKey('orion', '-2002'), lastActivityAt: NOW - 40 * DAY },
      { agentId: 'orion', sessionKey: groupKey('orion', '-3003'), lastActivityAt: NOW - 2 * DAY },
    ],
  });
  const result = await executeSessionCleanupCommand({
    command: { action: 'prune', days: 30 },
    ...deps,
  });
  assert.equal(result.ok, true);
  assert.equal(deleted.length, 2);
  for (const entry of deleted) assert.equal(entry.archiveTranscript, true);
  assert.match(result.text, /Deleted 2 session\(s\)/);
  assert.match(result.text, /Scene rows kept/);
});

test('execute: prune re-reads the entry and skips one that woke up', async () => {
  const { deps, deleted } = buildDeps({
    sessions: [
      { agentId: 'orion', sessionKey: groupKey('orion', '-1001'), lastActivityAt: NOW - 121 * DAY },
      { agentId: 'orion', sessionKey: groupKey('orion', '-2002'), lastActivityAt: NOW - 90 * DAY },
    ],
    readSession: async ({ sessionKey }) => {
      // The second chat got a message between listing and delete.
      const fresh = sessionKey.endsWith(groupKey('orion', '-2002').split(':').pop());
      return {
        sessionKey,
        lastActivityAt: fresh ? NOW - 5 * 60 * 1000 : NOW - 121 * DAY,
        archivedAt: null,
      };
    },
  });
  const result = await executeSessionCleanupCommand({
    command: { action: 'prune', days: 30 },
    ...deps,
  });
  assert.equal(deleted.length, 1);
  assert.match(result.text, /skipped/);
});

test('execute: batch is capped and the remainder is announced', async () => {
  const sessions = [];
  for (let index = 0; index < BNCR_SESSION_CLEANUP_MAX_BATCH + 3; index += 1) {
    sessions.push({
      agentId: 'orion',
      sessionKey: groupKey('orion', String(-1000 - index)),
      lastActivityAt: NOW - (60 + index) * DAY,
    });
  }
  const { deps, deleted } = buildDeps({ sessions });
  const result = await executeSessionCleanupCommand({
    command: { action: 'prune', days: 30 },
    ...deps,
  });
  assert.equal(deleted.length, BNCR_SESSION_CLEANUP_MAX_BATCH);
  assert.match(result.text, /run it again/);
});

test('help text names the defaults and the delete semantics', () => {
  assert.match(SESSION_CLEANUP_HELP_TEXT, /聊天记录归档到磁盘/);
  assert.match(SESSION_CLEANUP_HELP_TEXT, new RegExp(String(BNCR_SESSION_CLEANUP_DEFAULT_DAYS)));
  assert.match(SESSION_CLEANUP_HELP_TEXT, /仅管理员可用/);
});

test('execute: task-scoped sessions are swept with their chat key intact', async () => {
  const base = groupKey('orion', '-1001');
  const taskKey = base + ':task:research';
  const { deps, deleted } = buildDeps({
    sessions: [{ agentId: 'orion', sessionKey: taskKey, lastActivityAt: NOW - 88 * DAY }],
  });
  const listed = await executeSessionCleanupCommand({
    command: { action: 'list', days: 30 },
    ...deps,
  });
  assert.match(listed.text, /task=research/);
  assert.match(listed.text, /88d/);

  const pruned = await executeSessionCleanupCommand({
    command: { action: 'prune', days: 30 },
    ...deps,
  });
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].sessionKey, taskKey);
  assert.match(pruned.text, /Deleted 1 session\(s\)/);
});

test('execute: an empty store says there is nothing to clean up', async () => {
  const { deps } = buildDeps({ sessions: [] });
  const result = await executeSessionCleanupCommand({
    command: { action: 'list', days: 30 },
    ...deps,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /0 bncr session\(s\), 0 quiet 30d\+/);
  assert.match(result.text, /Nothing to clean up\./);
});

test('execute: an unreadable store everywhere fails loudly instead of claiming zero', async () => {
  const { deps } = buildDeps({ agentIds: ['orion', 'public'], unreadable: ['orion', 'public'] });
  const result = await executeSessionCleanupCommand({
    command: { action: 'list', days: 30 },
    ...deps,
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /Cannot list sessions/);
});

test('execute: an old session under another agent marks the chat as still active', async () => {
  // The binding moved from orion to public: orion's conversation is dead, the
  // group is not. The listing has to say so instead of reading as "quiet 121d".
  const sceneKey = 'GewePlus:56041113886';
  const { deps } = buildDeps({
    rows: [
      sceneRow({
        sceneKey,
        platform: 'GewePlus',
        groupId: '56041113886',
        groupName: '四季发财',
        agentId: 'public',
        lastSeenAt: NOW - 60 * 1000,
      }),
    ],
    sessions: [
      {
        agentId: 'orion',
        sessionKey: groupKey('orion', '56041113886', 'GewePlus'),
        lastActivityAt: NOW - 121 * DAY,
        hasInteractionAt: false,
      },
      {
        agentId: 'public',
        sessionKey: groupKey('public', '56041113886', 'GewePlus'),
        lastActivityAt: NOW - 5 * 60 * 1000,
      },
    ],
  });
  const result = await executeSessionCleanupCommand({
    command: { action: 'list', days: 30 },
    ...deps,
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /GewePlus · 四季发财 · 56041113886/);
  assert.match(result.text, /agent=orion/);
  assert.match(result.text, /\(store write, no message\)/);
  assert.match(result.text, /other=public 0d \(active chat\)/);
  // The live public session is not a cleanup candidate.
  assert.doesNotMatch(result.text, /agent=public/);
});
