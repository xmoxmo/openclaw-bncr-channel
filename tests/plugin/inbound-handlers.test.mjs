import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrInboundHandlers } from '../../src/plugin/inbound-handlers.ts';

function createRuntime(overrides = {}) {
  const calls = { refresh: [], markLastInboundAt: [], flushed: [], dispatched: [], errors: [] };
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
