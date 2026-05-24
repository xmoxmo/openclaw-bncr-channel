import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDownlinkHealth } from '../src/core/downlink-health.ts';

test('buildDownlinkHealth treats invalid timestamps as neutral fallbacks', () => {
  const nowTs = Date.now();
  const health = buildDownlinkHealth({
    accountId: 'Primary',
    now: nowTs,
    outboxEntries: [
      {
        accountId: 'Primary',
        messageId: 'msg-bad-created-at',
        createdAt: 'not-a-number',
      },
    ],
    lastAckOkAt: null,
    lastAckTimeoutAt: nowTs - 1_000,
    recentAckTimeoutCount: 1,
    activeConnectionCount: 1,
    lastInboundAt: 'not-a-number',
    lastActivityAt: 'not-a-number',
    onlineByConn: true,
  });

  assert.equal(health.pendingOutbox, 1);
  assert.equal(Number.isNaN(health.oldestPendingCreatedAt), false);
  assert.equal(health.oldestPendingCreatedAt, nowTs);
  assert.equal(health.oldestPendingAgeMs, 0);
  assert.equal(health.recentInboundReachable, false);
  assert.equal(health.ackStalled, false);
});
