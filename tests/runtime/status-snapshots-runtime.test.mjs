import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAccountRuntimeSnapshot, buildAccountStatusSnapshot } from '../../src/core/status.ts';
import { createBncrStatusSurface } from '../../src/plugin/status.ts';

test('buildAccountStatusSnapshot treats invalid pending counters as zero', () => {
  const snapshot = buildAccountStatusSnapshot({
    account: { accountId: 'Primary', enabled: true },
    runtime: {
      connected: true,
      running: true,
      pending: 'not-a-number',
      deadLetter: 'not-a-number',
      meta: {
        pending: 'also-not-a-number',
        deadLetter: 'also-not-a-number',
      },
    },
    healthSummary: 'linked',
    displayName: 'Primary',
  });

  assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.deadLetter, 0);
});

test('status surface builds a default account snapshot when account is missing', async () => {
  const calls = [];
  const status = createBncrStatusSurface(() => ({
    getChannelSummary() {
      return {};
    },
    getAccountRuntimeSnapshot(accountId) {
      calls.push(['runtime', accountId]);
      return {
        connected: false,
        running: false,
        pending: 0,
        deadLetter: 0,
        diagnostics: {},
      };
    },
    getStatusHeadline(accountId) {
      calls.push(['headline', accountId]);
      return 'configured';
    },
  }));

  const snapshot = await status.buildAccountSnapshot({ account: undefined });

  assert.equal(snapshot.accountId, 'Primary');
  assert.equal(snapshot.name, 'Monitor');
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.healthSummary, 'configured');
  assert.deepEqual(snapshot.diagnostics, {});
  assert.deepEqual(calls, [
    ['runtime', 'Primary'],
    ['headline', 'Primary'],
  ]);
});

test('buildAccountRuntimeSnapshot keeps top-level queue counters normalized', () => {
  const snapshot = buildAccountRuntimeSnapshot({
    accountId: 'Primary',
    connected: true,
    pending: 'not-a-number',
    deadLetter: Number.NaN,
    activeConnections: 1,
    connectEvents: 1,
    inboundEvents: 1,
    activityEvents: 1,
    ackEvents: 1,
    startedAt: Date.now(),
    sessionRoutesCount: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
  });

  assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.deadLetter, 0);
  assert.equal(snapshot.meta.pending, 0);
  assert.equal(snapshot.meta.deadLetter, 0);
});

test('buildAccountRuntimeSnapshot preserves zero timestamp fields', () => {
  const snapshot = buildAccountRuntimeSnapshot({
    accountId: 'Primary',
    connected: true,
    pending: 0,
    deadLetter: 0,
    activeConnections: 1,
    connectEvents: 1,
    inboundEvents: 1,
    activityEvents: 1,
    ackEvents: 1,
    startedAt: Date.now(),
    lastSession: {
      sessionKey: 'agent:main:bncr:direct:deadbeef',
      scope: 'Bncr:tgBot:10001',
      updatedAt: 0,
    },
    lastActivityAt: 0,
    lastInboundAt: 0,
    lastOutboundAt: 0,
    sessionRoutesCount: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
  });

  assert.equal(snapshot.lastEventAt, 0);
  assert.equal(snapshot.lastInboundAt, 0);
  assert.equal(snapshot.lastOutboundAt, 0);
  assert.equal(snapshot.lastSessionAt, 0);
  assert.equal(snapshot.lastActivityAt, 0);
  assert.equal(snapshot.meta.lastSessionAt, 0);
  assert.equal(snapshot.meta.lastActivityAt, 0);
  assert.equal(snapshot.meta.lastInboundAt, 0);
  assert.equal(snapshot.meta.lastOutboundAt, 0);
});

test('status snapshots clamp negative diagnostic counters to zero', () => {
  const runtimeInput = {
    accountId: 'Primary',
    connected: true,
    pending: -1,
    deadLetter: -2,
    activeConnections: -3,
    connectEvents: -4,
    inboundEvents: -5,
    activityEvents: -6,
    ackEvents: -7,
    startedAt: Date.now(),
    sessionRoutesCount: -8,
    invalidOutboxSessionKeys: -9,
    legacyAccountResidue: -10,
  };

  const runtimeSnapshot = buildAccountRuntimeSnapshot(runtimeInput);
  assert.equal(runtimeSnapshot.pending, 0);
  assert.equal(runtimeSnapshot.deadLetter, 0);

  const statusSnapshot = buildAccountStatusSnapshot({
    account: { accountId: 'Primary', enabled: true },
    runtime: { pending: -1, deadLetter: -2 },
    healthSummary: 'linked',
    displayName: 'Primary',
  });
  assert.equal(statusSnapshot.pending, 0);
  assert.equal(statusSnapshot.deadLetter, 0);
});
