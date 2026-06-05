import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFlushDebugInfo,
  buildOutboxAckDebugInfo,
  buildOutboxDrainSkipDebugInfo,
  buildOutboxDrainStuckDebugInfo,
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
      runningSince: 1000,
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
      runningSince: 1000,
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
