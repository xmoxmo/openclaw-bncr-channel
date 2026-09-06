import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrInboundHandlers } from '../../src/plugin/inbound-handlers.ts';

function createRuntime(overrides = {}) {
  const calls = {
    refresh: [],
    markLastInboundAt: [],
    flushed: [],
    dispatched: [],
    errors: [],
    enqueuedReplies: [],
  };
  const runtime = {
    channelId: 'bncr',
    bridgeId: 'bridge-1',
    asString: (value, fallback = '') =>
      typeof value === 'string' ? value : value == null ? fallback : String(value),
    now: () => 12_000,
    async syncDebugFlag() {},
    parseInboundParams() {
      return {
        accountId: 'Primary',
        platform: 'tgBot',
        userId: '10001',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        msgType: 'text',
        msgId: 'msg-1',
        peer: { kind: 'direct', id: '10001' },
        extracted: { taskKey: 'task-1' },
      };
    },
    shouldIgnoreStaleEvent() {
      return false;
    },
    buildInboundResponsePayload(args) {
      return args;
    },
    refreshLiveConnectionState(args) {
      calls.refresh.push(args);
    },
    logInfo() {},
    logError(scope, message) {
      calls.errors.push([scope, message]);
    },
    buildInboundAcceptedLifecycleDebugInfo() {
      return { ok: true };
    },
    isOnline() {
      return true;
    },
    hasRecentInboundReachability() {
      return true;
    },
    getActiveConnectionKey() {
      return 'Primary:client-1';
    },
    buildActiveConnectionDebugList() {
      return [];
    },
    markLastInboundAt(accountId) {
      calls.markLastInboundAt.push(accountId);
    },
    getConfig() {
      return { channels: { bncr: {} } };
    },
    ensureCanonicalAgentId() {
      return 'orion';
    },
    defaultAdminAgentId() {
      return 'orion';
    },
    defaultPublicAgentId() {
      return 'public';
    },
    sceneRegistry: new Map(),
    async prepareInboundAcceptance() {
      return {
        ok: true,
        sessionKey: 'session-1',
        inboundText: 'hello',
        hasMedia: false,
        resolvedAgentId: 'orion',
        shouldDispatch: true,
      };
    },
    formatDisplayScope() {
      return 'Bncr:tgBot:0:10001';
    },
    logInboundSummary() {},
    async enqueueFromReply(args) {
      calls.enqueuedReplies.push(args);
    },
    respond() {},
    flushOnInboundAccepted(accountId) {
      calls.flushed.push(accountId);
    },
    async dispatchInbound(args) {
      calls.dispatched.push(args);
    },
    ...overrides,
  };
  return { runtime, calls };
}

test('inbound handlers accept inbound and flush/dispatch with canonical agent id', async () => {
  const { runtime, calls } = createRuntime();
  const handlers = createBncrInboundHandlers(runtime);
  const responses = [];

  await handlers.handleInbound({
    params: { leaseId: 'lease-1' },
    respond(ok, payload) {
      responses.push([ok, payload]);
    },
    client: { connId: 'conn-1', clientId: 'client-1' },
    context: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(responses[0][0], true);
  assert.equal(responses[0][1].kind, 'accepted');
  assert.deepEqual(calls.markLastInboundAt, ['Primary']);
  assert.deepEqual(calls.flushed, ['Primary']);
  assert.equal(calls.dispatched[0].canonicalAgentId, 'orion');
});

test('inbound handlers run post-ack dispatch through an independent work runner', async () => {
  const detachedStarts = [];
  const { runtime, calls } = createRuntime({
    async runInboundDetached(run) {
      detachedStarts.push(true);
      await run();
    },
  });
  const handlers = createBncrInboundHandlers(runtime);
  const responses = [];

  await handlers.handleInbound({
    params: { leaseId: 'lease-1' },
    respond(ok, payload) {
      responses.push([ok, payload]);
    },
    client: { connId: 'conn-1', clientId: 'client-1' },
    context: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(responses.length, 1);
  assert.equal(detachedStarts.length, 1);
  assert.equal(calls.dispatched.length, 1);
});

test('inbound handlers short-circuit stale events before acceptance', async () => {
  const { runtime, calls } = createRuntime({
    shouldIgnoreStaleEvent() {
      return true;
    },
  });
  const handlers = createBncrInboundHandlers(runtime);
  const responses = [];

  await handlers.handleInbound({
    params: {},
    respond(ok, payload) {
      responses.push([ok, payload]);
    },
    client: { connId: 'conn-1' },
    context: null,
  });

  assert.equal(responses[0][1].kind, 'stale-ignored');
  assert.equal(calls.refresh.length, 0);
  assert.equal(calls.dispatched.length, 0);
});

test('inbound handlers emit a visible pending notice for non-admin direct approval gating', async () => {
  const { runtime, calls } = createRuntime({
    async prepareInboundAcceptance() {
      return {
        ok: false,
        status: true,
        payload: {
          accepted: false,
          accountId: 'Primary',
          msgId: 'msg-1',
          reason: 'scene pending approval',
        },
      };
    },
  });
  const handlers = createBncrInboundHandlers(runtime);
  const responses = [];

  await handlers.handleInbound({
    params: { leaseId: 'lease-1' },
    respond(ok, payload) {
      responses.push([ok, payload]);
    },
    client: { connId: 'conn-1', clientId: 'client-1' },
    context: null,
  });

  assert.deepEqual(responses[0], [
    true,
    {
      accepted: false,
      accountId: 'Primary',
      msgId: 'msg-1',
      reason: 'scene pending approval',
    },
  ]);
  assert.equal(calls.enqueuedReplies.length, 1);
  assert.equal(
    calls.enqueuedReplies[0].payload.text,
    'This private chat is pending approval. Ask the administrator to allow your SceneId: tgBot:10001',
  );
  assert.equal(calls.enqueuedReplies[0].payload.replyToId, 'msg-1');
  assert.equal(
    calls.enqueuedReplies[0].sessionKey,
    'agent:orion:bncr:direct:7467426f743a3130303031',
  );
  assert.deepEqual(calls.enqueuedReplies[0].route, {
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
  });
  assert.equal(calls.dispatched.length, 0);
});

test('inbound handlers dispatch group messages to public after admin recovers a denied scene', async () => {
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
        userId: '10001',
        userName: 'member-user',
        lastSeenAt: 100,
      },
    ],
  ]);
  const { runtime, calls } = createRuntime({
    parseInboundParams() {
      return {
        accountId: 'Primary',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        userId: '20002',
        userName: 'admin-user',
        route: { platform: 'tgBot', groupId: '-1001', userId: '0' },
        msgType: 'text',
        msgId: 'msg-1',
        peer: { kind: 'group', id: '-1001' },
        extracted: { taskKey: null },
        isAdmin: true,
        shouldRespond: true,
      };
    },
    sceneRegistry,
    async prepareInboundAcceptance() {
      sceneRegistry.set('tgBot:-1001', {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        userId: '20002',
        userName: 'admin-user',
        groupReplyMode: 'admin',
        lastSeenAt: 12_000,
      });
      return {
        ok: true,
        accountId: 'Primary',
        sessionKey: 'agent:public:bncr:group:7467426f743a2d31303031',
        inboundText: 'hello',
        hasMedia: false,
        resolvedAgentId: 'public',
        shouldDispatch: true,
        shouldAccumulate: true,
      };
    },
    formatDisplayScope() {
      return 'Bncr:tgBot:-1001:0';
    },
  });
  const handlers = createBncrInboundHandlers(runtime);
  const responses = [];

  await handlers.handleInbound({
    params: { leaseId: 'lease-1' },
    respond(ok, payload) {
      responses.push([ok, payload]);
    },
    client: { connId: 'conn-1', clientId: 'client-1' },
    context: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(responses[0][0], true);
  assert.equal(responses[0][1].kind, 'accepted');
  assert.equal(calls.dispatched[0].resolvedAgentId, 'public');
  assert.equal(calls.dispatched[0].shouldDispatch, true);
  assert.equal(calls.dispatched[0].shouldAccumulate, true);
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
    lastSeenAt: 12_000,
  });
});
