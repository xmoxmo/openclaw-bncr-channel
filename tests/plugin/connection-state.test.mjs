import assert from 'node:assert/strict';
import test from 'node:test';
import { createBncrConnectionState } from '../../src/plugin/connection-state.ts';
import { createBncrConnectionStateRuntimeGroup } from '../../src/plugin/connection-state-runtime-group.ts';

function createRuntime() {
  const nowRef = { value: 10_000 };
  const calls = { rememberGatewayContext: [], markActivity: [], logInfo: [], logInfoDedupJson: [] };
  const runtime = {
    bridgeId: 'bridge-test',
    now: () => nowRef.value,
    asString: (value, fallback = '') => String(value ?? fallback),
    connectTtlMs: 60_000,
    recentInboundSendWindowMs: 60_000,
    outboundReadyTtlMs: 20_000,
    preferredOutboundTtlMs: 30_000,
    connections: new Map(),
    activeConnectionByAccount: new Map(),
    lastInboundByAccount: new Map(),
    lastActivityByAccount: new Map(),
    gcTransientState() {},
    connectionKey: (accountId, clientId) => `${accountId}:${clientId || 'none'}`,
    buildActiveConnectionDebugList(accountId) {
      return Array.from(runtime.connections.values())
        .filter((connection) => connection.accountId === accountId)
        .map((connection) => ({
          accountId: connection.accountId,
          connId: connection.connId,
          clientId: connection.clientId,
          connectedAt: connection.connectedAt,
          lastSeenAt: connection.lastSeenAt,
          outboundReadyUntil: connection.outboundReadyUntil ?? null,
          preferredForOutboundUntil: connection.preferredForOutboundUntil ?? null,
          inboundOnly: connection.inboundOnly,
        }));
    },
    rememberGatewayContext(context) {
      calls.rememberGatewayContext.push(context);
    },
    markActivity(accountId) {
      calls.markActivity.push(accountId);
      runtime.lastActivityByAccount.set(accountId, nowRef.value);
    },
    logInfo(scope, message) {
      calls.logInfo.push([scope, message]);
    },
    logInfoDedupJson(scope, label, payload) {
      calls.logInfoDedupJson.push([scope, label, payload]);
    },
  };
  return { runtime, calls, nowRef };
}

test('connection state marks seen capability and adoption paths directly', () => {
  const { runtime, nowRef } = createRuntime();
  const state = createBncrConnectionState(runtime);

  state.markSeen('Primary', 'conn-1', 'client-1');
  const key = runtime.connectionKey('Primary', 'client-1');
  assert.equal(runtime.activeConnectionByAccount.get('Primary'), key);
  assert.equal(runtime.connections.get(key)?.connId, 'conn-1');

  state.markOutboundCapability({
    accountId: 'Primary',
    connId: 'conn-1',
    clientId: 'client-1',
    outboundReady: true,
    preferredForOutbound: true,
    inboundOnly: false,
    at: nowRef.value,
  });
  assert.ok(runtime.connections.get(key)?.outboundReadyUntil > nowRef.value);
  assert.ok(runtime.connections.get(key)?.preferredForOutboundUntil > nowRef.value);

  runtime.lastInboundByAccount.set('Primary', nowRef.value);
  runtime.lastActivityByAccount.set('Primary', nowRef.value);
  const transfer = {};
  assert.equal(
    state.tryAdoptTransferOwner({
      accountId: 'Primary',
      transfer,
      connId: 'conn-1',
      clientId: 'client-1',
    }),
    true,
  );
  assert.deepEqual(transfer, { ownerConnId: 'conn-1', ownerClientId: 'client-1' });
});

test('connection state degrades capability only when an alternative live connection exists', () => {
  const { runtime, nowRef } = createRuntime();
  const state = createBncrConnectionState(runtime);

  state.markSeen('Primary', 'conn-1', 'client-1');
  state.markSeen('Primary', 'conn-2', 'client-2');

  state.markOutboundCapability({
    accountId: 'Primary',
    connId: 'conn-1',
    clientId: 'client-1',
    outboundReady: true,
    preferredForOutbound: true,
    inboundOnly: false,
    at: nowRef.value,
  });
  state.markOutboundCapability({
    accountId: 'Primary',
    connId: 'conn-2',
    clientId: 'client-2',
    outboundReady: true,
    preferredForOutbound: false,
    inboundOnly: false,
    at: nowRef.value,
  });

  const key1 = runtime.connectionKey('Primary', 'client-1');
  state.degradeOutboundCapability({
    accountId: 'Primary',
    connId: 'conn-1',
    clientId: 'client-1',
    reason: 'ack-timeout',
    at: nowRef.value + 1,
  });
  assert.equal(runtime.connections.get(key1)?.outboundReadyUntil, undefined);

  const solo = createRuntime();
  const soloState = createBncrConnectionState(solo.runtime);
  soloState.markSeen('Primary', 'conn-1', 'client-1');
  soloState.markOutboundCapability({
    accountId: 'Primary',
    connId: 'conn-1',
    clientId: 'client-1',
    outboundReady: true,
    preferredForOutbound: true,
    inboundOnly: false,
    at: solo.nowRef.value,
  });
  const soloKey = solo.runtime.connectionKey('Primary', 'client-1');
  const before = solo.runtime.connections.get(soloKey)?.outboundReadyUntil;
  soloState.degradeOutboundCapability({
    accountId: 'Primary',
    connId: 'conn-1',
    clientId: 'client-1',
    reason: 'ack-timeout',
    at: solo.nowRef.value + 1,
  });
  assert.equal(solo.runtime.connections.get(soloKey)?.outboundReadyUntil, before);
});

test('connection state runtime group exposes composed connectionState helpers', () => {
  const { runtime, nowRef } = createRuntime();
  const group = createBncrConnectionStateRuntimeGroup(runtime);

  group.connectionState.markSeen('Primary', 'conn-1', 'client-1');
  group.connectionState.markOutboundCapability({
    accountId: 'Primary',
    connId: 'conn-1',
    clientId: 'client-1',
    outboundReady: true,
    preferredForOutbound: false,
    inboundOnly: false,
    at: nowRef.value,
  });

  const key = runtime.connectionKey('Primary', 'client-1');
  assert.equal(runtime.activeConnectionByAccount.get('Primary'), key);
  assert.ok(runtime.connections.get(key)?.outboundReadyUntil > nowRef.value);
});

test('connection state reuses structured debug payload logging across seen capability and degrade paths', () => {
  const { runtime, calls, nowRef } = createRuntime();
  const state = createBncrConnectionState(runtime);

  state.markSeen('Primary', 'conn-1', 'client-1');
  state.markSeen('Primary', 'conn-2', 'client-2');
  state.markOutboundCapability({
    accountId: 'Primary',
    connId: 'conn-1',
    clientId: 'client-1',
    outboundReady: true,
    preferredForOutbound: true,
    inboundOnly: false,
    at: nowRef.value,
  });
  state.markOutboundCapability({
    accountId: 'Primary',
    connId: 'conn-2',
    clientId: 'client-2',
    outboundReady: true,
    preferredForOutbound: false,
    inboundOnly: false,
    at: nowRef.value,
  });
  state.degradeOutboundCapability({
    accountId: 'Primary',
    connId: 'conn-1',
    clientId: 'client-1',
    reason: 'ack-timeout',
    at: nowRef.value + 1,
  });

  assert.equal(calls.logInfoDedupJson.length >= 3, true);
  assert.equal(
    calls.logInfo.some(
      ([scope, message]) => scope === 'connection' && message.includes('outbound-degrade'),
    ),
    true,
  );
});

test('connection state exposes stable active connection debug entry shape in promotion logs', () => {
  const { runtime, calls } = createRuntime();
  const state = createBncrConnectionState(runtime);

  state.markSeen('Primary', 'conn-1', 'client-1');

  const promoteLog = calls.logInfo.find(
    ([scope, message]) => scope === 'connection' && message.includes('seen:promote'),
  );
  assert.ok(promoteLog, 'expected seen:promote connection log');

  const payload = JSON.parse(promoteLog[1].slice('seen:promote '.length));
  assert.deepEqual(payload.activeConnections, [
    {
      accountId: 'Primary',
      connId: 'conn-1',
      clientId: 'client-1',
      connectedAt: 10_000,
      lastSeenAt: 10_000,
      outboundReadyUntil: null,
      preferredForOutboundUntil: null,
    },
  ]);
});
