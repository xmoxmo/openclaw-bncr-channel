import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getRevalidatedAttemptReason,
  hasAlternativeLiveConnection,
  hasRecentInboundReachability,
  isEligibleOutboundPushConnection,
  isRecentlyReachableConn,
  resolveRecentInboundConnIds,
  selectOrderedOutboundPushConnections,
} from '../src/core/connection-reachability.ts';

const now = 100_000;

function conn(overrides = {}) {
  return {
    accountId: 'Primary',
    connId: 'conn-a',
    clientId: 'client-a',
    lastSeenAt: now - 1_000,
    ...overrides,
  };
}

test('hasRecentInboundReachability treats invalid timestamps as not reachable', () => {
  assert.equal(
    hasRecentInboundReachability({
      now,
      windowMs: 5_000,
      lastInboundAt: now - 1_000,
      lastActivityAt: 0,
    }),
    true,
  );
  assert.equal(
    hasRecentInboundReachability({
      now,
      windowMs: 5_000,
      lastInboundAt: Number.NaN,
      lastActivityAt: Number.POSITIVE_INFINITY,
    }),
    false,
  );
  assert.equal(
    hasRecentInboundReachability({
      now: Number.NaN,
      windowMs: 5_000,
      lastInboundAt: now - 1_000,
      lastActivityAt: 0,
    }),
    false,
  );
  assert.equal(
    hasRecentInboundReachability({
      now,
      windowMs: Number.NaN,
      lastInboundAt: now - 1_000,
      lastActivityAt: 0,
    }),
    false,
  );
});

test('resolveRecentInboundConnIds filters stale and invalid connection timestamps', () => {
  const ids = resolveRecentInboundConnIds({
    accountId: 'Primary',
    now,
    connectTtlMs: 10_000,
    recentInboundReachable: true,
    connections: [
      conn({ connId: 'fresh' }),
      conn({ connId: 'stale', lastSeenAt: now - 30_000 }),
      conn({ connId: 'bad', lastSeenAt: Number.NaN }),
      conn({ accountId: 'Other', connId: 'other' }),
      conn({ connId: '' }),
    ],
  });

  assert.deepEqual([...ids].sort(), ['fresh']);
});

test('isRecentlyReachableConn falls back to the active matching connection', () => {
  assert.equal(
    isRecentlyReachableConn({
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      recentConnIds: new Set(),
      activeConnection: conn(),
    }),
    true,
  );
  assert.equal(
    isRecentlyReachableConn({
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'different-client',
      recentConnIds: new Set(),
      activeConnection: conn(),
    }),
    false,
  );
});

test('hasAlternativeLiveConnection ignores current and invalid live candidates', () => {
  assert.equal(
    hasAlternativeLiveConnection({
      accountId: 'Primary',
      now,
      connectTtlMs: 10_000,
      currentConnId: 'conn-a',
      connections: [
        conn({ connId: 'conn-a' }),
        conn({ connId: 'stale', lastSeenAt: now - 20_000 }),
        conn({ connId: 'bad', lastSeenAt: Number.POSITIVE_INFINITY }),
        conn({ connId: 'conn-b', clientId: 'client-b' }),
      ],
    }),
    true,
  );
  assert.equal(
    hasAlternativeLiveConnection({
      accountId: 'Primary',
      now,
      connectTtlMs: 10_000,
      currentConnId: 'conn-a',
      connections: [conn({ connId: 'conn-a' }), conn({ connId: 'bad', lastSeenAt: Number.NaN })],
    }),
    false,
  );
});

test('getRevalidatedAttemptReason treats invalid connection numbers as neutral', () => {
  const result = getRevalidatedAttemptReason({
    entry: { accountId: 'Primary', messageId: 'msg-1', lastAttemptAt: now - 5_000 },
    connId: 'conn-a',
    accountId: 'Primary',
    now,
    connectTtlMs: 10_000,
    recentInboundReachable: true,
    connections: [
      conn({
        preferredForOutboundUntil: Number.POSITIVE_INFINITY,
        outboundReadyUntil: Number.NaN,
        lastAckOkAt: Number.NaN,
        lastPushTimeoutAt: Number.POSITIVE_INFINITY,
      }),
    ],
  });

  assert.equal(result, null);
});

test('isEligibleOutboundPushConnection filters stale inbound-only and missing connections', () => {
  assert.equal(
    isEligibleOutboundPushConnection({ connection: conn(), now, connectTtlMs: 10_000 }),
    true,
  );
  assert.equal(
    isEligibleOutboundPushConnection({
      connection: conn({ lastSeenAt: now - 20_000 }),
      now,
      connectTtlMs: 10_000,
    }),
    false,
  );
  assert.equal(
    isEligibleOutboundPushConnection({
      connection: conn({ inboundOnly: true }),
      now,
      connectTtlMs: 10_000,
    }),
    false,
  );
  assert.equal(
    isEligibleOutboundPushConnection({ connection: null, now, connectTtlMs: 10_000 }),
    false,
  );
});

test('selectOrderedOutboundPushConnections preserves outbound candidate priority order', () => {
  const ordered = selectOrderedOutboundPushConnections({
    accountId: 'Primary',
    now,
    connectTtlMs: 10_000,
    recentInboundConnIds: new Set(['recent-inbound']),
    connections: [
      conn({
        connId: 'stale',
        clientId: 'stale',
        lastSeenAt: now - 20_000,
        preferredForOutboundUntil: now + 10_000,
      }),
      conn({
        connId: 'inbound-only',
        clientId: 'inbound-only',
        inboundOnly: true,
        preferredForOutboundUntil: now + 10_000,
      }),
      conn({
        connId: 'fresh-ack',
        clientId: 'fresh-ack',
        connectedAt: now - 9_000,
        lastAckOkAt: now - 100,
      }),
      conn({
        connId: 'penalized-preferred',
        clientId: 'penalized-preferred',
        preferredForOutboundUntil: now + 10_000,
        lastPushTimeoutAt: now - 100,
      }),
      conn({
        connId: 'preferred',
        clientId: 'preferred',
        preferredForOutboundUntil: now + 10_000,
        lastPushTimeoutAt: now - 40_000,
      }),
      conn({
        connId: 'recent-inbound',
        clientId: 'recent-inbound',
        connectedAt: now - 8_000,
      }),
      conn({
        connId: 'other-account',
        clientId: 'other-account',
        accountId: 'Other',
        preferredForOutboundUntil: now + 10_000,
      }),
    ],
  });

  assert.deepEqual(
    ordered.map((item) => item.connId),
    ['preferred', 'penalized-preferred', 'fresh-ack', 'recent-inbound'],
  );
});
