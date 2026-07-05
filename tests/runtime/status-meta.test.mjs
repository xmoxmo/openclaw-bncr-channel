import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStatusMetaFromRuntime } from '../../src/core/status.ts';

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
      scope: 'Bncr:tgBot:0:10001',
      updatedAt: Date.now() - 1_000,
    },
    sessionRoutesCount: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
  });

  assert.equal(meta.lastSessionScope, 'Bncr:tgBot:0:10001');
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
      scope: 'Bncr:tgBot:0:10001',
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
      scope: 'Bncr:tgBot:0:10001',
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
