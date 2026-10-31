import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareBncrInboundAcceptance } from '../../src/plugin/inbound-acceptance.ts';
import { resolveSceneRecord, setSceneRecord } from '../../src/plugin/scene-registry.ts';

function buildParsed(overrides = {}) {
  return {
    accountId: 'Primary',
    protocolVersion: 'scene-routing-v1',
    capabilities: ['scene-routing-v1'],
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    clientId: 'bncr-client-1',
    isGroup: false,
    isAdmin: false,
    sessionKeyfromroute: undefined,
    route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
    text: 'hello',
    mediaBase64: '',
    mediaPathFromTransfer: '',
    msgId: 'msg-1',
    peer: { kind: 'direct', id: 'peer-1' },
    extracted: { text: 'hello', taskKey: null },
    dedupKey: 'dedup-1',
    ...overrides,
  };
}

function buildArgs(overrides = {}) {
  return {
    api: {},
    parsed: buildParsed(),
    canonicalAgentId: 'orion',
    asString: (value, fallback = '') => (typeof value === 'string' ? value : fallback),
    getRuntimeConfig: () => ({ channels: { bncr: { enabled: true } } }),
    resolveAgentRoute: () => ({
      sessionKey: 'agent:orion:bncr:group:7467426f743a2d31303031',
      agentId: 'orion',
    }),
    buildInboundResponsePayload: (args) => args,
    markInboundDedupSeen: () => false,
    sceneRegistry: new Map(),
    now: () => 123,
    defaultAdminAgentId: 'orion',
    defaultPublicAgentId: 'public',
    ...overrides,
  };
}

test('prepareBncrInboundAcceptance returns invalid-peer when required peer fields are missing', async () => {
  const result = await prepareBncrInboundAcceptance(
    buildArgs({ parsed: buildParsed({ platform: '', userId: '' }) }),
  );

  assert.deepEqual(result, {
    ok: false,
    status: false,
    payload: { kind: 'invalid-peer' },
  });
});

test('prepareBncrInboundAcceptance returns duplicated when dedup key was already seen', async () => {
  const result = await prepareBncrInboundAcceptance(
    buildArgs({ markInboundDedupSeen: () => true }),
  );

  assert.deepEqual(result, {
    ok: false,
    status: true,
    payload: { kind: 'duplicated', accountId: 'Primary', msgId: 'msg-1' },
  });
});

test('prepareBncrInboundAcceptance returns gate-denied when account policy blocks the inbound', async () => {
  const result = await prepareBncrInboundAcceptance(
    buildArgs({ getRuntimeConfig: () => ({ channels: { bncr: { enabled: false } } }) }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, true);
  assert.deepEqual(result.payload, {
    kind: 'gate-denied',
    accountId: 'Primary',
    msgId: 'msg-1',
    reason: 'account disabled',
  });
});

test('prepareBncrInboundAcceptance rejects outdated client before touching scene registry', async () => {
  const sceneRegistry = new Map();
  const result = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        protocolVersion: 'legacy-v0',
        capabilities: [],
      }),
      sceneRegistry,
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, true);
  assert.deepEqual(result.payload, {
    kind: 'gate-denied',
    accountId: 'Primary',
    msgId: 'msg-1',
    reason: 'client protocol outdated',
  });
  assert.equal(sceneRegistry.size, 0);
});

test('prepareBncrInboundAcceptance rejects incomplete schema before touching scene registry', async () => {
  const sceneRegistry = new Map();
  const result = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        clientId: '',
      }),
      sceneRegistry,
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, true);
  assert.deepEqual(result.payload, {
    kind: 'gate-denied',
    accountId: 'Primary',
    msgId: 'msg-1',
    reason: 'inbound schema incomplete',
  });
  assert.equal(sceneRegistry.size, 0);
});

test('prepareBncrInboundAcceptance returns accepted payload with normalized session details', async () => {
  const result = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        peer: { kind: 'group', id: '-1001' },
        isAdmin: true,
        shouldRespond: true,
      }),
    }),
  );

  assert.deepEqual(result, {
    ok: true,
    accountId: 'Primary',
    sessionKey: 'agent:public:bncr:group:7467426f743a2d31303031',
    inboundText: 'hello',
    hasMedia: false,
    resolvedAgentId: 'public',
    shouldDispatch: true,
    shouldAccumulate: true,
    dispatchBy: 'mode-admin-admin',
  });
});

test('prepareBncrInboundAcceptance defaults group scenes to admin-only reply mode', async () => {
  const sceneRegistry = new Map();
  const result = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        peer: { kind: 'group', id: '-1001' },
        isAdmin: true,
        shouldRespond: false,
      }),
      sceneRegistry,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.shouldDispatch, true);
  assert.equal(result.shouldAccumulate, true);
  assert.deepEqual(resolveSceneRecord(sceneRegistry, 'tgBot:-1001'), {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    groupId: '-1001',
    agentId: 'public',
    groupReplyMode: 'admin',
    historyLimit: 50,
    historyForce: true,
    approvedAt: 123,
    lastSeenAt: 123,
  });
});

test('group reply modes gate uploads and replies as documented', async () => {
  const cases = [
    { mode: 'all', isAdmin: true, shouldRespond: false, upload: true, reply: true },
    { mode: 'all', isAdmin: false, shouldRespond: false, upload: true, reply: true },
    { mode: 'admin', isAdmin: true, shouldRespond: false, upload: true, reply: true },
    { mode: 'admin', isAdmin: false, shouldRespond: true, upload: false, reply: false },
    { mode: 'admin', isAdmin: false, shouldRespond: false, upload: false, reply: false },
    { mode: 'mention', isAdmin: true, shouldRespond: true, upload: true, reply: true },
    { mode: 'mention', isAdmin: true, shouldRespond: false, upload: true, reply: false },
    { mode: 'mention', isAdmin: false, shouldRespond: true, upload: true, reply: true },
    { mode: 'mention', isAdmin: false, shouldRespond: false, upload: true, reply: false },
    { mode: 'hybrid', isAdmin: true, shouldRespond: false, upload: true, reply: true },
    { mode: 'hybrid', isAdmin: false, shouldRespond: true, upload: true, reply: true },
    { mode: 'hybrid', isAdmin: false, shouldRespond: false, upload: true, reply: false },
  ];

  for (const item of cases) {
    const sceneRegistry = new Map();
    setSceneRecord(sceneRegistry, {
      sceneKey: 'tgBot:-1001',
      kind: 'group',
      status: 'allowed',
      platform: 'tgBot',
      groupId: '-1001',
      agentId: 'public',
      groupReplyMode: item.mode,
      historyLimit: 50,
      historyForce: true,
      lastSeenAt: 1,
    });
    const result = await prepareBncrInboundAcceptance(
      buildArgs({
        parsed: buildParsed({
          peer: { kind: 'group', id: '-1001' },
          isGroup: true,
          isAdmin: item.isAdmin,
          shouldRespond: item.shouldRespond,
        }),
        sceneRegistry,
      }),
    );
    const label = `${item.mode} admin=${item.isAdmin} mention=${item.shouldRespond}`;
    assert.equal(result.shouldAccumulate, item.upload, `${label} upload`);
    assert.equal(result.shouldDispatch, item.reply, `${label} reply`);
  }
});

test('prepareBncrInboundAcceptance honors group reply modes for dispatch decisions', async () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    agentId: 'public',
    groupReplyMode: 'admin',
    historyLimit: 50,
    historyForce: true,
    lastSeenAt: 100,
  });

  const adminOnly = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        peer: { kind: 'group', id: '-1001' },
        isAdmin: false,
        shouldRespond: true,
      }),
      sceneRegistry,
    }),
  );
  assert.equal(adminOnly.ok, true);
  assert.equal(adminOnly.shouldDispatch, false);
  assert.equal(adminOnly.shouldAccumulate, false);

  setSceneRecord(sceneRegistry, {
    ...resolveSceneRecord(sceneRegistry, 'tgBot:-1001'),
    groupReplyMode: 'mention',
  });
  const mention = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        peer: { kind: 'group', id: '-1001' },
        isAdmin: false,
        shouldRespond: true,
      }),
      sceneRegistry,
    }),
  );
  assert.equal(mention.ok, true);
  assert.equal(mention.shouldDispatch, true);
  assert.equal(mention.shouldAccumulate, true);

  setSceneRecord(sceneRegistry, {
    ...resolveSceneRecord(sceneRegistry, 'tgBot:-1001'),
    groupReplyMode: 'hybrid',
  });
  const hybrid = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        peer: { kind: 'group', id: '-1001' },
        isAdmin: false,
        shouldRespond: false,
      }),
      sceneRegistry,
    }),
  );
  assert.equal(hybrid.ok, true);
  assert.equal(hybrid.shouldDispatch, false);
  assert.equal(hybrid.shouldAccumulate, true);
  const hybridAdmin = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        peer: { kind: 'group', id: '-1001' },
        isAdmin: true,
        shouldRespond: false,
      }),
      sceneRegistry,
    }),
  );
  assert.equal(hybridAdmin.ok, true);
  assert.equal(hybridAdmin.shouldDispatch, true);
  assert.equal(hybridAdmin.shouldAccumulate, true);

  setSceneRecord(sceneRegistry, {
    ...resolveSceneRecord(sceneRegistry, 'tgBot:-1001'),
    groupReplyMode: 'mention',
  });
  const mentionAdminStatus = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        peer: { kind: 'group', id: '-1001' },
        isAdmin: true,
        shouldRespond: false,
        text: '/status',
        extracted: { text: '/status', taskKey: null },
      }),
      sceneRegistry,
    }),
  );
  assert.equal(mentionAdminStatus.ok, true);
  assert.equal(mentionAdminStatus.shouldDispatch, true);

  setSceneRecord(sceneRegistry, {
    ...resolveSceneRecord(sceneRegistry, 'tgBot:-1001'),
    groupReplyMode: 'all',
  });
  const all = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        peer: { kind: 'group', id: '-1001' },
        isAdmin: false,
        shouldRespond: false,
      }),
      sceneRegistry,
    }),
  );
  assert.equal(all.ok, true);
  assert.equal(all.shouldDispatch, true);
  assert.equal(all.shouldAccumulate, true);
});

test('prepareBncrInboundAcceptance reads the scene row of the agent the host routes to', async () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    agentId: 'orion',
    groupReplyMode: 'mention',
    historyLimit: 20,
    lastSeenAt: 10,
  });
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'denied',
    platform: 'tgBot',
    groupId: '-1001',
    agentId: 'public',
    groupReplyMode: 'admin',
    historyLimit: 60,
    lastSeenAt: 20,
  });

  const groupParsed = buildParsed({
    peer: { kind: 'group', id: '-1001' },
    isAdmin: false,
    shouldRespond: false,
  });

  const orion = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: groupParsed,
      sceneRegistry,
      resolveAgentRoute: () => ({
        sessionKey: 'agent:orion:bncr:group:7467426f743a2d31303031',
        agentId: 'orion',
      }),
    }),
  );
  assert.equal(orion.ok, true, 'orion keeps its own allowed row');
  assert.equal(orion.resolvedAgentId, 'orion');
  assert.equal(orion.dispatchBy, 'mode-mention-idle');
  assert.equal(orion.shouldDispatch, false);
  assert.equal(orion.shouldAccumulate, true);

  const publicAgent = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: groupParsed,
      sceneRegistry,
      resolveAgentRoute: () => ({
        sessionKey: 'agent:public:bncr:group:7467426f743a2d31303031',
        agentId: 'public',
      }),
    }),
  );
  assert.equal(publicAgent.ok, false, 'the public row still denies the same chat');
  assert.equal(publicAgent.payload.reason, 'scene denied');

  // Both rows stay intact; neither agent's admission rewrote the other's row.
  assert.equal(resolveSceneRecord(sceneRegistry, 'tgBot:-1001', 'orion')?.status, 'allowed');
  assert.equal(resolveSceneRecord(sceneRegistry, 'tgBot:-1001', 'public')?.status, 'denied');
});

test('prepareBncrInboundAcceptance keeps unknown non-admin direct scenes pending and silent', async () => {
  const sceneRegistry = new Map();
  const result = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        groupId: '0',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        peer: { kind: 'direct', id: '10001' },
        isAdmin: false,
      }),
      sceneRegistry,
    }),
  );

  assert.deepEqual(result, {
    ok: false,
    status: false,
    payload: {
      kind: 'gate-denied',
      accountId: 'Primary',
      msgId: 'msg-1',
      reason: 'scene pending approval',
    },
  });
  assert.deepEqual(resolveSceneRecord(sceneRegistry, 'tgBot:10001'), {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'pending',
    platform: 'tgBot',
    userId: '10001',
    historyLimit: 50,
    historyForce: true,
    lastSeenAt: 123,
  });
});

test('prepareBncrInboundAcceptance lets admin callers recover denied group scenes', async () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'denied',
    platform: 'tgBot',
    groupId: '-1001',
    groupName: 'wind_system',
    lastSeenAt: 100,
  });

  const result = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        peer: { kind: 'group', id: '-1001' },
        isAdmin: true,
        shouldRespond: true,
        userId: '20002',
        userName: 'admin-user',
      }),
      sceneRegistry,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.accountId, 'Primary');
  assert.equal(result.sessionKey, 'agent:public:bncr:group:7467426f743a2d31303031');
  assert.equal(result.inboundText, 'hello');
  assert.equal(result.hasMedia, false);
  assert.equal(result.resolvedAgentId, 'public');
  assert.equal(result.shouldDispatch, true);
  assert.deepEqual(resolveSceneRecord(sceneRegistry, 'tgBot:-1001'), {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    groupName: 'wind_system',
    userId: '20002',
    userName: 'admin-user',
    groupReplyMode: 'admin',
    historyLimit: 50,
    historyForce: true,
    approvedAt: 123,
    lastSeenAt: 123,
  });
});

test('prepareBncrInboundAcceptance promotes denied group scenes to public when an admin arrives later', async () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'denied',
    platform: 'tgBot',
    groupId: '-1001',
    groupName: 'wind_system',
    userId: '10001',
    userName: 'member-user',
    lastSeenAt: 100,
  });

  const result = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        peer: { kind: 'group', id: '-1001' },
        isAdmin: true,
        shouldRespond: true,
        userId: '20002',
        userName: 'admin-user',
      }),
      sceneRegistry,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.resolvedAgentId, 'public');
  assert.equal(result.sessionKey, 'agent:public:bncr:group:7467426f743a2d31303031');
  assert.deepEqual(resolveSceneRecord(sceneRegistry, 'tgBot:-1001'), {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    groupName: 'wind_system',
    userId: '20002',
    userName: 'admin-user',
    groupReplyMode: 'admin',
    historyLimit: 50,
    historyForce: true,
    approvedAt: 123,
    lastSeenAt: 123,
  });
});

test('prepareBncrInboundAcceptance sends legacy unapproved direct scenes back to pending', async () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    userName: 'legacy-user',
    agentId: 'orion',
    lastSeenAt: 100,
  });

  const result = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        groupId: '0',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        peer: { kind: 'direct', id: '10001' },
        isAdmin: false,
        userName: 'xmo',
      }),
      sceneRegistry,
    }),
  );

  assert.deepEqual(result, {
    ok: false,
    status: false,
    payload: {
      kind: 'gate-denied',
      accountId: 'Primary',
      msgId: 'msg-1',
      reason: 'scene pending approval',
    },
  });
  assert.deepEqual(resolveSceneRecord(sceneRegistry, 'tgBot:10001'), {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'pending',
    platform: 'tgBot',
    userId: '10001',
    userName: 'xmo',
    agentId: 'public',
    historyLimit: 50,
    historyForce: true,
    lastSeenAt: 123,
  });
});

test('prepareBncrInboundAcceptance sends legacy unapproved direct scenes with empty agent back to pending', async () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    userName: 'legacy-user',
    agentId: '',
    lastSeenAt: 100,
  });

  const result = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        groupId: '0',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        peer: { kind: 'direct', id: '10001' },
        isAdmin: false,
        userName: 'xmo',
      }),
      sceneRegistry,
    }),
  );

  assert.deepEqual(result, {
    ok: false,
    status: false,
    payload: {
      kind: 'gate-denied',
      accountId: 'Primary',
      msgId: 'msg-1',
      reason: 'scene pending approval',
    },
  });
  assert.deepEqual(resolveSceneRecord(sceneRegistry, 'tgBot:10001'), {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'pending',
    platform: 'tgBot',
    userId: '10001',
    userName: 'xmo',
    agentId: 'public',
    historyLimit: 50,
    historyForce: true,
    lastSeenAt: 123,
  });
});

test('prepareBncrInboundAcceptance keeps custom agent but pends legacy unapproved direct scenes', async () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    userName: 'legacy-user',
    agentId: 'custom-agent',
    lastSeenAt: 100,
  });

  const result = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        groupId: '0',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        peer: { kind: 'direct', id: '10001' },
        isAdmin: false,
        userName: 'xmo',
      }),
      sceneRegistry,
      resolveAgentRoute: () => ({
        sessionKey: 'agent:custom-agent:bncr:direct:7467426f743a3130303031',
        agentId: 'custom-agent',
      }),
    }),
  );

  assert.deepEqual(result, {
    ok: false,
    status: false,
    payload: {
      kind: 'gate-denied',
      accountId: 'Primary',
      msgId: 'msg-1',
      reason: 'scene pending approval',
    },
  });
  assert.deepEqual(resolveSceneRecord(sceneRegistry, 'tgBot:10001'), {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'pending',
    platform: 'tgBot',
    userId: '10001',
    userName: 'xmo',
    agentId: 'custom-agent',
    historyLimit: 50,
    historyForce: true,
    lastSeenAt: 123,
  });
});

test('prepareBncrInboundAcceptance admits explicitly approved direct scenes', async () => {
  const sceneRegistry = new Map();
  setSceneRecord(sceneRegistry, {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    userName: 'approved-user',
    agentId: 'public',
    approvedAt: 90,
    lastSeenAt: 100,
  });

  const result = await prepareBncrInboundAcceptance(
    buildArgs({
      parsed: buildParsed({
        groupId: '0',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        peer: { kind: 'direct', id: '10001' },
        isAdmin: false,
        userName: 'xmo',
      }),
      sceneRegistry,
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.resolvedAgentId, 'public');
  assert.equal(result.sessionKey, 'agent:public:bncr:direct:7467426f743a3130303031');
  assert.deepEqual(resolveSceneRecord(sceneRegistry, 'tgBot:10001'), {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    userName: 'xmo',
    agentId: 'public',
    approvedAt: 90,
    historyLimit: 50,
    historyForce: true,
    lastSeenAt: 123,
  });
});
