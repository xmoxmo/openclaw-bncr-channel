import assert from 'node:assert/strict';
import test from 'node:test';
import { getRevalidatedAttemptReason } from '../../src/core/connection-reachability.ts';
import { cleanupBridge, createBridge, makeEntry } from '../helpers/bncr-bridge.mjs';

test('active preferred owner remains sticky until outbound evidence demotes it', async () => {
  const bridge = createBridge();

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      outboundFailureCount: 3,
      lastOutboundFailureAt: nowTs - 5_000,
      lastOutboundFailureKind: 'ack-timeout',
      lastAckOkAt: nowTs - 30_000,
      lastPushTimeoutAt: nowTs - 5_000,
    });
    bridge.connections.set('Primary::client-b', {
      accountId: 'Primary',
      connId: 'conn-b',
      clientId: 'client-b',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      outboundFailureCount: 0,
      lastAckOkAt: nowTs - 1_000,
      lastPushTimeoutAt: 0,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary::client-a');

    const owner = bridge.resolveOutboxPushOwner('Primary');
    const connIds = Array.from(bridge.resolvePushConnIds('Primary'));

    assert.equal(owner?.connId, 'conn-a');
    assert.ok(connIds.includes('conn-a'));
  } finally {
    cleanupBridge(bridge);
  }
});

test('route candidate scoring treats invalid outbound health numbers as neutral', async () => {
  const bridge = createBridge();

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-bad', {
      accountId: 'Primary',
      connId: 'conn-bad',
      clientId: 'client-bad',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: 'not-a-number',
      preferredForOutboundUntil: 'not-a-number',
      outboundFailureCount: 'not-a-number',
      lastOutboundFailureAt: 'not-a-number',
      lastOutboundFailureKind: 'not-a-number',
      lastAckOkAt: 'not-a-number',
      lastPushTimeoutAt: 'not-a-number',
    });
    bridge.connections.set('Primary::client-good', {
      accountId: 'Primary',
      connId: 'conn-good',
      clientId: 'client-good',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      outboundFailureCount: 0,
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

test('diagnostics exposes outbound health details per connection', async () => {
  const bridge = createBridge();

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      outboundFailureCount: 2,
      lastOutboundFailureAt: nowTs - 4_000,
      lastOutboundFailureKind: 'ack-timeout',
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

test('markSeen preserves capability and outbound health state', async () => {
  const bridge = createBridge();
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
      outboundFailureCount: 2,
      lastOutboundFailureAt: nowTs - 7_000,
      lastOutboundFailureKind: 'ack-timeout',
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary::client-a');

    bridge.markSeen('Primary', 'conn-a', 'client-a');
    const conn = bridge.connections.get('Primary::client-a');
    assert.equal(conn.outboundReadyUntil > nowTs, true);
    assert.equal(conn.preferredForOutboundUntil > nowTs, true);
    assert.equal(conn.inboundOnly, true);
    assert.equal(conn.lastAckOkAt > 0, true);
    assert.equal(conn.lastPushTimeoutAt > 0, true);
    assert.equal(conn.outboundFailureCount, 2);
    assert.equal(conn.lastOutboundFailureKind, 'ack-timeout');
  } finally {
    cleanupBridge(bridge);
  }
});

test('reconnect with a new connId starts fresh outbound health evidence', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-old',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 2_000,
      lastAckOkAt: nowTs - 3_000,
      lastPushTimeoutAt: nowTs - 2_500,
      outboundFailureCount: 4,
      lastOutboundFailureAt: nowTs - 2_500,
      lastOutboundFailureKind: 'ack-timeout',
    });

    bridge.markSeen('Primary', 'conn-new', 'client-a');
    const conn = bridge.connections.get('Primary::client-a');
    assert.equal(conn.connId, 'conn-new');
    assert.equal(conn.connectedAt >= nowTs, true);
    assert.equal(conn.lastAckOkAt, undefined);
    assert.equal(conn.lastPushTimeoutAt, undefined);
    assert.equal(conn.outboundFailureCount, undefined);
    assert.equal(conn.lastOutboundFailureKind, undefined);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck success resets connection outbound failure health', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundFailureCount: 3,
      lastPushTimeoutAt: nowTs - 2_000,
      lastOutboundFailureAt: nowTs - 2_000,
      lastOutboundFailureKind: 'ack-timeout',
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
    assert.equal(conn.outboundFailureCount, 0);
    assert.equal(conn.lastAckOkAt > 0, true);
    assert.equal(conn.lastPushTimeoutAt, undefined);
    assert.equal(conn.lastOutboundFailureKind, undefined);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck success treats invalid entry createdAt as zero queue latency', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
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

test('ack timeout records bounded connection health and keeps the sole live route', async () => {
  const logs = [];
  const bridge = createBridge();
  const originalLogInfo = bridge.logInfo.bind(bridge);
  bridge.logInfo = (scope, message, options) => {
    logs.push({ scope, message, options });
    return originalLogInfo(scope, message, options);
  };
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
      outboundFailureCount: 0,
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
    const conn = bridge.connections.get('Primary::client-a');
    assert.equal(conn.outboundFailureCount, 1);
    assert.equal(conn.lastOutboundFailureKind, 'ack-timeout');
    assert.equal(Number(conn.lastPushTimeoutAt || 0) > 0, true);
    assert.equal(Number(conn.outboundReadyUntil || 0) > 0, true);
    assert.equal(Number(conn.preferredForOutboundUntil || 0) > 0, true);
  } finally {
    bridge.logInfo = originalLogInfo;
    cleanupBridge(bridge);
  }
});

test('outbound dispatch commits the selected owner only after one-target broadcast succeeds', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
    });
    bridge.connections.set('Primary::client-b', {
      accountId: 'Primary',
      connId: 'conn-b',
      clientId: 'client-b',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 2_000,
    });
    bridge.activeConnectionByAccount.clear();
    const targets = [];
    bridge.gatewayContext = {
      broadcastToConnIds(_event, _payload, connIds) {
        targets.push(Array.from(connIds));
      },
    };

    const entry = makeEntry('msg-commit-owner', 'commit owner');
    assert.equal(await bridge.tryPushEntry(entry), true);
    assert.deepEqual(targets, [['conn-a']]);
    assert.equal(bridge.activeConnectionByAccount.get('Primary'), 'Primary::client-a');
  } finally {
    cleanupBridge(bridge);
  }
});

test('broadcast failure updates outbound health without committing the owner', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
    });
    bridge.connections.set('Primary::client-b', {
      accountId: 'Primary',
      connId: 'conn-b',
      clientId: 'client-b',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 60_000,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary::client-a');
    bridge.gatewayContext = {
      broadcastToConnIds() {
        throw new Error('broadcast socket disconnected');
      },
    };

    const entry = makeEntry('msg-broadcast-failure', 'broadcast failure');
    assert.equal(await bridge.tryPushEntry(entry), false);
    const conn = bridge.connections.get('Primary::client-a');
    assert.equal(conn.outboundFailureCount, 1);
    assert.equal(conn.lastOutboundFailureKind, 'broadcast-failure');
    assert.equal(conn.outboundReadyUntil, undefined);
    assert.equal(conn.preferredForOutboundUntil, undefined);
    assert.equal(bridge.resolveOutboxPushOwner('Primary')?.connId, 'conn-b');
  } finally {
    cleanupBridge(bridge);
  }
});

test('business errors are classified without poisoning connection health', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
    });
    bridge.activeConnectionByAccount.clear();
    bridge.gatewayContext = {
      broadcastToConnIds() {
        throw new Error('business rejected');
      },
    };

    const entry = makeEntry('msg-business-failure', 'business failure');
    assert.equal(await bridge.tryPushEntry(entry), false);
    const conn = bridge.connections.get('Primary::client-a');
    assert.equal(conn.outboundFailureCount || 0, 0);
    assert.equal(conn.lastOutboundFailureKind, undefined);
  } finally {
    cleanupBridge(bridge);
  }
});

test('business errors do not degrade outbound capability when an alternative connection exists', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary::client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
    });
    bridge.connections.set('Primary::client-b', {
      accountId: 'Primary',
      connId: 'conn-b',
      clientId: 'client-b',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary::client-a');

    bridge.recordOutboundFailure({
      accountId: 'Primary',
      connIds: ['conn-a'],
      kind: 'business-error',
    });

    const conn = bridge.connections.get('Primary::client-a');
    assert.equal(conn.outboundFailureCount || 0, 0);
    assert.equal(conn.lastOutboundFailureKind, undefined);
    assert.ok(conn.outboundReadyUntil > nowTs);
    assert.ok(conn.preferredForOutboundUntil > nowTs);
    assert.equal(bridge.resolveOutboxPushOwner('Primary')?.connId, 'conn-a');
  } finally {
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
