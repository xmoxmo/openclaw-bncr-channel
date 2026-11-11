import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOutboundAckSuccess,
  applyOutboundFailure,
  classifyOutboundFailure,
  effectiveOutboundFailureScore,
  MAX_OUTBOUND_FAILURE_COUNT,
  OUTBOUND_FAILURE_DECAY_MS,
  OUTBOUND_FAILURE_KIND,
} from '../../src/core/outbound-connection-health.ts';

const base = {
  accountId: 'Primary',
  connId: 'conn-a',
  clientId: 'client-a',
  connectedAt: 1,
  lastSeenAt: 2,
};

test('outbound failure classification separates transport, broadcast, and business causes', () => {
  assert.equal(
    classifyOutboundFailure({ error: new Error('request timed out'), stage: 'rpc' }),
    OUTBOUND_FAILURE_KIND.RPC_TRANSPORT_TIMEOUT,
  );
  assert.equal(
    classifyOutboundFailure({ error: new Error('websocket disconnected'), stage: 'broadcast' }),
    OUTBOUND_FAILURE_KIND.BROADCAST_FAILURE,
  );
  assert.equal(
    classifyOutboundFailure({ error: new Error('business rejected'), stage: 'broadcast' }),
    OUTBOUND_FAILURE_KIND.BUSINESS_ERROR,
  );
});

test('only connection-scoped failures change outbound health', () => {
  const business = applyOutboundFailure(base, {
    kind: OUTBOUND_FAILURE_KIND.BUSINESS_ERROR,
    at: 100,
  });
  assert.equal(business, base);

  const timeout = applyOutboundFailure(base, {
    kind: OUTBOUND_FAILURE_KIND.ACK_TIMEOUT,
    at: 100,
  });
  assert.equal(timeout.outboundFailureCount, 1);
  assert.equal(timeout.lastPushTimeoutAt, 100);
  assert.equal(timeout.lastOutboundFailureKind, OUTBOUND_FAILURE_KIND.ACK_TIMEOUT);
});

test('outbound failure count is bounded and decays to neutral after the time window', () => {
  let conn = base;
  for (let i = 0; i < MAX_OUTBOUND_FAILURE_COUNT + 3; i += 1) {
    conn = applyOutboundFailure(conn, {
      kind: OUTBOUND_FAILURE_KIND.BROADCAST_FAILURE,
      at: 1_000 + i,
    });
  }
  assert.equal(conn.outboundFailureCount, MAX_OUTBOUND_FAILURE_COUNT);
  assert.ok(effectiveOutboundFailureScore(conn, 1_010) > 0);
  assert.equal(effectiveOutboundFailureScore(conn, 1_010 + OUTBOUND_FAILURE_DECAY_MS), 0);
});

test('ack success clears active failure health and records fresh outbound evidence', () => {
  const failed = applyOutboundFailure(base, {
    kind: OUTBOUND_FAILURE_KIND.RPC_TRANSPORT_TIMEOUT,
    at: 100,
  });
  const recovered = applyOutboundAckSuccess(failed, 200);
  assert.equal(recovered.lastAckOkAt, 200);
  assert.equal(recovered.outboundFailureCount, 0);
  assert.equal(recovered.lastOutboundFailureAt, undefined);
  assert.equal(recovered.lastOutboundFailureKind, undefined);
});
