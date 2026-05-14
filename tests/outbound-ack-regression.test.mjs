import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridge } from '../src/channel.ts';

function createApiStub() {
  const currentConfig = {};
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {
      config: {
        current() {
          return currentConfig;
        },
        get() {
          return currentConfig;
        },
        async loadConfig() {
          return currentConfig;
        },
      },
      channel: {
        routing: {
          resolveAgentRoute() {
            return { sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion' };
          },
        },
      },
    },
  };
}

function makeEntry(messageId, text = messageId) {
  return {
    messageId,
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route: { platform: 'tgBot', groupId: '-1001', userId: '6278285192' },
    payload: {
      type: 'message.outbound',
      messageId,
      idempotencyKey: messageId,
      sessionKey: 'agent:orion:bncr:direct:demo',
      message: {
        platform: 'tgBot',
        groupId: '-1001',
        userId: '6278285192',
        type: 'text',
        msg: text,
        path: '',
        base64: '',
        fileName: '',
      },
      ts: Date.now(),
    },
    createdAt: Date.now(),
    retryCount: 0,
    nextAttemptAt: Date.now(),
  };
}

function cleanupBridge(bridge) {
  if (bridge.saveTimer) clearTimeout(bridge.saveTimer);
  if (bridge.pushTimer) clearTimeout(bridge.pushTimer);

  for (const waiter of bridge.messageAckWaiters?.values?.() || []) {
    clearTimeout(waiter.timer);
  }
  bridge.messageAckWaiters?.clear?.();
}

function spyFlushPushQueue(bridge) {
  const calls = [];
  const original = bridge.flushPushQueue.bind(bridge);
  bridge.flushPushQueue = (args) => {
    calls.push(args);
    return Promise.resolve();
  };
  return {
    calls,
    restore() {
      bridge.flushPushQueue = original;
    },
  };
}

test('enqueueOutbound does not wake another message ack waiter on the same account', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const waiter = bridge.waitForMessageAck('msg-1', 40);
    bridge.enqueueOutbound(makeEntry('msg-2', 'second message'));

    const result = await waiter;
    assert.equal(result, 'timeout');
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck resolves only the matching message ack waiter', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const entry1 = makeEntry('msg-1', 'first');
    const entry2 = makeEntry('msg-2', 'second');
    bridge.outbox.set(entry1.messageId, entry1);
    bridge.outbox.set(entry2.messageId, entry2);

    const waiter1 = bridge.waitForMessageAck('msg-1', 200);
    const waiter2 = bridge.waitForMessageAck('msg-2', 40);

    let respondPayload = null;
    await bridge.handleAck({
      params: { accountId: 'Primary', messageId: 'msg-1', ok: true },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(respondPayload, { ok: true, payload: { ok: true } });
    assert.equal(await waiter1, 'acked');
    assert.equal(await waiter2, 'timeout');
    assert.equal(bridge.outbox.has('msg-1'), false);
    assert.equal(bridge.outbox.has('msg-2'), true);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck success flushes queued outbound for the same account', async () => {
  const bridge = createBncrBridge(createApiStub());
  const spy = spyFlushPushQueue(bridge);

  try {
    const entry = makeEntry('msg-ack-flush', 'ack flush');
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: { accountId: 'Primary', messageId: 'msg-ack-flush', ok: true },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(spy.calls, [{ accountId: 'Primary', trigger: 'ack-ok', reason: 'message-acked' }]);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});

test('handleActivity flushes queued outbound for the same account', async () => {
  const bridge = createBncrBridge(createApiStub());
  const spy = spyFlushPushQueue(bridge);

  try {
    await bridge.handleActivity({
      params: { accountId: 'Primary', clientId: 'client-1' },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(spy.calls, [{ accountId: 'Primary', trigger: 'activity', reason: 'activity-heartbeat' }]);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});

test('handleInbound flushes queued outbound for the same account before async dispatch', async () => {
  const bridge = createBncrBridge(createApiStub());
  const spy = spyFlushPushQueue(bridge);

  try {
    await bridge.handleInbound({
      params: {
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '6278285192',
        type: 'text',
        msg: 'hello inbound',
        msgId: 'inbound-1',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(spy.calls, [{ accountId: 'Primary', trigger: 'inbound', reason: 'inbound-accepted' }]);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});


test('reputation sorting prefers lower failure score and fresher ack', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      pushFailureScore: 3,
      lastAckOkAt: nowTs - 30_000,
      lastPushTimeoutAt: nowTs - 5_000,
    });
    bridge.connections.set('Primary:client-b', {
      accountId: 'Primary',
      connId: 'conn-b',
      clientId: 'client-b',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      pushFailureScore: 0,
      lastAckOkAt: nowTs - 1_000,
      lastPushTimeoutAt: 0,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');

    const owner = bridge.resolveOutboxPushOwner('Primary');
    const connIds = Array.from(bridge.resolvePushConnIds('Primary'));

    assert.equal(owner?.connId, 'conn-b');
    assert.equal(connIds[0], 'conn-b');
  } finally {
    cleanupBridge(bridge);
  }
});

test('diagnostics exposes reputation details per connection', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      pushFailureScore: 2,
      lastAckOkAt: nowTs - 3_000,
      lastPushTimeoutAt: nowTs - 2_000,
    });

    const diagnostics = bridge.buildExtendedDiagnostics('Primary');
    assert.ok(Array.isArray(diagnostics.connection.reputation));
    assert.equal(diagnostics.connection.reputation.length, 1);
    assert.equal(diagnostics.connection.reputation[0].connId, 'conn-a');
    assert.equal(diagnostics.connection.reputation[0].pushFailureScore, 2);
    assert.equal(typeof diagnostics.connection.reputation[0].tier, 'string');
    assert.equal(diagnostics.connection.reputation[0].lastAckOkAt > 0, true);
    assert.equal(diagnostics.connection.reputation[0].lastPushTimeoutAt > 0, true);
  } finally {
    cleanupBridge(bridge);
  }
});


test('markSeen preserves capability and reputation state', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 10_000,
      inboundOnly: true,
      lastAckOkAt: nowTs - 5_000,
      lastPushTimeoutAt: nowTs - 7_000,
      pushFailureScore: 2,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary::client-a');

    bridge.markSeen('Primary', 'conn-a', 'client-a');
    const conn = bridge.connections.get('Primary::client-a');
    assert.equal(conn.outboundReadyUntil > nowTs, true);
    assert.equal(conn.preferredForOutboundUntil > nowTs, true);
    assert.equal(conn.inboundOnly, true);
    assert.equal(conn.lastAckOkAt > 0, true);
    assert.equal(conn.lastPushTimeoutAt > 0, true);
    assert.equal(conn.pushFailureScore, 2);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck success clears failure score and refreshes lastAckOkAt', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      pushFailureScore: 3,
      lastPushTimeoutAt: nowTs - 2_000,
    });
    const entry = makeEntry('msg-ack-rep', 'ack rep');
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: { accountId: 'Primary', clientId: 'client-a', messageId: 'msg-ack-rep', ok: true },
      respond() {},
      client: { connId: 'conn-a' },
      context: null,
    });

    const conn = bridge.connections.get('Primary::client-a');
    assert.equal(conn.pushFailureScore, 0);
    assert.equal(conn.lastAckOkAt > 0, true);
  } finally {
    cleanupBridge(bridge);
  }
});

test('ack timeout increments failure score and degrades capability', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 10_000,
      pushFailureScore: 0,
    });
    bridge.gatewayContext = { broadcastToConnIds() {} };
    const entry = makeEntry('msg-timeout', 'timeout rep');
    entry.lastPushConnId = 'conn-a';
    entry.lastPushClientId = 'client-a';
    bridge.outbox.set(entry.messageId, entry);
    bridge.tryPushEntry = async () => true;
    bridge.waitForMessageAck = async () => 'timeout';
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => true;
    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'timeout' });
    const conn = bridge.connections.get('Primary::client-a');
    assert.equal(conn.pushFailureScore, 1);
    assert.equal(Number(conn.lastPushTimeoutAt || 0) > 0, true);
    assert.equal(Number(conn.outboundReadyUntil || 0), 0);
    assert.equal(Number(conn.preferredForOutboundUntil || 0), 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('file transfer adopt only allows current outbound owner', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::owner', {
      accountId: 'Primary', connId: 'conn-owner', clientId: 'owner', connectedAt: nowTs - 10_000, lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 30_000, preferredForOutboundUntil: nowTs + 10_000,
    });
    bridge.connections.set('Primary::other', {
      accountId: 'Primary', connId: 'conn-other', clientId: 'other', connectedAt: nowTs - 20_000, lastSeenAt: nowTs - 500,
      outboundReadyUntil: nowTs + 30_000, preferredForOutboundUntil: 0,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary::owner');
    const transfer = { ownerConnId: undefined, ownerClientId: undefined };
    assert.equal(bridge.tryAdoptTransferOwner({ accountId: 'Primary', transfer, connId: 'conn-other', clientId: 'other' }), false);
    assert.equal(bridge.tryAdoptTransferOwner({ accountId: 'Primary', transfer, connId: 'conn-owner', clientId: 'owner' }), true);
    assert.equal(transfer.ownerConnId, 'conn-owner');
  } finally {
    cleanupBridge(bridge);
  }
});


test('push path does not depend on recent inbound helper fallback', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: 0,
      preferredForOutboundUntil: 0,
      inboundOnly: false,
    });
    bridge.lastInboundByAccount.set('Primary', nowTs - 500);
    let broadcastCalls = 0;
    bridge.gatewayContext = {
      broadcastToConnIds() {
        broadcastCalls += 1;
      },
    };

    const entry = makeEntry('msg-no-recent-inbound', 'no recent inbound fallback');
    bridge.outbox.set(entry.messageId, entry);

    const pushed = await bridge.tryPushEntry(entry);
    assert.equal(pushed, true);
    assert.equal(broadcastCalls, 1);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleInbound does not force inboundOnly false', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      inboundOnly: true,
    });
    await bridge.handleInbound({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '6278285192',
        type: 'text',
        msg: 'hello',
        msgId: 'inbound-keep-inboundOnly',
      },
      respond() {},
      client: { connId: 'conn-a' },
      context: null,
    });
    const conn = bridge.connections.get('Primary::client-a');
    assert.equal(conn.inboundOnly, true);
  } finally {
    cleanupBridge(bridge);
  }
});


test('resolvePushConnIds currently falls back to ttl-live non-inboundOnly connections even without outbound capability', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: 0,
      preferredForOutboundUntil: 0,
      inboundOnly: false,
    });

    const owner = bridge.resolveOutboxPushOwner('Primary');
    const connIds = Array.from(bridge.resolvePushConnIds('Primary'));

    assert.equal(owner?.connId, 'conn-a');
    assert.deepEqual(connIds, ['conn-a']);
  } finally {
    cleanupBridge(bridge);
  }
});
