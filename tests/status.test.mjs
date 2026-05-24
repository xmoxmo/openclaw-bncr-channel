import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAccountStatusSnapshot, buildStatusMetaFromRuntime } from '../src/core/status.ts';

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
