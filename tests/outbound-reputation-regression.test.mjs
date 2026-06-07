import assert from 'node:assert/strict';
import test from 'node:test';
import { getRevalidatedAttemptReason } from '../src/core/connection-reachability.ts';
import { cleanupBridge, createBridge, makeEntry } from './helpers/bncr-bridge.mjs';

test('reputation sorting prefers lower failure score and fresher ack', async () => {
  const bridge = createBridge();

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

    assert.equal(owner?.connId, 'conn-a');
    assert.ok(connIds.includes('conn-a'));
  } finally {
    cleanupBridge(bridge);
  }
});

test('route candidate scoring treats invalid reputation numbers as neutral', async () => {
  const bridge = createBridge();

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-bad', {
      accountId: 'Primary',
      connId: 'conn-bad',
      clientId: 'client-bad',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: 'not-a-number',
      preferredForOutboundUntil: 'not-a-number',
      pushFailureScore: 'not-a-number',
      lastAckOkAt: 'not-a-number',
      lastPushTimeoutAt: 'not-a-number',
    });
    bridge.connections.set('Primary:client-good', {
      accountId: 'Primary',
      connId: 'conn-good',
      clientId: 'client-good',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      pushFailureScore: 0,
      lastAckOkAt: nowTs - 1_000,
      lastPushTimeoutAt: 0,
    });

    const connIds = Array.from(bridge.resolvePushConnIds('Primary'));

    assert.equal(connIds[0], 'conn-good');
    assert.ok(connIds.includes('conn-bad'));
  } finally {
    cleanupBridge(bridge);
  }
});

test('diagnostics exposes reputation details per connection', async () => {
  const bridge = createBridge();

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
    assert.ok(diagnostics.connection);
    assert.equal(diagnostics.connection.active > 0, true);
  } finally {
    cleanupBridge(bridge);
  }
});

test('markSeen preserves capability and reputation state', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
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
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');

    bridge.markSeen('Primary', 'conn-a', 'client-a');
    const conn = bridge.connections.get('Primary:client-a');
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
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
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

    const conn = bridge.connections.get('Primary:client-a');
    assert.equal(conn.pushFailureScore, 3);
    assert.equal(conn.lastAckOkAt > 0, false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck success treats invalid entry createdAt as zero queue latency', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
    });
    const entry = makeEntry('msg-invalid-created-at-ack', 'ack invalid createdAt');
    entry.createdAt = 'not-a-number';
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: { accountId: 'Primary', clientId: 'client-a', messageId: entry.messageId, ok: true },
      respond() {},
      client: { connId: 'conn-a' },
      context: null,
    });

    assert.equal(bridge.lastAckQueueLatencyMsByAccount.get('Primary'), 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('ack timeout increments failure score and degrades capability', async () => {
  const logs = [];
  const bridge = createBridge();
  const originalLogInfo = bridge.logInfo.bind(bridge);
  bridge.logInfo = (scope, message, options) => {
    logs.push({ scope, message, options });
    return originalLogInfo(scope, message, options);
  };
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
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
    bridge.ackTimeoutCountByAccount.set('Primary', 1);
    bridge.lateAckOkCountByAccount.set('Primary', 1);
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);
    bridge.tryPushEntry = async () => true;
    let observedWaitMs = null;
    bridge.waitForMessageAck = async (_messageId, waitMs) => {
      observedWaitMs = waitMs;
      return 'timeout';
    };
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => true;
    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'timeout' });
    assert.equal(observedWaitMs, 60000);
    const timeoutSummary = logs.find((item) => item.scope === 'outbox ack timeout');
    assert.ok(timeoutSummary);
    assert.match(timeoutSummary.message, /waitMs=60000/);
    const ackDebug = logs.find(
      (item) => item.scope === 'outbox' && item.message.startsWith('ack '),
    );
    assert.ok(ackDebug);
    assert.match(ackDebug.message, /"ackTimeoutMs":60000/);
    assert.match(ackDebug.message, /"adaptiveAckTimeoutEnabled":true/);
    const conn = bridge.connections.get('Primary:client-a');
    assert.equal(conn.pushFailureScore, 0);
    assert.equal(Number(conn.outboundReadyUntil || 0) > 0, true);
    assert.equal(Number(conn.preferredForOutboundUntil || 0) > 0, true);
  } finally {
    bridge.logInfo = originalLogInfo;
    cleanupBridge(bridge);
  }
});

test('getRevalidatedAttemptReason treats invalid numeric fields as stale', () => {
  const nowTs = Date.now();
  const entry = makeEntry('msg-invalid-revalidate', 'invalid revalidate');
  entry.lastAttemptAt = 'not-a-number';

  const result = getRevalidatedAttemptReason({
    entry,
    connId: 'conn-bad',
    accountId: 'Primary',
    now: nowTs,
    connectTtlMs: 30_000,
    recentInboundReachable: true,
    connections: [
      {
        accountId: 'Primary',
        connId: 'conn-bad',
        clientId: 'client-bad',
        connectedAt: nowTs - 10_000,
        lastSeenAt: nowTs - 1_000,
        preferredForOutboundUntil: 'not-a-number',
        outboundReadyUntil: 'not-a-number',
        lastAckOkAt: 'not-a-number',
        lastPushTimeoutAt: 'not-a-number',
      },
    ],
  });

  assert.equal(result, null);
});
