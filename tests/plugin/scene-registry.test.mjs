import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentSceneRegistryKey,
  decideSceneAdmission,
  resolveEffectiveSceneStatus,
  resolveSceneAgentId,
  resolveSceneRecord,
  setSceneRecord,
} from '../../src/plugin/scene-registry.ts';

const ADMIN_AGENT = 'main';
const PUBLIC_AGENT = 'public';

test('resolveSceneRecord never resolves another agent scene row', () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    agentId: 'agentB',
    lastSeenAt: 1,
  });

  assert.equal(resolveSceneRecord(sceneRegistry, 'tgBot:-1001', 'agentA'), undefined);
  assert.equal(resolveSceneRecord(sceneRegistry, 'tgBot:-1001', 'agentB')?.agentId, 'agentB');
});

test('group admission ignores another agent approval instead of borrowing it', () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    agentId: 'agentB',
    historyLimit: 77,
    lastSeenAt: 1,
  });

  const decision = decideSceneAdmission({
    parsed: {
      isAdmin: false,
      peer: { kind: 'group' },
      platform: 'tgBot',
      groupId: '-1001',
      userId: '9',
    },
    now: 99,
    sceneRegistry,
    defaultAdminAgentId: ADMIN_AGENT,
    defaultPublicAgentId: PUBLIC_AGENT,
    sceneAgentId: 'agentA',
  });

  assert.equal(decision.allowed, false);
  const ownerRow = sceneRegistry.get(buildAgentSceneRegistryKey('tgBot:-1001', 'agentB'));
  assert.equal(ownerRow?.status, 'allowed');
  assert.equal(ownerRow?.historyLimit, 77);
  assert.equal(ownerRow?.lastSeenAt, 1);
  assert.equal(ownerRow?.userId, undefined);
});

test('direct admission by another agent does not delete the owning agent row', () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    agentId: ADMIN_AGENT,
    approvedAt: 5,
    lastSeenAt: 1,
  });

  const decision = decideSceneAdmission({
    parsed: {
      isAdmin: false,
      peer: { kind: 'direct' },
      platform: 'tgBot',
      userId: '10001',
      groupId: '0',
    },
    now: 99,
    sceneRegistry,
    defaultAdminAgentId: ADMIN_AGENT,
    defaultPublicAgentId: PUBLIC_AGENT,
    sceneAgentId: PUBLIC_AGENT,
  });

  assert.equal(decision.allowed, false);
  const adminRow = sceneRegistry.get(buildAgentSceneRegistryKey('tgBot:10001', ADMIN_AGENT));
  assert.equal(adminRow?.status, 'allowed');
  assert.equal(adminRow?.approvedAt, 5);
  assert.equal(sceneRegistry.has(buildAgentSceneRegistryKey('tgBot:10001', PUBLIC_AGENT)), false);
});

test('resolveSceneAgentId keeps the row owner unless the route agent owns a row', () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    agentId: 'agentB',
    lastSeenAt: 1,
  });

  assert.equal(resolveSceneAgentId(sceneRegistry, 'tgBot:-1001', 'agentA'), 'agentB');
  assert.equal(resolveSceneAgentId(sceneRegistry, 'tgBot:-1001', 'agentB'), 'agentB');
  assert.equal(resolveSceneAgentId(sceneRegistry, 'tgBot:-2002', 'agentA'), 'agentA');
});

test('two agents serving the same group keep independent rows', () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    agentId: 'agentA',
    groupReplyMode: 'admin',
    historyLimit: 30,
    lastSeenAt: 1,
  });
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    agentId: 'agentB',
    groupReplyMode: 'all',
    historyLimit: 80,
    lastSeenAt: 2,
  });

  const parsed = {
    isAdmin: false,
    peer: { kind: 'group' },
    platform: 'tgBot',
    groupId: '-1001',
    userId: '9',
  };
  const decideFor = (agentId) =>
    decideSceneAdmission({
      parsed,
      now: 99,
      sceneRegistry,
      defaultAdminAgentId: ADMIN_AGENT,
      defaultPublicAgentId: PUBLIC_AGENT,
      sceneAgentId: resolveSceneAgentId(sceneRegistry, 'tgBot:-1001', agentId),
    });

  const forA = decideFor('agentA');
  const forB = decideFor('agentB');
  assert.equal(forA.allowed, true);
  assert.equal(forA.scene.groupReplyMode, 'admin');
  assert.equal(forB.allowed, true);
  assert.equal(forB.scene.groupReplyMode, 'all');

  const rowA = sceneRegistry.get(buildAgentSceneRegistryKey('tgBot:-1001', 'agentA'));
  const rowB = sceneRegistry.get(buildAgentSceneRegistryKey('tgBot:-1001', 'agentB'));
  assert.equal(rowA?.historyLimit, 30);
  assert.equal(rowB?.historyLimit, 80);
  assert.equal(rowA?.groupReplyMode, 'admin');
  assert.equal(rowB?.groupReplyMode, 'all');
});

test('a new agent row inherits mode, name and group from the scene', () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    groupName: '无界社区',
    agentId: 'orion',
    groupReplyMode: 'all',
    customName: '项目群',
    category: 'Ops',
    historyLimit: 80,
    historyForce: false,
    downloadMedia: true,
    lastSeenAt: 5,
  });

  const parsed = {
    isAdmin: true,
    peer: { kind: 'group' },
    platform: 'tgBot',
    groupId: '-1001',
    userId: '9',
  };
  const decision = decideSceneAdmission({
    parsed,
    now: 99,
    sceneRegistry,
    defaultAdminAgentId: ADMIN_AGENT,
    defaultPublicAgentId: PUBLIC_AGENT,
    // Admission is keyed by the agent the host routed the message to, which is
    // how a second agent ends up with its own row for a shared scene.
    sceneAgentId: PUBLIC_AGENT,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.scene.agentId, PUBLIC_AGENT);
  assert.equal(decision.scene.groupReplyMode, 'all');
  assert.equal(decision.scene.customName, '项目群');
  assert.equal(decision.scene.category, 'Ops');
  assert.equal(decision.scene.historyLimit, 80);
  assert.equal(decision.scene.historyForce, false);
  assert.equal(decision.scene.downloadMedia, true);

  const created = sceneRegistry.get(buildAgentSceneRegistryKey('tgBot:-1001', PUBLIC_AGENT));
  assert.equal(created?.groupReplyMode, 'all');
  assert.equal(created?.customName, '项目群');
  assert.equal(created?.category, 'Ops');
  assert.equal(created?.historyLimit, 80);
  assert.equal(created?.historyForce, false);
  assert.equal(created?.downloadMedia, true);
});

test('a new admin scene row carries its approval mark', () => {
  const sceneRegistry = new Map();
  const decision = decideSceneAdmission({
    parsed: {
      isAdmin: true,
      peer: { kind: 'direct' },
      platform: 'tgBot',
      userId: '10001',
      groupId: '0',
    },
    now: 42,
    sceneRegistry,
    defaultAdminAgentId: ADMIN_AGENT,
    defaultPublicAgentId: PUBLIC_AGENT,
  });

  assert.equal(decision.allowed, true);
  const row = resolveSceneRecord(sceneRegistry, 'tgBot:10001', ADMIN_AGENT);
  assert.equal(row?.approvedAt, 42);
  assert.equal(resolveEffectiveSceneStatus(row), 'allowed');
});

test('a legacy allowed direct row reads as pending until it is approved', () => {
  const legacy = {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    lastSeenAt: 1,
  };
  assert.equal(resolveEffectiveSceneStatus(legacy), 'pending');
  assert.equal(resolveEffectiveSceneStatus({ ...legacy, approvedAt: 5 }), 'allowed');
  assert.equal(
    resolveEffectiveSceneStatus({ ...legacy, kind: 'group', status: 'allowed' }),
    'allowed',
  );
});
