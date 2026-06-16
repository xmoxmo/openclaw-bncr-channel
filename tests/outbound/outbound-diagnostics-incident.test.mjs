import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExtendedOutboundDiagnostics,
  buildOutboxIncidentSummary,
} from '../../src/messaging/outbound/diagnostics.ts';
import { clampOutboxDrainDelay } from '../../src/messaging/outbound/queue-selectors.ts';

test('clampOutboxDrainDelay clamps negative, large, and invalid timer inputs', () => {
  assert.equal(clampOutboxDrainDelay(-1), 0);
  assert.equal(clampOutboxDrainDelay(0), 0);
  assert.equal(clampOutboxDrainDelay(2500), 2500);
  assert.equal(clampOutboxDrainDelay(99_999), 30_000);
  assert.equal(clampOutboxDrainDelay(Number.NaN), 0);
});

test('buildOutboxIncidentSummary classifies current outbound incident cause', () => {
  assert.deepEqual(
    buildOutboxIncidentSummary({
      pending: 1,
      oldestPendingAt: 1_000,
      lastAttemptAt: 2_000,
      lastPushAt: 3_000,
      lastPushError: 'push-ack-timeout',
      hasGatewayContext: false,
      activeOutboundConnection: true,
      activeOutboundConnectionCount: 1,
      prePushGuardSkipCount: 2,
      lastPrePushGuardSkipAt: 4_000,
      lastPrePushGuardSkipReason: 'no-gateway-context',
      lastAckQueueLatencyMs: 10,
      lastAckPushLatencyMs: 20,
      lastLateAckQueueLatencyMs: 30,
      lastLateAckPushLatencyMs: 40,
      lastLateAckOkAt: 5_000,
      adaptiveAckTimeoutMs: 60_000,
      adaptiveAckTimeoutReason: 'late-ack-observed',
      nowMs: 11_000,
    }),
    {
      active: true,
      type: 'no-gateway-context',
      severity: 'critical',
      recommendedAction: 'check-channel-message-runtime-context',
      pending: 1,
      oldestPendingAgeMs: 10_000,
      lastAttemptAgeMs: 9_000,
      lastPushAgeMs: 8_000,
      lastPushError: 'push-ack-timeout',
      hasGatewayContext: false,
      activeOutboundConnection: true,
      activeOutboundConnectionCount: 1,
      prePushGuardSkipCount: 2,
      lastPrePushGuardSkipAgeMs: 7_000,
      lastPrePushGuardSkipReason: 'no-gateway-context',
      ack: {
        lastQueueLatencyMs: 10,
        lastPushLatencyMs: 20,
        lastLateQueueLatencyMs: 30,
        lastLatePushLatencyMs: 40,
        lastLateAckAgeMs: 6_000,
        adaptiveTimeoutMs: 60_000,
        adaptiveTimeoutReason: 'late-ack-observed',
      },
    },
  );

  const noActiveConnection = buildOutboxIncidentSummary({
    pending: 2,
    hasGatewayContext: true,
    activeOutboundConnection: false,
    activeOutboundConnectionCount: 0,
    nowMs: 11_000,
  });
  assert.equal(noActiveConnection.type, 'no-active-outbound-connection');
  assert.equal(noActiveConnection.recommendedAction, 'reconnect-bncr-client');

  const healthy = buildOutboxIncidentSummary({
    pending: 0,
    hasGatewayContext: true,
    activeOutboundConnection: true,
    activeOutboundConnectionCount: 1,
    nowMs: 11_000,
  });
  assert.equal(healthy.active, false);
  assert.equal(healthy.type, 'none');
});

test('buildOutboxIncidentSummary preserves zero timestamp age calculations', () => {
  const summary = buildOutboxIncidentSummary({
    pending: 1,
    oldestPendingAt: 0,
    lastAttemptAt: 0,
    lastPushAt: 0,
    lastPrePushGuardSkipAt: 0,
    lastLateAckOkAt: 0,
    hasGatewayContext: true,
    activeOutboundConnection: true,
    activeOutboundConnectionCount: 1,
    nowMs: 10_000,
  });

  assert.equal(summary.oldestPendingAgeMs, 10_000);
  assert.equal(summary.lastAttemptAgeMs, 10_000);
  assert.equal(summary.lastPushAgeMs, 10_000);
  assert.equal(summary.lastPrePushGuardSkipAgeMs, 10_000);
  assert.equal(summary.ack.lastLateAckAgeMs, 10_000);
});

test('buildOutboxIncidentSummary exposes stable incident schema and categories', () => {
  const base = {
    pending: 0,
    hasGatewayContext: true,
    activeOutboundConnection: true,
    activeOutboundConnectionCount: 1,
    nowMs: 200_000,
  };

  const cases = [
    {
      name: 'ack timeout',
      input: { ...base, pending: 1, lastPushError: 'push-ack-timeout' },
      type: 'ack-timeout',
      severity: 'critical',
      recommendedAction: 'inspect-ack-and-route-state',
    },
    {
      name: 'slow or late ack without pending outbox',
      input: {
        ...base,
        lastLateAckOkAt: 190_000,
        adaptiveAckTimeoutMs: 60_000,
        adaptiveAckTimeoutReason: 'late-ack-observed',
      },
      type: 'slow-or-late-ack',
      severity: 'warning',
      recommendedAction: 'inspect-ack-latency',
    },
    {
      name: 'backlog',
      input: { ...base, pending: 3, oldestPendingAt: 1_000 },
      type: 'outbox-backlog',
      severity: 'warning',
      recommendedAction: 'inspect-outbox-drain',
    },
  ];

  for (const item of cases) {
    const summary = buildOutboxIncidentSummary(item.input);
    assert.equal(summary.type, item.type, item.name);
    assert.equal(summary.severity, item.severity, item.name);
    assert.equal(summary.recommendedAction, item.recommendedAction, item.name);
    assert.deepEqual(Object.keys(summary).sort(), [
      'ack',
      'active',
      'activeOutboundConnection',
      'activeOutboundConnectionCount',
      'hasGatewayContext',
      'lastAttemptAgeMs',
      'lastPrePushGuardSkipAgeMs',
      'lastPrePushGuardSkipReason',
      'lastPushAgeMs',
      'lastPushError',
      'oldestPendingAgeMs',
      'pending',
      'prePushGuardSkipCount',
      'recommendedAction',
      'severity',
      'type',
    ]);
    assert.deepEqual(Object.keys(summary.ack).sort(), [
      'adaptiveTimeoutMs',
      'adaptiveTimeoutReason',
      'lastLateAckAgeMs',
      'lastLatePushLatencyMs',
      'lastLateQueueLatencyMs',
      'lastPushLatencyMs',
      'lastQueueLatencyMs',
    ]);
  }
});

test('buildExtendedOutboundDiagnostics preserves zero timestamp fields', () => {
  const diagnostics = buildExtendedOutboundDiagnostics({
    outbox: {
      pending: 1,
      pendingAllAccounts: 1,
      oldestPendingAt: 0,
      newestPendingAt: 0,
      lastAttemptAt: 0,
      lastPushAt: 0,
      lastPushError: 'push-retry',
      activeOutboundConnection: false,
      activeOutboundConnectionCount: 0,
    },
    enqueueCount: 1,
    lastEnqueueAt: 0,
    prePushGuardSkipCount: 1,
    lastPrePushGuardSkipAt: 0,
    lastPrePushGuardSkipReason: 'no-gateway-context',
    hasGatewayContext: true,
    lastGatewayContextAt: 0,
    ackObservability: {
      lastLateAckOkAt: 0,
    },
    nowMs: 10_000,
  });

  assert.equal(diagnostics.lastEnqueueAt, 0);
  assert.equal(diagnostics.lastPrePushGuardSkipAt, 0);
  assert.equal(diagnostics.lastGatewayContextAt, 0);
  assert.equal(diagnostics.incident.lastPrePushGuardSkipAgeMs, 10_000);
  assert.equal(diagnostics.incident.ack.lastLateAckAgeMs, 10_000);
});

test('buildExtendedOutboundDiagnostics drops non-finite timestamp fields', () => {
  const diagnostics = buildExtendedOutboundDiagnostics({
    outbox: {
      pending: 1,
      pendingAllAccounts: 1,
      oldestPendingAt: Number.NaN,
      newestPendingAt: Number.POSITIVE_INFINITY,
      lastAttemptAt: Number.NEGATIVE_INFINITY,
      lastPushAt: 'not-a-number',
      lastPushError: 'push-retry',
      activeOutboundConnection: false,
      activeOutboundConnectionCount: 0,
    },
    enqueueCount: 1,
    lastEnqueueAt: Number.NaN,
    prePushGuardSkipCount: 1,
    lastPrePushGuardSkipAt: Number.POSITIVE_INFINITY,
    lastPrePushGuardSkipReason: 'no-gateway-context',
    hasGatewayContext: true,
    lastGatewayContextAt: Number.NEGATIVE_INFINITY,
    ackObservability: {
      lastLateAckOkAt: Number.NaN,
    },
    nowMs: 10_000,
  });

  assert.equal(diagnostics.lastEnqueueAt, null);
  assert.equal(diagnostics.lastPrePushGuardSkipAt, null);
  assert.equal(diagnostics.lastGatewayContextAt, null);
  assert.equal(diagnostics.incident.oldestPendingAgeMs, null);
  assert.equal(diagnostics.incident.lastAttemptAgeMs, null);
  assert.equal(diagnostics.incident.lastPushAgeMs, null);
  assert.equal(diagnostics.incident.lastPrePushGuardSkipAgeMs, null);
  assert.equal(diagnostics.incident.ack.lastLateAckAgeMs, null);
});
