import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from '../helpers/bncr-bridge.mjs';

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

test('stale non-owner ack keeps waiter pending and leaves outbox entry intact', async () => {
  const bridge = createBridge();

  try {
    const entry = makeEntry('msg-stale-non-owner', 'stale should not win');
    entry.lastPushConnId = 'conn-owner';
    entry.lastPushClientId = 'client-owner';
    bridge.outbox.set(entry.messageId, entry);

    const waiter = bridge.waitForMessageAck('msg-stale-non-owner', 40);
    const originalObserveLease = bridge.observeLease.bind(bridge);
    bridge.observeLease = (...args) => ({ ...originalObserveLease(...args), stale: true });

    let respondPayload = null;
    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-stale-non-owner',
        ok: true,
        clientId: 'client-intruder',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-intruder' },
      context: null,
    });

    const waiterResult = await waiter;
    assert.deepEqual(respondPayload, {
      ok: true,
      payload: { ok: true, stale: true, ignored: true },
    });
    assert.equal(waiterResult, 'timeout');
    assert.equal(bridge.outbox.has('msg-stale-non-owner'), true);
    assert.equal(bridge.messageAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('ok ack is accepted again after retryable entry is pushed again', async () => {
  const bridge = createBridge();

  try {
    const entry = makeEntry('msg-ack-retry-repush', 'retry then repush then ok');
    entry.lastPushConnId = 'conn-1';
    entry.lastPushClientId = 'client-1';
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retry-repush',
        ok: false,
        error: 'retry-first',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    const retried = bridge.outbox.get('msg-ack-retry-repush');
    assert.ok(retried);
    assert.equal(retried.awaitingRetryPush, true);

    bridge.recordOutboxPushSuccess({
      entry: retried,
      connIds: ['conn-2'],
      ownerConnId: 'conn-2',
      ownerClientId: 'client-2',
      clearLastError: false,
    });

    let respondPayload = null;
    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retry-repush',
        ok: true,
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-2' },
      context: null,
    });

    assert.equal(bridge.outbox.has('msg-ack-retry-repush'), false);
    assert.deepEqual(respondPayload, { ok: true, payload: { ok: true } });
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleActivity flushes queued outbound for the same account', async () => {
  const bridge = createBridge();
  const spy = spyFlushPushQueue(bridge);

  try {
    await bridge.handleActivity({
      params: { accountId: 'Primary', clientId: 'client-1' },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(spy.calls, [
      { accountId: 'Primary', trigger: 'activity', reason: 'activity-heartbeat' },
    ]);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});

test('handleInbound flushes queued outbound for the same account before async dispatch', async () => {
  const bridge = createBridge();
  const spy = spyFlushPushQueue(bridge);

  try {
    await bridge.handleInbound({
      params: {
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        type: 'text',
        msg: 'hello inbound',
        msgId: 'inbound-1',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(spy.calls, [
      { accountId: 'Primary', trigger: 'inbound', reason: 'inbound-accepted' },
    ]);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});

test('push path does not depend on recent inbound helper fallback', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
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
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
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
        userId: '10001',
        type: 'text',
        msg: 'hello',
        msgId: 'inbound-keep-inboundOnly',
      },
      respond() {},
      client: { connId: 'conn-a' },
      context: null,
    });
    const conn = bridge.connections.get('Primary:client-a');
    assert.equal(conn.inboundOnly, true);
  } finally {
    cleanupBridge(bridge);
  }
});
