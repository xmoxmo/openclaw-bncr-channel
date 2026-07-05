import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareBncrInboundAcceptance } from '../../src/plugin/inbound-acceptance.ts';

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
  assert.deepEqual(sceneRegistry.get('tgBot:-1001'), {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    groupId: '-1001',
    agentId: 'public',
    groupReplyMode: 'admin',
    lastSeenAt: 123,
  });
});

test('prepareBncrInboundAcceptance honors group reply modes for dispatch decisions', async () => {
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        agentId: 'public',
        groupReplyMode: 'admin',
        lastSeenAt: 100,
      },
    ],
  ]);

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

  sceneRegistry.set('tgBot:-1001', {
    ...sceneRegistry.get('tgBot:-1001'),
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

  sceneRegistry.set('tgBot:-1001', {
    ...sceneRegistry.get('tgBot:-1001'),
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

  sceneRegistry.set('tgBot:-1001', {
    ...sceneRegistry.get('tgBot:-1001'),
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

  sceneRegistry.set('tgBot:-1001', {
    ...sceneRegistry.get('tgBot:-1001'),
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
});

test('prepareBncrInboundAcceptance marks non-admin direct scene pending and denies dispatch', async () => {
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
    status: true,
    payload: {
      kind: 'gate-denied',
      accountId: 'Primary',
      msgId: 'msg-1',
      reason: 'scene pending approval',
    },
  });
  assert.deepEqual(sceneRegistry.get('tgBot:10001'), {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'pending',
    platform: 'tgBot',
    userId: '10001',
    lastSeenAt: 123,
  });
});

test('prepareBncrInboundAcceptance lets admin callers recover denied group scenes', async () => {
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'denied',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        lastSeenAt: 100,
      },
    ],
  ]);

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
  assert.deepEqual(sceneRegistry.get('tgBot:-1001'), {
    sceneKey: 'tgBot:-1001',
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-1001',
    groupName: 'wind_system',
    userId: '20002',
    userName: 'admin-user',
    groupReplyMode: 'admin',
    lastSeenAt: 123,
  });
});
