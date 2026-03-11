import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStatusMetaFromRuntime } from '../src/core/status.ts';

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
      scope: 'Bncr:tgBot:6278285192',
      updatedAt: Date.now() - 1_000,
    },
    sessionRoutesCount: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
  });

  assert.equal(meta.lastSessionScope, 'Bncr:tgBot:6278285192');
  assert.equal('lastSessionKey' in meta, false);
});
