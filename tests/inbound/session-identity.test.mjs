import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeSceneAdminCommand,
  parseSceneAdminCommand,
} from '../../src/messaging/inbound/scene-admin.ts';
import {
  BNCR_DIRECT_SESSION_CATEGORY,
  formatBncrSceneLabel,
  resolveBncrSceneIdentity,
  resolveBncrSessionCategory,
  sanitizeBncrDisplayName,
} from '../../src/messaging/inbound/session-identity.ts';
import {
  executeSessionIdentityCommand,
  parseSessionIdentityCommand,
} from '../../src/messaging/inbound/session-identity-command.ts';
import { buildBncrInboundSessionIdentityPatch } from '../../src/messaging/inbound/session-label.ts';
import {
  buildAgentSceneRegistryKey,
  decideSceneAdmission,
  setSceneRecord,
} from '../../src/plugin/scene-registry.ts';

function groupRow(overrides = {}) {
  return {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    groupName: '无界社区',
    lastSeenAt: 1,
    ...overrides,
  };
}

function directRow(overrides = {}) {
  return {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    userName: '阿伟',
    lastSeenAt: 1,
    ...overrides,
  };
}

function _gatewayApi(calls) {
  return {
    runtime: {
      gateway: {
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === 'sessions.groups.list') {
            return {
              groups: [{ name: 'Groups' }, { name: '私聊' }],
              sectionOrder: ['groups', 'category:私聊'],
            };
          }
          return { ok: true };
        },
      },
    },
  };
}

test('group labels read 平台 · 群名 · 群id and fall back to the id alone', () => {
  assert.equal(
    formatBncrSceneLabel({ platform: 'GewePlus', id: '46192290892', name: '无界社区' }),
    'GewePlus · 无界社区 · 46192290892',
  );
  assert.equal(
    formatBncrSceneLabel({ platform: 'GewePlus', id: '46192290892' }),
    'GewePlus · 46192290892',
  );
  assert.equal(
    formatBncrSceneLabel({ platform: 'tgBot', id: '-1001', name: '-1001' }),
    'tgBot · -1001',
  );
});

test('a custom name replaces the whole automatic label', () => {
  assert.equal(
    formatBncrSceneLabel({
      platform: 'tgBot',
      id: '-1001',
      name: '无界社区',
      customName: '项目群',
    }),
    'tgBot · 项目群',
  );
});

test('names are flattened: separators inside a name become dashes', () => {
  assert.equal(
    formatBncrSceneLabel({ platform: 'tgBot', id: '-1001', customName: '甲·乙' }),
    'tgBot · 甲-乙',
  );
  assert.equal(sanitizeBncrDisplayName('  多\n行\t名字  '), '多 行 名字');
  assert.equal(sanitizeBncrDisplayName('   '), null);
});

test('a platform carrying the separator cannot fake an extra label segment', () => {
  assert.equal(
    formatBncrSceneLabel({ platform: 'tg·Bot', id: '-1001', name: '无界社区' }),
    'tg-Bot · 无界社区 · -1001',
  );
});

test('over-long names are truncated inside the 32 character budget', () => {
  const long = '群'.repeat(40);
  const label = formatBncrSceneLabel({ platform: 'tgBot', id: '-1001', name: long });
  const [, name, id] = label.split(' · ');
  assert.equal(name.length, 32);
  assert.ok(name.endsWith('…'));
  assert.equal(id, '-1001');
});

test('scene identity is shared across agent rows, newest field wins', () => {
  const registry = new Map();
  setSceneRecord(registry, groupRow({ agentId: 'main', customName: '旧名字', lastSeenAt: 1 }));
  setSceneRecord(registry, groupRow({ agentId: 'orion', customName: '新名字', lastSeenAt: 5 }));

  assert.equal(resolveBncrSceneIdentity(registry, 'tgBot:-1001').customName, '新名字');

  const mixed = new Map();
  setSceneRecord(
    mixed,
    groupRow({ agentId: 'main', customName: '甲', category: 'Ops', lastSeenAt: 9 }),
  );
  setSceneRecord(mixed, groupRow({ agentId: 'orion', lastSeenAt: 3 }));
  assert.deepEqual(resolveBncrSceneIdentity(mixed, 'tgBot:-1001'), {
    customName: '甲',
    category: 'Ops',
  });
});

test('direct chats default to 私聊 and groups clear to the host default', () => {
  assert.equal(resolveBncrSessionCategory({ kind: 'direct' }), BNCR_DIRECT_SESSION_CATEGORY);
  assert.equal(
    resolveBncrSessionCategory({ kind: 'direct', identity: { category: '私人' } }),
    '私人',
  );
  assert.equal(resolveBncrSessionCategory({ kind: 'group' }), null);
  assert.equal(resolveBncrSessionCategory({ kind: 'group', identity: { category: 'Ops' } }), 'Ops');
});

test('the inbound patch carries the sidebar group next to the label', () => {
  const direct = buildBncrInboundSessionIdentityPatch({
    channelId: 'bncr',
    accountId: 'Primary',
    chatType: 'direct',
    displayTo: 'Bncr:tgBot:0:10001',
    senderId: '10001',
    category: resolveBncrSessionCategory({ kind: 'direct' }),
    scene: { platform: 'tgBot', id: '10001', name: '阿伟' },
  });
  assert.equal(direct.label, 'tgBot · 阿伟 · 10001');
  assert.equal(direct.category, BNCR_DIRECT_SESSION_CATEGORY);

  const clearedGroup = buildBncrInboundSessionIdentityPatch({
    channelId: 'bncr',
    accountId: 'Primary',
    chatType: 'group',
    displayTo: 'Bncr:tgBot:-1001:0',
    senderId: '9',
    category: resolveBncrSessionCategory({ kind: 'group' }),
    scene: { platform: 'tgBot', id: '-1001', name: '无界社区' },
  });
  // An empty string is what removes the group on the store side.
  assert.equal(clearedGroup.category, '');

  const without = buildBncrInboundSessionIdentityPatch({
    channelId: 'bncr',
    accountId: 'Primary',
    chatType: 'group',
    displayTo: 'Bncr:tgBot:-1001:0',
    senderId: '9',
    scene: { platform: 'tgBot', id: '-1001' },
  });
  assert.equal('category' in without, false);
});

test('name and group verbs parse into get/set/clear with an optional scene', () => {
  const parse = (argsText) => parseSessionIdentityCommand({ command: 'name', argsText });

  assert.deepEqual(parse('').command, { target: 'name', action: 'get' });
  assert.deepEqual(parse('tgBot:-1001').command, {
    target: 'name',
    action: 'get',
    sceneKey: 'tgBot:-1001',
  });
  assert.deepEqual(parse('set 项目群').command, {
    target: 'name',
    action: 'set',
    value: '项目群',
  });
  assert.deepEqual(parse('set 项目群 tgBot:-1001').command, {
    target: 'name',
    action: 'set',
    value: '项目群',
    sceneKey: 'tgBot:-1001',
  });
  assert.deepEqual(parse('clear tgBot:-1001').command, {
    target: 'name',
    action: 'clear',
    sceneKey: 'tgBot:-1001',
  });
  assert.equal(parse('help').command.action, 'help');
  assert.equal(parse('set').valid, false);
  assert.deepEqual(parseSessionIdentityCommand({ command: 'group', argsText: 'set Ops' }).command, {
    target: 'group',
    action: 'set',
    value: 'Ops',
  });
});

test('a free-text name with a colon is not mistaken for a scene id', () => {
  const parsed = parseSessionIdentityCommand({ command: 'name', argsText: 'set 项目:二期' });
  assert.deepEqual(parsed.command, { target: 'name', action: 'set', value: '项目:二期' });
});

test('name clear takes an optional agent id and a scene id in either order', () => {
  const parse = (argsText) => parseSessionIdentityCommand({ command: 'name', argsText });
  assert.deepEqual(parse('clear orion').command, {
    target: 'name',
    action: 'clear',
    agentId: 'orion',
  });
  assert.deepEqual(parse('clear orion tgBot:-1001').command, {
    target: 'name',
    action: 'clear',
    agentId: 'orion',
    sceneKey: 'tgBot:-1001',
  });
  assert.deepEqual(parse('clear tgBot:-1001 orion').command, {
    target: 'name',
    action: 'clear',
    agentId: 'orion',
    sceneKey: 'tgBot:-1001',
  });
  assert.equal(parse('clear orion main').valid, false);
});

test('private chat owners rename their own scene but cannot touch another one', () => {
  const registry = new Map();
  setSceneRecord(registry, directRow());
  setSceneRecord(registry, groupRow());
  const parsed = {
    platform: 'tgBot',
    userId: '10001',
    groupId: '0',
    isAdmin: false,
    peer: { kind: 'direct' },
  };

  const set = executeSessionIdentityCommand({
    parsed,
    command: { target: 'name', action: 'set', value: '我自己' },
    sceneRegistry: registry,
    now: () => 50,
  });
  assert.equal(set.ok, true);
  assert.equal(set.text, 'Name set: tgBot · 我自己 (custom)');
  assert.equal(
    registry.get(buildAgentSceneRegistryKey('tgBot:10001', undefined)).customName,
    '我自己',
  );

  const other = executeSessionIdentityCommand({
    parsed,
    command: { target: 'name', action: 'set', value: '越权', sceneKey: 'tgBot:-1001' },
    sceneRegistry: registry,
    now: () => 50,
  });
  assert.equal(other.ok, false);
  assert.equal(other.text, 'Admin permission required.');
});

test('clearing a direct chat group falls back to 私聊, clearing a name falls back to auto', () => {
  const registry = new Map();
  setSceneRecord(registry, directRow({ customName: '自定义', category: '私人' }));
  const parsed = {
    platform: 'tgBot',
    userId: '10001',
    groupId: '0',
    isAdmin: true,
    peer: { kind: 'direct' },
  };

  const groupClear = executeSessionIdentityCommand({
    parsed,
    command: { target: 'group', action: 'clear' },
    sceneRegistry: registry,
    now: () => 60,
  });
  assert.equal(groupClear.text, 'Group cleared: 私聊');

  const nameClear = executeSessionIdentityCommand({
    parsed,
    command: { target: 'name', action: 'clear' },
    sceneRegistry: registry,
    now: () => 60,
  });
  assert.equal(nameClear.text, 'Name cleared: tgBot · 阿伟 · 10001 (auto)');
});

test('group chat commands require an administrator', () => {
  const registry = new Map();
  setSceneRecord(registry, groupRow());
  const parsed = {
    platform: 'tgBot',
    userId: '9',
    groupId: '-1001',
    isAdmin: false,
    peer: { kind: 'group' },
  };

  const outcome = executeSessionIdentityCommand({
    parsed,
    command: { target: 'name', action: 'set', value: '改名' },
    sceneRegistry: registry,
    now: () => 70,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.text, 'Admin permission required.');
});

test('clearing a name clears every agent row of the same scene', () => {
  const registry = new Map();
  setSceneRecord(registry, groupRow({ agentId: 'main', customName: '甲', lastSeenAt: 10 }));
  setSceneRecord(registry, groupRow({ agentId: 'orion', customName: '甲', lastSeenAt: 5 }));

  const outcome = executeSessionIdentityCommand({
    parsed: {
      platform: 'tgBot',
      groupId: '-1001',
      userId: '9',
      isAdmin: true,
      peer: { kind: 'group' },
    },
    command: { target: 'name', action: 'clear' },
    sceneRegistry: registry,
    now: () => 30,
  });

  assert.equal(outcome.ok, true);
  assert.equal(resolveBncrSceneIdentity(registry, 'tgBot:-1001').customName, undefined);
  assert.equal(
    registry.get(buildAgentSceneRegistryKey('tgBot:-1001', 'main')).customName,
    undefined,
  );
  assert.equal(
    registry.get(buildAgentSceneRegistryKey('tgBot:-1001', 'orion')).customName,
    undefined,
  );
});

test('mode accepts an optional agent id and fans out when it is omitted', () => {
  const registry = new Map();
  setSceneRecord(registry, groupRow({ agentId: 'main', groupReplyMode: 'admin' }));
  setSceneRecord(registry, groupRow({ agentId: 'orion', groupReplyMode: 'admin' }));

  const parse = (argsText) => parseSceneAdminCommand({ command: 'mode', argsText });
  assert.deepEqual(parse('all').command, { kind: 'mode', mode: 'all' });
  assert.deepEqual(parse('all orion').command, { kind: 'mode', mode: 'all', agentId: 'orion' });
  assert.deepEqual(parse('all tgBot:-1001').command, {
    kind: 'mode',
    mode: 'all',
    sceneKey: 'tgBot:-1001',
  });
  assert.deepEqual(parse('mention orion tgBot:-1001').command, {
    kind: 'mode',
    mode: 'mention',
    agentId: 'orion',
    sceneKey: 'tgBot:-1001',
  });

  const run = (command) =>
    executeSceneAdminCommand({
      parsed: {
        platform: 'tgBot',
        groupId: '-1001',
        userId: '9',
        isAdmin: true,
        peer: { kind: 'group' },
      },
      command,
      sceneRegistry: registry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 80,
      agentId: 'main',
    });

  const all = run({ kind: 'mode', mode: 'all' });
  assert.equal(all.ok, true);
  assert.equal(
    registry.get(buildAgentSceneRegistryKey('tgBot:-1001', 'main')).groupReplyMode,
    'all',
  );
  assert.equal(
    registry.get(buildAgentSceneRegistryKey('tgBot:-1001', 'orion')).groupReplyMode,
    'all',
  );

  const single = run({ kind: 'mode', mode: 'mention', agentId: 'orion' });
  assert.equal(single.ok, true);
  assert.equal(
    registry.get(buildAgentSceneRegistryKey('tgBot:-1001', 'main')).groupReplyMode,
    'all',
  );
  assert.equal(
    registry.get(buildAgentSceneRegistryKey('tgBot:-1001', 'orion')).groupReplyMode,
    'mention',
  );

  const missing = run({ kind: 'mode', mode: 'all', agentId: 'ghost' });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /has no scene row/);
});

test('a second agent inherits the scene reply mode instead of defaulting to admin', () => {
  const registry = new Map();
  setSceneRecord(
    registry,
    groupRow({ agentId: 'main', groupReplyMode: 'all', customName: '项目群', category: 'Ops' }),
  );

  const decision = decideSceneAdmission({
    parsed: {
      platform: 'tgBot',
      groupId: '-1001',
      groupName: '无界社区',
      userId: '9',
      isAdmin: true,
      peer: { kind: 'group' },
    },
    now: 90,
    sceneRegistry: registry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'orion',
    sceneAgentId: 'orion',
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.agentId, 'orion');
  const orionRow = registry.get(buildAgentSceneRegistryKey('tgBot:-1001', 'orion'));
  assert.equal(orionRow?.agentId, 'orion');
  assert.equal(orionRow?.groupReplyMode, 'all');
  assert.equal(orionRow?.customName, '项目群');
  assert.equal(orionRow?.category, 'Ops');
});

test('a known agent id at the tail of name set is read as the target', () => {
  const parse = (argsText, ids) =>
    parseSessionIdentityCommand({ command: 'name', argsText }, { knownAgentIds: new Set(ids) });

  assert.deepEqual(parse('set Ops orion', ['orion']).command, {
    target: 'name',
    action: 'set',
    value: 'Ops',
    agentId: 'orion',
  });
  assert.deepEqual(parse('set Ops orion tgBot:-1001', ['orion']).command, {
    target: 'name',
    action: 'set',
    value: 'Ops',
    agentId: 'orion',
    sceneKey: 'tgBot:-1001',
  });
  // A two word ASCII name stays text when the tail is not a known agent.
  assert.deepEqual(parse('set Team A', ['orion']).command, {
    target: 'name',
    action: 'set',
    value: 'Team A',
  });
  assert.deepEqual(parse('set Ops', ['orion']).command, {
    target: 'name',
    action: 'set',
    value: 'Ops',
  });
});

test('name and group take an agent id and only touch that agent row', () => {
  const registry = new Map();
  setSceneRecord(registry, groupRow({ agentId: 'main', lastSeenAt: 1 }));
  setSceneRecord(registry, groupRow({ agentId: 'orion', lastSeenAt: 2 }));
  const run = (command) =>
    executeSessionIdentityCommand({
      parsed: {
        platform: 'tgBot',
        groupId: '-1001',
        userId: '9',
        isAdmin: true,
        peer: { kind: 'group' },
      },
      command,
      sceneRegistry: registry,
      sceneAgentId: 'main',
      now: () => 90,
    });
  const rowOf = (agentId) => registry.get(buildAgentSceneRegistryKey('tgBot:-1001', agentId));

  const set = run({ target: 'name', action: 'set', value: '项目群', agentId: 'orion' });
  assert.equal(set.ok, true);
  assert.equal(set.text, 'Name set: tgBot · 项目群 (custom) for orion');
  assert.equal(rowOf('orion').customName, '项目群');
  assert.equal(rowOf('main').customName, undefined);

  assert.equal(
    run({ target: 'name', action: 'get', agentId: 'orion' }).text,
    'Name for orion: tgBot · 项目群 (custom)',
  );
  assert.equal(
    run({ target: 'name', action: 'get', agentId: 'main' }).text,
    'Name for main: tgBot · 无界社区 · -1001 (auto)',
  );
  // Rows disagree, so the scene-wide read lists them instead of picking one.
  assert.equal(
    run({ target: 'name', action: 'get' }).text,
    'Name tgBot:-1001\n  main: tgBot · 无界社区 · -1001 (auto)\n  orion: tgBot · 项目群 (custom)',
  );

  const cleared = run({ target: 'name', action: 'clear', agentId: 'orion' });
  assert.equal(cleared.text, 'Name cleared: tgBot · 无界社区 · -1001 (auto) for orion');
  assert.equal(rowOf('orion').customName, undefined);

  const fanout = run({ target: 'group', action: 'set', value: 'Ops' });
  assert.equal(fanout.text, 'Group set: Ops for all 2 agents');
  assert.equal(rowOf('main').category, 'Ops');
  assert.equal(rowOf('orion').category, 'Ops');

  const ghost = run({ target: 'name', action: 'set', value: 'x', agentId: 'ghost' });
  assert.equal(ghost.ok, false);
  // One message for every command, identical to the scene admin wording.
  assert.equal(
    ghost.text,
    'Agent ghost has no scene row for tgBot:-1001. Agents here: main, orion.',
  );
});

test('a non admin cannot rename another agent row of the same scene', () => {
  const registry = new Map();
  setSceneRecord(registry, directRow({ agentId: 'main', lastSeenAt: 1 }));
  setSceneRecord(registry, directRow({ agentId: 'orion', lastSeenAt: 2 }));

  const outcome = executeSessionIdentityCommand({
    parsed: {
      platform: 'tgBot',
      userId: '10001',
      groupId: '0',
      isAdmin: false,
      peer: { kind: 'direct' },
    },
    command: { target: 'name', action: 'set', value: '越权', agentId: 'main' },
    sceneRegistry: registry,
    sceneAgentId: 'orion',
    now: () => 95,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.text, 'Admin permission required.');
});

test('history and media settings share the same agent and scene tail', () => {
  const registry = new Map();
  setSceneRecord(registry, groupRow({ agentId: 'main', lastSeenAt: 1 }));
  setSceneRecord(registry, groupRow({ agentId: 'orion', lastSeenAt: 2 }));
  const run = (command) =>
    executeSceneAdminCommand({
      parsed: {
        platform: 'tgBot',
        groupId: '-1001',
        userId: '9',
        isAdmin: true,
        peer: { kind: 'group' },
      },
      command,
      sceneRegistry: registry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 100,
      agentId: 'main',
    });
  const rowOf = (agentId) => registry.get(buildAgentSceneRegistryKey('tgBot:-1001', agentId));
  const parse = (command, argsText) => parseSceneAdminCommand({ command, argsText });

  assert.deepEqual(parse('history-limit', '80 orion').command, {
    kind: 'history-limit-set',
    sceneKey: '',
    limit: 80,
    agentId: 'orion',
  });
  assert.deepEqual(parse('history-limit', 'orion').command, {
    kind: 'history-limit-get',
    agentId: 'orion',
  });
  assert.deepEqual(parse('history-force', 'off tgBot:-1001 orion').command, {
    kind: 'history-force-set',
    sceneKey: 'tgBot:-1001',
    enabled: false,
    agentId: 'orion',
  });
  assert.deepEqual(parse('download-media', 'on orion').command, {
    kind: 'download-media-set',
    sceneKey: '',
    enabled: true,
    agentId: 'orion',
  });

  assert.equal(
    run({ kind: 'history-limit-set', sceneKey: '', limit: 80, agentId: 'orion' }).text,
    'Set tgBot:-1001 history limit to 80 for orion.',
  );
  assert.equal(rowOf('orion').historyLimit, 80);
  assert.equal(rowOf('main').historyLimit, undefined);

  assert.equal(
    run({ kind: 'history-force-set', sceneKey: '', enabled: false }).text,
    'Set tgBot:-1001 history auto flush to off for all 2 agents.',
  );
  assert.equal(rowOf('main').historyForce, false);
  assert.equal(rowOf('orion').historyForce, false);

  assert.equal(
    run({ kind: 'download-media-set', sceneKey: '', enabled: true }).text,
    'Set tgBot:-1001 download remote media to on for all 2 agents.',
  );
  assert.equal(rowOf('main').downloadMedia, true);
  assert.equal(rowOf('orion').downloadMedia, true);

  assert.equal(
    run({ kind: 'history-limit-get', agentId: 'orion' }).text,
    'Current tgBot:-1001 history limit for orion is 80.',
  );
});

test('an empty group or user name drops the middle segment of the label', () => {
  assert.equal(formatBncrSceneLabel({ platform: 'tgBot', id: '-1001', name: '' }), 'tgBot · -1001');
  assert.equal(
    formatBncrSceneLabel({ platform: 'tgBot', id: '-1001', name: '   ' }),
    'tgBot · -1001',
  );
  assert.equal(formatBncrSceneLabel({ platform: 'tgBot', id: '10001' }), 'tgBot · 10001');
  assert.equal(
    formatBncrSceneLabel({ platform: 'tgBot', id: '-1001', name: '无界社区' }),
    'tgBot · 无界社区 · -1001',
  );
  assert.equal(formatBncrSceneLabel({ platform: 'tgBot' }), 'tgBot');
});

test('invisible separators are stripped so two names cannot look identical', () => {
  assert.equal(sanitizeBncrDisplayName('项目\u200b群'), '项目群');
  assert.equal(sanitizeBncrDisplayName('\u2060项目\ufeff群\u00ad'), '项目群');
  // Zero-width joiner survives, otherwise emoji sequences fall apart.
  assert.equal(
    sanitizeBncrDisplayName('\ud83d\udc68\u200d\ud83d\udc69'),
    '\ud83d\udc68\u200d\ud83d\udc69',
  );
});
