import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentSceneRegistryKey,
  decideSceneAdmission,
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
