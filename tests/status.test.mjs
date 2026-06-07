import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAccountRuntimeSnapshot,
  buildAccountStatusSnapshot,
  buildChannelSummaryFromRuntime,
  buildIntegratedDiagnostics,
  buildStatusMetaFromRuntime,
} from '../src/core/status.ts';
import { createBncrStatusSurface } from '../src/plugin/status.ts';

test('buildStatusMetaFromRuntime exposes scope but not raw lastSessionKey', () => {
  const meta = buildStatusMetaFromRuntime({
    accountId: 'Primary',
    connected: true,
    pending: 0,
    deadLetter: 0,
    activeConnections: 1,
    connectEvents: 1,
    inboundEvents: 1,
    activityEvents: 1,
    ackEvents: 1,
    startedAt: Date.now() - 5_000,
    lastSession: {
      sessionKey: 'agent:main:bncr:direct:deadbeef',
      scope: 'Bncr:tgBot:10001',
      updatedAt: Date.now() - 1_000,
    },
    sessionRoutesCount: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
  });

  assert.equal(meta.lastSessionScope, 'Bncr:tgBot:10001');
  assert.equal('lastSessionKey' in meta, false);
});

test('buildStatusMetaFromRuntime preserves zero timestamp fields', () => {
  const meta = buildStatusMetaFromRuntime({
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

  assert.equal(meta.lastSessionAt, 0);
  assert.equal(meta.lastActivityAt, 0);
  assert.equal(meta.lastInboundAt, 0);
  assert.equal(meta.lastOutboundAt, 0);
  assert.equal(meta.lastSessionAgo, '-');
  assert.equal(meta.lastActivityAgo, '-');
  assert.equal(meta.lastInboundAgo, '-');
  assert.equal(meta.lastOutboundAgo, '-');
});

test('buildStatusMetaFromRuntime drops non-finite timestamp fields', () => {
  const meta = buildStatusMetaFromRuntime({
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
      updatedAt: Number.NaN,
    },
    lastActivityAt: Number.POSITIVE_INFINITY,
    lastInboundAt: Number.NEGATIVE_INFINITY,
    lastOutboundAt: 'not-a-number',
    sessionRoutesCount: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
  });

  assert.equal(meta.lastSessionAt, null);
  assert.equal(meta.lastActivityAt, null);
  assert.equal(meta.lastInboundAt, null);
  assert.equal(meta.lastOutboundAt, null);
  assert.equal(meta.lastSessionAgo, '-');
  assert.equal(meta.lastActivityAgo, '-');
  assert.equal(meta.lastInboundAgo, '-');
  assert.equal(meta.lastOutboundAgo, '-');
});

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

test('buildStatusMetaFromRuntime normalizes invalid queue counters', () => {
  const meta = buildStatusMetaFromRuntime({
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

  assert.equal(meta.pending, 0);
  assert.equal(meta.deadLetter, 0);
  assert.equal(meta.diagnostics.health.pending, 0);
  assert.equal(meta.diagnostics.health.deadLetter, 0);
});

test('buildStatusMetaFromRuntime projects pending admission scopes for status payloads', () => {
  const meta = buildStatusMetaFromRuntime({
    accountId: 'Primary',
    connected: false,
    pending: 0,
    deadLetter: 0,
    activeConnections: 0,
    connectEvents: 0,
    inboundEvents: 0,
    activityEvents: 0,
    ackEvents: 0,
    startedAt: Date.now(),
    pendingAdmissions: [
      {
        clientId: 'client-1',
        route: { platform: 'tg', groupId: '100', userId: '200' },
        routes: [
          { platform: 'tg', groupId: '100', userId: '200' },
          { platform: 'wx', groupId: '300', userId: '400' },
        ],
        firstSeenAt: 1_000,
        lastSeenAt: 2_000,
        attempts: 3,
      },
    ],
    sessionRoutesCount: 0,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
  });

  assert.equal(meta.pendingAdmissionsCount, 1);
  assert.equal(meta.diagnostics.health.pendingAdmissions, 1);
  assert.deepEqual(meta.pendingAdmissions, [
    {
      clientId: 'client-1',
      scope: 'tg:100:200',
      scopes: ['tg:100:200', 'wx:300:400'],
      firstSeenAt: 1_000,
      lastSeenAt: 2_000,
      attempts: 3,
    },
  ]);
});

test('buildStatusMetaFromRuntime guards malformed pending admission routes', () => {
  const meta = buildStatusMetaFromRuntime({
    accountId: 'Primary',
    connected: false,
    pending: 0,
    deadLetter: 0,
    activeConnections: 0,
    connectEvents: 0,
    inboundEvents: 0,
    activityEvents: 0,
    ackEvents: 0,
    startedAt: Date.now(),
    pendingAdmissions: [
      {
        clientId: 'client-1',
        route: { platform: 'tg', groupId: '100' },
        routes: [
          { platform: 'tg', groupId: '100', userId: '200' },
          null,
          { platform: 'wx', groupId: '300' },
        ],
        firstSeenAt: 1_000,
        lastSeenAt: 2_000,
        attempts: 3,
      },
    ],
    sessionRoutesCount: 0,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
  });

  assert.equal(meta.pendingAdmissionsCount, 1);
  assert.deepEqual(meta.pendingAdmissions, [
    {
      clientId: 'client-1',
      scope: null,
      scopes: ['tg:100:200'],
      firstSeenAt: 1_000,
      lastSeenAt: 2_000,
      attempts: 3,
    },
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

test('buildIntegratedDiagnostics keeps uptime finite for invalid startedAt', () => {
  const diagnostics = buildIntegratedDiagnostics({
    accountId: 'Primary',
    connected: true,
    pending: 0,
    deadLetter: 0,
    activeConnections: 1,
    connectEvents: 1,
    inboundEvents: 1,
    activityEvents: 1,
    ackEvents: 1,
    startedAt: 'not-a-number',
    sessionRoutesCount: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
  });

  assert.equal(Number.isFinite(diagnostics.health.uptimeSec), true);
  assert.equal(diagnostics.health.uptimeSec, 0);
});

test('buildIntegratedDiagnostics normalizes invalid counters at diagnostics boundary', () => {
  const diagnostics = buildIntegratedDiagnostics({
    accountId: 'Primary',
    connected: true,
    pending: 'not-a-number',
    deadLetter: Number.NaN,
    activeConnections: Number.POSITIVE_INFINITY,
    connectEvents: 'bad-connect',
    inboundEvents: 'bad-inbound',
    activityEvents: 'bad-activity',
    ackEvents: 'bad-ack',
    startedAt: Date.now(),
    sessionRoutesCount: Number.NEGATIVE_INFINITY,
    invalidOutboxSessionKeys: 'bad-invalid-keys',
    legacyAccountResidue: Number.NaN,
  });

  assert.equal(diagnostics.health.pending, 0);
  assert.equal(diagnostics.health.deadLetter, 0);
  assert.equal(diagnostics.health.activeConnections, 0);
  assert.equal(diagnostics.health.connectEvents, 0);
  assert.equal(diagnostics.health.inboundEvents, 0);
  assert.equal(diagnostics.health.activityEvents, 0);
  assert.equal(diagnostics.health.ackEvents, 0);
  assert.equal(diagnostics.regression.totalKnownRoutes, 0);
  assert.equal(diagnostics.regression.invalidOutboxSessionKeys, 0);
  assert.equal(diagnostics.regression.legacyAccountResidue, 0);
  assert.equal(diagnostics.regression.ok, true);
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

  const diagnostics = buildIntegratedDiagnostics(runtimeInput);
  assert.equal(diagnostics.health.pending, 0);
  assert.equal(diagnostics.health.deadLetter, 0);
  assert.equal(diagnostics.health.activeConnections, 0);
  assert.equal(diagnostics.health.connectEvents, 0);
  assert.equal(diagnostics.health.inboundEvents, 0);
  assert.equal(diagnostics.health.activityEvents, 0);
  assert.equal(diagnostics.health.ackEvents, 0);
  assert.equal(diagnostics.regression.totalKnownRoutes, 0);
  assert.equal(diagnostics.regression.invalidOutboxSessionKeys, 0);
  assert.equal(diagnostics.regression.legacyAccountResidue, 0);

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

test('buildChannelSummaryFromRuntime uses normalized counters in headline', () => {
  const summary = buildChannelSummaryFromRuntime({
    accountId: 'Primary',
    connected: true,
    pending: 'not-a-number',
    deadLetter: Number.NaN,
    activeConnections: Number.POSITIVE_INFINITY,
    connectEvents: 1,
    inboundEvents: 1,
    activityEvents: 1,
    ackEvents: 1,
    startedAt: Date.now(),
    sessionRoutesCount: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
  });

  assert.equal(summary.linked, true);
  assert.equal(summary.self.e164, 'linked p:0 d:0 c:0');
});
