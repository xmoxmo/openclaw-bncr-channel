import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExtendedOutboundDiagnostics,
  buildFlushDebugInfo,
  buildOutboxAckDebugInfo,
  buildOutboxDrainSkipDebugInfo,
  buildOutboxDrainStuckDebugInfo,
  buildOutboxIncidentSummary,
  buildOutboxPushOkDebugInfo,
  buildOutboxPushSkipDebugInfo,
  buildOutboxRouteSelectDebugInfo,
  buildOutboxScheduleDebugInfo,
  buildPushFailureDebugInfo,
  buildRetryRerouteDebugInfo,
} from '../src/messaging/outbound/diagnostics.ts';
import { clampOutboxDrainDelay } from '../src/messaging/outbound/queue-selectors.ts';
import { OUTBOUND_SCHEDULE_SOURCE } from '../src/messaging/outbound/reasons.ts';

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

test('buildOutboxScheduleDebugInfo includes only provided scheduling fields', () => {
  assert.deepEqual(
    buildOutboxScheduleDebugInfo({
      bridgeId: 'bridge-1',
      source: OUTBOUND_SCHEDULE_SOURCE.SCHEDULE_PUSH_DRAIN,
      wait: 1000,
    }),
    {
      bridge: 'bridge-1',
      source: OUTBOUND_SCHEDULE_SOURCE.SCHEDULE_PUSH_DRAIN,
      wait: 1000,
    },
  );

  assert.deepEqual(
    buildOutboxScheduleDebugInfo({
      bridgeId: 'bridge-1',
      accountId: 'Primary',
      messageId: 'mid-1',
      source: OUTBOUND_SCHEDULE_SOURCE.RETRY_REROUTE_WAIT,
      wait: 2000,
      localNextDelay: 1500,
      globalNextDelay: 1500,
    }),
    {
      bridge: 'bridge-1',
      accountId: 'Primary',
      messageId: 'mid-1',
      source: OUTBOUND_SCHEDULE_SOURCE.RETRY_REROUTE_WAIT,
      wait: 2000,
      localNextDelay: 1500,
      globalNextDelay: 1500,
    },
  );
});

test('buildOutboxScheduleDebugInfo preserves source-specific payload contracts', () => {
  assert.deepEqual(
    buildOutboxScheduleDebugInfo({
      bridgeId: 'bridge-2',
      source: OUTBOUND_SCHEDULE_SOURCE.SCHEDULE_PUSH_DRAIN,
      wait: 500,
    }),
    {
      bridge: 'bridge-2',
      source: OUTBOUND_SCHEDULE_SOURCE.SCHEDULE_PUSH_DRAIN,
      wait: 500,
    },
  );

  assert.deepEqual(
    buildOutboxScheduleDebugInfo({
      bridgeId: 'bridge-2',
      accountId: 'Primary',
      source: OUTBOUND_SCHEDULE_SOURCE.ACCOUNT_NEXT_DELAY_MERGE,
      localNextDelay: 1200,
      globalNextDelay: 900,
    }),
    {
      bridge: 'bridge-2',
      accountId: 'Primary',
      source: OUTBOUND_SCHEDULE_SOURCE.ACCOUNT_NEXT_DELAY_MERGE,
      localNextDelay: 1200,
      globalNextDelay: 900,
    },
  );

  assert.deepEqual(
    buildOutboxScheduleDebugInfo({
      bridgeId: 'bridge-2',
      source: OUTBOUND_SCHEDULE_SOURCE.FLUSH_NEXT_DRAIN,
      wait: 900,
      globalNextDelay: 900,
    }),
    {
      bridge: 'bridge-2',
      source: OUTBOUND_SCHEDULE_SOURCE.FLUSH_NEXT_DRAIN,
      wait: 900,
      globalNextDelay: 900,
    },
  );
});

test('buildOutboxPushSkipDebugInfo returns optional reachability and kind fields only when present', () => {
  assert.deepEqual(
    buildOutboxPushSkipDebugInfo({
      messageId: 'mid-skip-1',
      accountId: 'Primary',
      reason: 'no-gateway-context',
    }),
    {
      messageId: 'mid-skip-1',
      accountId: 'Primary',
      reason: 'no-gateway-context',
    },
  );

  assert.deepEqual(
    buildOutboxPushSkipDebugInfo({
      messageId: 'mid-skip-2',
      accountId: 'Primary',
      kind: 'file-transfer',
      reason: 'no-active-connection',
      recentInboundReachable: false,
      routeReason: 'none',
      connIds: [],
      ownerConnId: 'conn-owner',
      ownerClientId: 'client-owner',
      activeConnectionCount: 1,
      connections: [
        {
          accountId: 'Primary',
          connId: 'conn-owner',
          clientId: 'client-owner',
          lastSeenAt: 123,
          connectedAt: 100,
          inboundOnly: true,
          outboundReadyUntil: 456,
          preferredForOutboundUntil: 789,
          lastAckOkAt: 234,
          lastPushTimeoutAt: 345,
          pushFailureScore: 2,
        },
        {
          accountId: 'Other',
          connId: 'conn-other',
          lastSeenAt: 999,
          connectedAt: 900,
        },
      ],
    }),
    {
      messageId: 'mid-skip-2',
      accountId: 'Primary',
      kind: 'file-transfer',
      reason: 'no-active-connection',
      routeReason: 'none',
      connIds: [],
      ownerConnId: 'conn-owner',
      ownerClientId: 'client-owner',
      activeConnectionCount: 1,
      connections: [
        {
          connId: 'conn-owner',
          clientId: 'client-owner',
          lastSeenAt: 123,
          outboundReadyUntil: 456,
          preferredForOutboundUntil: 789,
          inboundOnly: true,
          lastAckOkAt: 234,
          lastPushTimeoutAt: 345,
          pushFailureScore: 2,
        },
      ],
      recentInboundReachable: false,
    },
  );
});

test('buildOutboxRouteSelectDebugInfo copies connection ids and preserves routing context', () => {
  const connIds = ['conn-a', 'conn-b'];
  const result = buildOutboxRouteSelectDebugInfo({
    messageId: 'mid-route',
    accountId: 'Primary',
    kind: 'file-transfer',
    routeReason: 'active-connections',
    connIds,
    ownerConnId: 'conn-a',
    ownerClientId: 'client-a',
    recentInboundReachable: true,
    event: 'plugin.bncr.push',
  });

  assert.deepEqual(result, {
    messageId: 'mid-route',
    accountId: 'Primary',
    kind: 'file-transfer',
    routeReason: 'active-connections',
    connIds: ['conn-a', 'conn-b'],
    ownerConnId: 'conn-a',
    ownerClientId: 'client-a',
    recentInboundReachable: true,
    event: 'plugin.bncr.push',
  });
  assert.notEqual(result.connIds, connIds);
});

test('buildOutboxPushOkDebugInfo copies connection ids and preserves delivery context', () => {
  const connIds = ['conn-a'];
  const result = buildOutboxPushOkDebugInfo({
    messageId: 'mid-ok',
    accountId: 'Primary',
    connIds,
    ownerConnId: 'conn-a',
    ownerClientId: 'client-a',
    recentInboundReachable: true,
    event: 'plugin.bncr.push',
  });

  assert.deepEqual(result, {
    messageId: 'mid-ok',
    accountId: 'Primary',
    connIds: ['conn-a'],
    ownerConnId: 'conn-a',
    ownerClientId: 'client-a',
    recentInboundReachable: true,
    event: 'plugin.bncr.push',
  });
  assert.notEqual(result.connIds, connIds);
});

test('buildFlushDebugInfo copies target accounts and preserves flush context', () => {
  const targetAccounts = ['Primary', 'Backup'];
  const result = buildFlushDebugInfo({
    bridgeId: 'bridge-1',
    accountId: 'Primary',
    targetAccounts,
    outboxSize: 3,
    trigger: 'manual',
    reason: 'scheduled-drain',
  });

  assert.deepEqual(result, {
    bridge: 'bridge-1',
    accountId: 'Primary',
    targetAccounts: ['Primary', 'Backup'],
    outboxSize: 3,
    trigger: 'manual',
    reason: 'scheduled-drain',
  });
  assert.notEqual(result.targetAccounts, targetAccounts);
});

test('buildOutboxDrainSkipDebugInfo captures reentrant drain skip context', () => {
  assert.deepEqual(
    buildOutboxDrainSkipDebugInfo({
      bridgeId: 'bridge-drain',
      accountId: 'Primary',
      reason: 'already-running',
      outboxSize: 2,
      trigger: 'manual',
    }),
    {
      bridge: 'bridge-drain',
      accountId: 'Primary',
      reason: 'already-running',
      outboxSize: 2,
      trigger: 'manual',
    },
  );
});

test('buildOutboxDrainStuckDebugInfo captures pending entries and connection details', () => {
  assert.deepEqual(
    buildOutboxDrainStuckDebugInfo({
      bridgeId: 'bridge-stuck',
      accountId: 'Primary',
      reason: 'already-running',
      trigger: 'activity',
      outboxSize: 2,
      pending: 1,
      runningMs: 31_000,
      runningSince: 0,
      hasGatewayContext: true,
      activeConnectionCount: 1,
      messageAckWaiters: 1,
      fileAckWaiters: 0,
      pendingEntries: [
        {
          messageId: 'mid-stuck',
          retryCount: 2,
          nextAttemptAt: 2000,
          lastAttemptAt: 1500,
          lastError: 'push-retry',
          lastPushAt: 1400,
          lastPushConnId: 'conn-1',
          routeAttemptConnIds: ['conn-1'],
        },
      ],
      connections: [
        {
          accountId: 'Primary',
          connId: 'conn-1',
          clientId: 'client-1',
          connectedAt: 500,
          lastSeenAt: 2500,
          outboundReadyUntil: 3000,
          preferredForOutboundUntil: 2800,
          inboundOnly: false,
          lastAckOkAt: 2400,
          lastPushTimeoutAt: 0,
          pushFailureScore: 0,
        },
        {
          accountId: 'Other',
          connId: 'conn-other',
          connectedAt: 500,
          lastSeenAt: 2500,
        },
      ],
    }),
    {
      bridge: 'bridge-stuck',
      accountId: 'Primary',
      reason: 'already-running',
      trigger: 'activity',
      outboxSize: 2,
      pending: 1,
      runningMs: 31_000,
      runningSince: 0,
      hasGatewayContext: true,
      activeConnectionCount: 1,
      waiters: { messageAck: 1, fileAck: 0 },
      pendingEntries: [
        {
          messageId: 'mid-stuck',
          retryCount: 2,
          nextAttemptAt: 2000,
          lastAttemptAt: 1500,
          lastError: 'push-retry',
          lastPushAt: 1400,
          lastPushConnId: 'conn-1',
          routeAttemptConnIds: ['conn-1'],
        },
      ],
      connections: [
        {
          connId: 'conn-1',
          clientId: 'client-1',
          connectedAt: 500,
          lastSeenAt: 2500,
          outboundReadyUntil: 3000,
          preferredForOutboundUntil: 2800,
          inboundOnly: false,
          lastAckOkAt: 2400,
          lastPushTimeoutAt: 0,
          pushFailureScore: 0,
        },
      ],
    },
  );
});

test('buildOutboxAckDebugInfo returns stable ack observability payload', () => {
  const result = buildOutboxAckDebugInfo({
    messageId: 'mid-ack',
    accountId: 'Primary',
    requireAck: true,
    ackResult: 'timeout',
    onlineNow: true,
    recentInboundReachable: false,
  });

  assert.deepEqual(result, {
    messageId: 'mid-ack',
    accountId: 'Primary',
    requireAck: true,
    ackResult: 'timeout',
    ackStage: 'message',
    ackOutcome: 'timeout',
    onlineNow: true,
    recentInboundReachable: false,
  });
});

test('buildOutboxAckDebugInfo includes causal route and ack outcome fields when provided', () => {
  const result = buildOutboxAckDebugInfo({
    messageId: 'mid-ack-rich',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    to: 'Bncr:tgBot:-1001:10001',
    requireAck: true,
    ackResult: 'timeout',
    ackStage: 'message',
    ackOutcome: 'timeout',
    reason: 'push-ack-timeout',
    ackTimeoutMs: 60000,
    adaptiveAckTimeoutEnabled: true,
    onlineNow: true,
    recentInboundReachable: false,
    connIds: ['conn-a'],
    ownerConnId: 'conn-a',
    ownerClientId: 'client-a',
    event: 'message.outbound',
  });

  assert.deepEqual(result, {
    messageId: 'mid-ack-rich',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    to: 'Bncr:tgBot:-1001:10001',
    requireAck: true,
    ackResult: 'timeout',
    ackStage: 'message',
    ackOutcome: 'timeout',
    reason: 'push-ack-timeout',
    ackTimeoutMs: 60000,
    adaptiveAckTimeoutEnabled: true,
    onlineNow: true,
    recentInboundReachable: false,
    connIds: ['conn-a'],
    ownerConnId: 'conn-a',
    ownerClientId: 'client-a',
    event: 'message.outbound',
  });
});

test('buildRetryRerouteDebugInfo returns retry payload copies without mutating decision arrays', () => {
  const decision = {
    kind: 'retry',
    nextRetryCount: 2,
    lastAttemptAt: 12_000,
    nextAttemptAt: 13_000,
    lastError: 'push-ack-timeout',
    attemptedConnIds: ['conn-a'],
    fastReroutePending: true,
    routeAttemptRound: 0,
    hasUntriedAlternative: true,
    shouldFastReroute: true,
    revalidatedConnIds: ['conn-a'],
  };

  const result = buildRetryRerouteDebugInfo({
    messageId: 'mid-1',
    accountId: 'Primary',
    currentConnId: 'conn-a',
    decision,
    availableConnIds: ['conn-a', 'conn-b'],
  });

  assert.deepEqual(result, {
    messageId: 'mid-1',
    accountId: 'Primary',
    currentConnId: 'conn-a',
    attemptedConnIds: ['conn-a'],
    availableConnIds: ['conn-a', 'conn-b'],
    revalidatedConnIds: ['conn-a'],
    hasUntriedAlternative: true,
    shouldFastReroute: true,
    routeAttemptRound: 0,
    nextAttemptAt: 13_000,
    fastReroutePending: true,
    nextRetryCount: 2,
    lastAttemptAt: 12_000,
    lastError: 'push-ack-timeout',
    kind: 'retry',
  });

  assert.notEqual(result.attemptedConnIds, decision.attemptedConnIds);
  assert.notEqual(result.revalidatedConnIds, decision.revalidatedConnIds);
});

test('buildRetryRerouteDebugInfo returns dead-letter payload when decision is terminal', () => {
  const result = buildRetryRerouteDebugInfo({
    messageId: 'mid-2',
    accountId: 'Primary',
    currentConnId: 'conn-a',
    decision: {
      kind: 'dead-letter',
      terminalReason: 'push-delivery-unconfirmed',
      nextRetryCount: 4,
      lastAttemptAt: 20_000,
    },
    availableConnIds: ['conn-a'],
  });

  assert.deepEqual(result, {
    messageId: 'mid-2',
    accountId: 'Primary',
    currentConnId: 'conn-a',
    availableConnIds: ['conn-a'],
    kind: 'dead-letter',
    terminalReason: 'push-delivery-unconfirmed',
    nextRetryCount: 4,
    lastAttemptAt: 20_000,
  });
});

test('buildPushFailureDebugInfo includes optional kind and retryable fields when provided', () => {
  const result = buildPushFailureDebugInfo({
    messageId: 'mid-fail-rich',
    accountId: 'Primary',
    retryCount: 2,
    kind: 'file-transfer',
    retryable: true,
    lastError: 'file-transfer-error',
  });

  assert.deepEqual(result, {
    messageId: 'mid-fail-rich',
    accountId: 'Primary',
    kind: 'file-transfer',
    retryable: true,
    retryCount: 2,
    error: 'file-transfer-error',
  });
});

test('buildPushFailureDebugInfo falls back to push-retry when lastError is absent', () => {
  const result = buildPushFailureDebugInfo({
    messageId: 'mid-3',
    accountId: 'Primary',
    retryCount: 3,
  });

  assert.deepEqual(result, {
    messageId: 'mid-3',
    accountId: 'Primary',
    retryCount: 3,
    error: 'push-retry',
  });
});
