import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

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
