import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrStatusRuntime } from '../../src/plugin/status-runtime.ts';

function createHelpers(overrides = {}) {
  return {
    api: {},
    getPluginRoot: () => '/tmp/bncr',
    startedAt: 1000,
    debugVerbose: false,
    adaptiveAckTimeoutEnabled: true,
    defaultMessageAckTimeoutMs: 30_000,
    fileAckTimeoutMs: 20_000,
    maxAckTimeoutMs: 90_000,
    now: () => 10_000,
    resolveMessageAckTimeoutMs: () => 45_000,
    isOnline: () => false,
    outboxValues: () => [],
    deadLetterEntries: () => [],
    sessionRouteValues: () => [],
    countInvalidOutboxSessionKeys: () => 0,
    countLegacyAccountResidue: () => 0,
    connectEventsByAccount: new Map([['Primary', 1]]),
    inboundEventsByAccount: new Map([['Primary', 2]]),
    activityEventsByAccount: new Map([['Primary', 3]]),
    ackEventsByAccount: new Map([['Primary', 4]]),
    activeConnectionCount: () => 0,
    lastSessionByAccount: new Map(),
    lastActivityByAccount: new Map(),
    lastInboundByAccount: new Map(),
    lastOutboundByAccount: new Map(),
    buildRuntimeAckObservability: () => ({ recentAckTimeoutCount: 1, currentAckTimeoutMs: 45_000 }),
    buildRuntimeAckStrategy: () => ({ mode: 'adaptive', timeoutMs: 45_000 }),
    lastAckOkByAccount: new Map(),
    lastAckTimeoutByAccount: new Map(),
    getAckTimeoutCount: () => 1,
    getAccountPendingOutboxEntries: () => [{ messageId: 'm1' }, { messageId: 'm2' }],
    getAccountDeadLetterEntries: () => [{ messageId: 'd1' }],
    connectionsValues: () => [{ lastSeenAt: 9_500 }],
    connectTtlMs: 60_000,
    ...overrides,
  };
}

test('status runtime projects core queue counters into runtime status input and snapshots', () => {
  const statusRuntime = createBncrStatusRuntime(createHelpers());
  const input = statusRuntime.buildRuntimeStatusInput('Primary');
  const snapshot = statusRuntime.getAccountRuntimeSnapshot('Primary', input);

  assert.equal(input.pending, 2);
  assert.equal(input.deadLetter, 1);
  assert.equal(input.activeConnections, 0);
  assert.equal(snapshot.pending, 2);
  assert.equal(snapshot.deadLetter, 1);
  assert.equal(snapshot.ackObservability.recentAckTimeoutCount, 1);
  assert.equal(snapshot.ackStrategy.timeoutMs, 45_000);
  assert.equal(snapshot.meta.ackStrategy.timeoutMs, 45_000);
});

test('status runtime channel summary falls back to live connections even when account snapshot is offline', () => {
  const statusRuntime = createBncrStatusRuntime(
    createHelpers({
      isOnline: () => false,
      connectionsValues: () => [{ lastSeenAt: 9_900 }],
    }),
  );

  assert.deepEqual(statusRuntime.getChannelSummary('Primary'), {
    linked: true,
    self: { e164: statusRuntime.getStatusHeadline('Primary') },
  });
});
