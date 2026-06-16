import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  createGatewayRespondCapture,
  createRegisterApiStub,
  getRegisteredMethod,
  resetBncrRegisterGlobals,
} from '../helpers/register-api.mjs';

afterEach(() => {
  const bridge = globalThis.__bncrBridge;
  if (bridge && typeof bridge.shutdown === 'function') {
    bridge.shutdown();
  }
  resetBncrRegisterGlobals();
});

test('status worker marks linked from recent inbound reachability when no live connection remains', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const connect = getRegisteredMethod(api, 'bncr.connect');
  const inbound = getRegisteredMethod(api, 'bncr.inbound');

  const c1 = createGatewayRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c1.respond,
    client: { connId: 'conn-a' },
    context: { broadcastToConnIds() {} },
  });

  await inbound({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      platform: 'tgBot',
      groupId: '-1001',
      userId: '10001',
      type: 'text',
      msg: 'hello inbound',
      msgId: 'status-inbound-1',
    },
    respond() {},
    client: { connId: 'conn-a' },
    context: { broadcastToConnIds() {} },
  });

  const bridge = globalThis.__bncrBridge;
  assert.ok(bridge, 'expected global bridge');

  bridge.connections.clear();
  bridge.activeConnectionByAccount.delete('Primary');

  let status = null;
  const abortController = new AbortController();
  const workerPromise = bridge.channelStartAccount({
    accountId: 'Primary',
    getStatus() {
      return {};
    },
    setStatus(next) {
      status = next;
      abortController.abort();
    },
    abortSignal: abortController.signal,
  });

  await workerPromise;

  assert.ok(status, 'expected status update');
  assert.equal(status.connected, true);
  assert.equal(status.mode, 'linked');
  assert.ok(status.meta, 'expected status meta');
});

test('gcTransientState keeps the only live active connection even after push failures', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const connect = getRegisteredMethod(api, 'bncr.connect');
  const originalNow = Date.now;
  const nowTs = originalNow() + 1_000_000;
  Date.now = () => nowTs;

  try {
    await connect({
      params: { accountId: 'Primary', clientId: 'client-a' },
      respond() {},
      client: { connId: 'conn-a' },
      context: { broadcastToConnIds() {} },
    });

    const bridge = globalThis.__bncrBridge;
    const key = 'Primary::client-a';
    const conn = bridge.connections.get(key);
    conn.lastSeenAt = nowTs - 1_000;
    conn.lastPushTimeoutAt = nowTs - 500;
    conn.pushFailureScore = 5;
    bridge.connections.set(key, conn);
    bridge.activeConnectionByAccount.set('Primary', key);

    bridge.gcTransientState();

    assert.ok(bridge.connections.has(key), 'live but degraded connection must stay registered');
    assert.equal(
      bridge.activeConnectionByAccount.get('Primary'),
      key,
      'live active connection must not be cleared just because it has push failures',
    );
  } finally {
    Date.now = originalNow;
  }
});

test('gcTransientState clears active connection pointer only after that connection is stale-deleted', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const connect = getRegisteredMethod(api, 'bncr.connect');
  const originalNow = Date.now;
  const nowTs = originalNow() + 1_000_000;
  Date.now = () => nowTs;

  try {
    await connect({
      params: { accountId: 'Primary', clientId: 'client-a' },
      respond() {},
      client: { connId: 'conn-a' },
      context: { broadcastToConnIds() {} },
    });

    const bridge = globalThis.__bncrBridge;
    const key = 'Primary::client-a';
    const conn = bridge.connections.get(key);
    conn.lastSeenAt = nowTs - 300_000;
    bridge.connections.set(key, conn);
    bridge.activeConnectionByAccount.set('Primary', key);

    bridge.gcTransientState();

    assert.equal(
      bridge.connections.has(key),
      false,
      'stale connection should be deleted by existing GC',
    );
    assert.equal(
      bridge.activeConnectionByAccount.has('Primary'),
      false,
      'active pointer should be cleared only because it pointed at the deleted connection',
    );
  } finally {
    Date.now = originalNow;
  }
});

test('resolveOutboxPushOwner can recover to a live connection after gc removes stale active owner', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const connect = getRegisteredMethod(api, 'bncr.connect');
  const originalNow = Date.now;
  const nowTs = originalNow() + 1_000_000;
  Date.now = () => nowTs;

  try {
    await connect({
      params: { accountId: 'Primary', clientId: 'client-a' },
      respond() {},
      client: { connId: 'conn-a' },
      context: { broadcastToConnIds() {} },
    });
    await connect({
      params: { accountId: 'Primary', clientId: 'client-b' },
      respond() {},
      client: { connId: 'conn-b' },
      context: { broadcastToConnIds() {} },
    });

    const bridge = globalThis.__bncrBridge;
    const staleKey = 'Primary::client-a';
    const liveKey = 'Primary::client-b';
    const staleConn = bridge.connections.get(staleKey);
    staleConn.lastSeenAt = nowTs - 300_000;
    bridge.connections.set(staleKey, staleConn);
    const liveConn = bridge.connections.get(liveKey);
    liveConn.lastSeenAt = nowTs - 1_000;
    liveConn.outboundReadyUntil = nowTs + 30_000;
    bridge.connections.set(liveKey, liveConn);
    bridge.activeConnectionByAccount.set('Primary', staleKey);

    bridge.gcTransientState();
    assert.equal(
      bridge.connections.has(staleKey),
      false,
      'stale active owner should be deleted by GC',
    );
    assert.equal(
      bridge.activeConnectionByAccount.has('Primary'),
      false,
      'stale active pointer should be cleared',
    );

    const owner = bridge.resolveOutboxPushOwner('Primary');
    assert.ok(owner, 'expected live owner after stale active pointer cleanup');
    assert.equal(owner.clientId, 'client-b');
    assert.equal(bridge.activeConnectionByAccount.get('Primary'), liveKey);
  } finally {
    Date.now = originalNow;
  }
});
