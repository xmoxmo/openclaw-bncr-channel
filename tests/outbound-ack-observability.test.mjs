import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge, makeEntry } from './helpers/bncr-bridge.mjs';

test('late ok ack after retryable ack clears the queue and records slow-ack observability', async () => {
  const logs = [];
  const bridge = createBridge();
  const originalLogInfo = bridge.logInfo.bind(bridge);
  bridge.logInfo = (scope, message, options) => {
    logs.push({ scope, message, options });
    return originalLogInfo(scope, message, options);
  };

  try {
    const entry = makeEntry('msg-ack-retry-late', 'retry then late ok');
    entry.createdAt = Math.max(0, entry.createdAt - 8000);
    entry.lastPushAt = entry.createdAt + 2000;
    entry.lastPushConnId = 'conn-1';
    entry.lastPushClientId = 'client-1';
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retry-late',
        ok: false,
        error: 'retry-first',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    let respondPayload = null;
    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retry-late',
        ok: true,
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(bridge.outbox.has('msg-ack-retry-late'), false);
    assert.deepEqual(respondPayload, { ok: true, payload: { ok: true } });
    assert.equal(bridge.getCounter(bridge.lateAckOkCountByAccount, 'Primary'), 1);
    assert.ok(bridge.lastLateAckOkByAccount.get('Primary'));
    assert.ok(bridge.lastAckOkByAccount.get('Primary'));
    assert.ok((bridge.lastAckQueueLatencyMsByAccount.get('Primary') || 0) >= 8000);
    assert.ok((bridge.lastAckPushLatencyMsByAccount.get('Primary') || 0) >= 6000);
    assert.equal(
      bridge.lastLateAckQueueLatencyMsByAccount.get('Primary'),
      bridge.lastAckQueueLatencyMsByAccount.get('Primary'),
    );
    assert.equal(
      bridge.lastLateAckPushLatencyMsByAccount.get('Primary'),
      bridge.lastAckPushLatencyMsByAccount.get('Primary'),
    );
    const lateAckLog = logs.find((item) => item.scope === 'outbox ack ok late');
    assert.ok(lateAckLog);
    assert.match(lateAckLog.message, /queueMs=\d+/);
    assert.match(lateAckLog.message, /pushMs=\d+/);
  } finally {
    bridge.logInfo = originalLogInfo;
    cleanupBridge(bridge);
  }
});

test('runtime snapshot exposes ack latency observability for status surfaces', async () => {
  const bridge = createBridge();

  try {
    bridge.lastAckQueueLatencyMsByAccount.set('Primary', 1234);
    bridge.lastAckPushLatencyMsByAccount.set('Primary', 567);
    bridge.lastLateAckQueueLatencyMsByAccount.set('Primary', 4321);
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 765);

    const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

    assert.equal(snapshot.ackObservability.lastAckQueueLatencyMs, 1234);
    assert.equal(snapshot.ackObservability.lastAckPushLatencyMs, 567);
    assert.equal(snapshot.ackObservability.lastLateAckQueueLatencyMs, 4321);
    assert.equal(snapshot.ackObservability.lastLateAckPushLatencyMs, 765);
    assert.equal(snapshot.ackObservability.currentAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutReason, 'no-timeout-evidence');
    assert.deepEqual(snapshot.ackStrategy, {
      mode: 'adaptive',
      currentMs: 30000,
      defaultMs: 30000,
      maxMs: 90000,
      reason: 'no-timeout-evidence',
      active: false,
      lastLateAckAgeMs: null,
      lateAckObservationTtlMs: 3600000,
      recovered: false,
    });
    assert.deepEqual(snapshot.meta.ackObservability, snapshot.ackObservability);
    assert.deepEqual(snapshot.diagnostics.ackObservability, snapshot.ackObservability);
    assert.deepEqual(snapshot.meta.diagnostics.ackObservability, snapshot.ackObservability);
    assert.deepEqual(snapshot.meta.ackStrategy, snapshot.ackStrategy);
    assert.deepEqual(snapshot.diagnostics.ackStrategy, snapshot.ackStrategy);
    assert.deepEqual(snapshot.meta.diagnostics.ackStrategy, snapshot.ackStrategy);
  } finally {
    cleanupBridge(bridge);
  }
});

test('runtime ack strategy falls back when observability timeouts are invalid', async () => {
  const bridge = createBridge();

  try {
    bridge.buildAckObservability = () => ({
      adaptiveAckTimeoutEnabled: true,
      currentAckTimeoutMs: 'not-a-number',
      defaultAckTimeoutMs: 'not-a-number',
      recommendedAckTimeoutReason: 'invalid-test',
      lastLateAckAgeMs: null,
      lateAckObservationTtlMs: 3_600_000,
      adaptiveAckRecovered: false,
    });

    const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

    assert.equal(snapshot.ackStrategy.currentMs, 30000);
    assert.equal(snapshot.ackStrategy.defaultMs, 30000);
    assert.equal(snapshot.ackStrategy.active, false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('adaptive ack timeout matrix locks reasons and effective timeout bounds', async () => {
  const bridge = createBridge();

  try {
    const nowMs = Date.now();
    const cases = [
      {
        name: 'no timeout evidence',
        setup() {},
        timeoutMs: 30000,
        reason: 'no-timeout-evidence',
        active: false,
      },
      {
        name: 'no late ack evidence',
        setup() {
          bridge.ackTimeoutCountByAccount.set('Primary', 1);
        },
        timeoutMs: 30000,
        reason: 'no-late-ack-evidence',
        active: false,
      },
      {
        name: 'missing latency',
        setup() {
          bridge.ackTimeoutCountByAccount.set('Primary', 1);
          bridge.lateAckOkCountByAccount.set('Primary', 1);
          bridge.lastLateAckOkByAccount.set('Primary', nowMs);
        },
        timeoutMs: 30000,
        reason: 'missing-latency',
        active: false,
      },
      {
        name: 'late ack observed',
        setup() {
          bridge.ackTimeoutCountByAccount.set('Primary', 1);
          bridge.lateAckOkCountByAccount.set('Primary', 1);
          bridge.lastLateAckOkByAccount.set('Primary', nowMs);
          bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);
        },
        timeoutMs: 60000,
        reason: 'late-ack-observed',
        active: true,
      },
      {
        name: 'capped max',
        setup() {
          bridge.ackTimeoutCountByAccount.set('Primary', 1);
          bridge.lateAckOkCountByAccount.set('Primary', 1);
          bridge.lastLateAckOkByAccount.set('Primary', nowMs);
          bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 120000);
        },
        timeoutMs: 90000,
        reason: 'capped-max',
        active: true,
      },
      {
        name: 'late ack expired',
        setup() {
          bridge.ackTimeoutCountByAccount.set('Primary', 1);
          bridge.lateAckOkCountByAccount.set('Primary', 1);
          bridge.lastLateAckOkByAccount.set('Primary', nowMs - 3_700_000);
          bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);
        },
        timeoutMs: 30000,
        reason: 'late-ack-expired',
        active: false,
        expired: true,
      },
      {
        name: 'recovered',
        setup() {
          bridge.ackTimeoutCountByAccount.set('Primary', 1);
          bridge.lateAckOkCountByAccount.set('Primary', 1);
          bridge.lastLateAckOkByAccount.set('Primary', nowMs);
          bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);
          bridge.adaptiveAckRecoveryOkCountByAccount.set('Primary', 3);
        },
        timeoutMs: 30000,
        reason: 'recovered',
        active: false,
        recovered: true,
      },
    ];

    for (const item of cases) {
      bridge.ackTimeoutCountByAccount.clear();
      bridge.lateAckOkCountByAccount.clear();
      bridge.lastLateAckOkByAccount.clear();
      bridge.lastLateAckPushLatencyMsByAccount.clear();
      bridge.adaptiveAckRecoveryOkCountByAccount.clear();
      bridge.adaptiveAckTimeoutLogStateByAccount.clear();

      item.setup();
      const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

      assert.equal(snapshot.ackObservability.currentAckTimeoutMs, item.timeoutMs, item.name);
      assert.equal(snapshot.ackObservability.recommendedAckTimeoutMs, item.timeoutMs, item.name);
      assert.equal(snapshot.ackObservability.recommendedAckTimeoutReason, item.reason, item.name);
      assert.equal(snapshot.ackObservability.defaultAckTimeoutMs, 30000, item.name);
      assert.equal(snapshot.ackObservability.adaptiveAckTimeoutEnabled, true, item.name);
      assert.equal(
        snapshot.ackObservability.lateAckObservationExpired,
        item.expired === true,
        item.name,
      );
      assert.equal(
        snapshot.ackObservability.adaptiveAckRecovered,
        item.recovered === true,
        item.name,
      );
      assert.equal(snapshot.ackStrategy.currentMs, item.timeoutMs, item.name);
      assert.equal(snapshot.ackStrategy.defaultMs, 30000, item.name);
      assert.equal(snapshot.ackStrategy.maxMs, 90000, item.name);
      assert.equal(snapshot.ackStrategy.reason, item.reason, item.name);
      assert.equal(snapshot.ackStrategy.active, item.active, item.name);
      assert.equal(snapshot.ackStrategy.recovered, item.recovered === true, item.name);
      assert.equal(bridge.resolveMessageAckTimeoutMs('Primary'), item.timeoutMs, item.name);
      assert.equal(
        bridge.buildRuntimeFlags('Primary').messageAckTimeoutMs,
        item.timeoutMs,
        item.name,
      );
    }
  } finally {
    cleanupBridge(bridge);
  }
});

test('ack observability recommends a conservative timeout when late ack follows timeout', async () => {
  const bridge = createBridge();

  try {
    bridge.ackTimeoutCountByAccount.set('Primary', 2);
    bridge.lateAckOkCountByAccount.set('Primary', 1);
    bridge.lastLateAckOkByAccount.set('Primary', Date.now());
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);

    const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

    assert.equal(snapshot.ackObservability.adaptiveAckTimeoutEnabled, true);
    assert.equal(snapshot.ackObservability.defaultAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.currentAckTimeoutMs, 60000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutMs, 60000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutReason, 'late-ack-observed');
    assert.equal(snapshot.ackObservability.lateAckObservationTtlMs, 3600000);
    assert.equal(snapshot.ackObservability.lateAckObservationExpired, false);
    assert.equal(snapshot.ackStrategy.mode, 'adaptive');
    assert.equal(snapshot.ackStrategy.currentMs, 60000);
    assert.equal(snapshot.ackStrategy.defaultMs, 30000);
    assert.equal(snapshot.ackStrategy.maxMs, 90000);
    assert.equal(snapshot.ackStrategy.reason, 'late-ack-observed');
    assert.equal(snapshot.ackStrategy.active, true);
    assert.equal(snapshot.ackStrategy.lateAckObservationTtlMs, 3600000);
    assert.equal(snapshot.ackStrategy.recovered, false);
    assert.equal(bridge.resolveMessageAckTimeoutMs('Primary'), 60000);
    assert.equal(bridge.buildRuntimeFlags('Primary').messageAckTimeoutMs, 60000);
    assert.equal(bridge.buildRuntimeFlags('Primary').adaptiveAckTimeoutEnabled, true);
  } finally {
    cleanupBridge(bridge);
  }
});

test('ack observability recovers to default after consecutive normal ack successes', async () => {
  const bridge = createBridge();

  try {
    bridge.ackTimeoutCountByAccount.set('Primary', 2);
    bridge.lateAckOkCountByAccount.set('Primary', 1);
    bridge.lastLateAckOkByAccount.set('Primary', Date.now());
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);
    bridge.adaptiveAckRecoveryOkCountByAccount.set('Primary', 3);

    const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

    assert.equal(snapshot.ackObservability.currentAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.adaptiveAckRecoveryOkCount, 3);
    assert.equal(snapshot.ackObservability.adaptiveAckRecoveryOkThreshold, 3);
    assert.equal(snapshot.ackObservability.adaptiveAckRecovered, true);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutReason, 'recovered');
    assert.equal(bridge.resolveMessageAckTimeoutMs('Primary'), 30000);
  } finally {
    cleanupBridge(bridge);
  }
});

test('ack observability ignores expired late ack telemetry for adaptive timeout', async () => {
  const bridge = createBridge();

  try {
    bridge.ackTimeoutCountByAccount.set('Primary', 2);
    bridge.lateAckOkCountByAccount.set('Primary', 1);
    bridge.lastLateAckOkByAccount.set('Primary', Date.now() - 3_700_000);
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);

    const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

    assert.equal(snapshot.ackObservability.currentAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.lateAckObservationTtlMs, 3600000);
    assert.equal(snapshot.ackObservability.lateAckObservationExpired, true);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutReason, 'late-ack-expired');
    assert.equal(bridge.resolveMessageAckTimeoutMs('Primary'), 30000);
  } finally {
    cleanupBridge(bridge);
  }
});

test('adaptive ack timeout logs strategy changes with throttle', async () => {
  const logs = [];
  const bridge = createBridge();
  const originalLogInfo = bridge.logInfo.bind(bridge);
  bridge.logInfo = (scope, message, options) => {
    logs.push({ scope, message, options });
    return originalLogInfo(scope, message, options);
  };

  try {
    bridge.ackTimeoutCountByAccount.set('Primary', 2);
    bridge.lateAckOkCountByAccount.set('Primary', 1);
    bridge.lastLateAckOkByAccount.set('Primary', Date.now());
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);

    assert.equal(bridge.resolveMessageAckTimeoutMs('Primary'), 60000);
    assert.equal(bridge.resolveMessageAckTimeoutMs('Primary'), 60000);

    const adaptiveLogs = logs.filter((item) => item.scope === 'outbox ack timeout-adaptive');
    assert.equal(adaptiveLogs.length, 1);
    assert.match(
      adaptiveLogs[0].message,
      /^Primary\|current=60000\|default=30000\|reason=late-ack-observed\|latePushMs=48000$/,
    );
  } finally {
    bridge.logInfo = originalLogInfo;
    cleanupBridge(bridge);
  }
});

test('ack observability reports capped max reason for oversized late ack latency', async () => {
  const bridge = createBridge();

  try {
    bridge.ackTimeoutCountByAccount.set('Primary', 2);
    bridge.lateAckOkCountByAccount.set('Primary', 1);
    bridge.lastLateAckOkByAccount.set('Primary', Date.now());
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 120000);

    const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

    assert.equal(snapshot.ackObservability.currentAckTimeoutMs, 90000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutMs, 90000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutReason, 'capped-max');
  } finally {
    cleanupBridge(bridge);
  }
});

test('normal ack successes increment adaptive recovery counter', async () => {
  const bridge = createBridge();

  try {
    for (let i = 1; i <= 3; i += 1) {
      const entry = makeEntry(`msg-ack-recover-${i}`, 'recover');
      entry.createdAt = Date.now();
      entry.lastPushAt = Date.now() - 100;
      entry.lastPushConnId = 'conn-1';
      entry.lastPushClientId = 'client-1';
      bridge.outbox.set(entry.messageId, entry);
      await bridge.handleAck({
        params: { accountId: 'Primary', messageId: entry.messageId, ok: true },
        respond() {},
        client: { connId: 'conn-1' },
        context: null,
      });
    }

    assert.equal(bridge.getCounter(bridge.adaptiveAckRecoveryOkCountByAccount, 'Primary'), 3);
  } finally {
    cleanupBridge(bridge);
  }
});
