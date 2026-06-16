import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDownlinkHealth } from '../../src/core/downlink-health.ts';

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

test('buildDownlinkHealth preserves zero timestamp age calculations', () => {
  const health = buildDownlinkHealth({
    accountId: 'Primary',
    now: 1_000,
    outboxEntries: [
      {
        accountId: 'Primary',
        messageId: 'msg-zero-created-at',
        createdAt: 0,
      },
    ],
    lastAckOkAt: null,
    lastAckTimeoutAt: null,
    recentAckTimeoutCount: 0,
    activeConnectionCount: 0,
    lastInboundAt: null,
    lastActivityAt: null,
    onlineByConn: false,
  });

  assert.equal(health.pendingOutbox, 1);
  assert.equal(health.oldestPendingCreatedAt, 0);
  assert.equal(health.oldestPendingAgeMs, 1_000);
});

test('buildDownlinkHealth normalizes invalid counters at health boundary', () => {
  const nowTs = Date.now();
  const health = buildDownlinkHealth({
    accountId: 'Primary',
    now: nowTs,
    outboxEntries: [
      {
        accountId: 'Primary',
        messageId: 'msg-pending',
        createdAt: nowTs - 1_000,
      },
    ],
    lastAckOkAt: null,
    lastAckTimeoutAt: nowTs - 1_000,
    recentAckTimeoutCount: Number.POSITIVE_INFINITY,
    activeConnectionCount: -1,
    lastInboundAt: nowTs - 1_000,
    lastActivityAt: null,
    onlineByConn: true,
  });

  assert.equal(health.pendingOutbox, 1);
  assert.equal(health.recentAckTimeoutCount, 0);
  assert.equal(health.activeConnectionCount, 0);
  assert.equal(health.recentInboundReachable, true);
  assert.equal(health.ackStalled, false);
  assert.equal(health.recommendReconnect, false);
});
