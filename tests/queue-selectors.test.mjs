import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOutboxOnlineDebugInfo,
  clampOutboxDrainDelay,
  computeNextOutboxDelay,
  computeOutboxRetryWait,
  findDueOutboxEntry,
  listAccountOutboxEntries,
  selectOutboxFileTransferRouteCandidates,
  selectOutboxRouteCandidates,
  selectOutboxTargetAccounts,
  updateMinOutboxDelay,
} from '../src/messaging/outbound/queue-selectors.ts';

function normalizeAccountId(value) {
  return `${value || ''}`.trim() || 'Primary';
}

function makeEntry(messageId, accountId, createdAt, nextAttemptAt) {
  return {
    messageId,
    accountId,
    sessionKey: 'agent:orion:bncr:direct:demo',
    route: { platform: 'tgBot', groupId: '-1001', userId: '6278285192' },
    payload: {},
    createdAt,
    retryCount: 0,
    nextAttemptAt,
  };
}

test('selectOutboxTargetAccounts keeps explicit account filter', () => {
  const result = selectOutboxTargetAccounts({
    accountId: 'Primary',
    outboxEntries: [makeEntry('m1', 'Other', 1, 1)],
    normalizeAccountId,
  });

  assert.deepEqual(result, ['Primary']);
});

test('selectOutboxTargetAccounts deduplicates normalized account ids from outbox', () => {
  const result = selectOutboxTargetAccounts({
    outboxEntries: [
      makeEntry('m1', 'Primary', 1, 1),
      makeEntry('m2', 'Primary', 2, 2),
      makeEntry('m3', 'Other', 3, 3),
    ],
    normalizeAccountId,
  });

  assert.deepEqual(result, ['Primary', 'Other']);
});

test('listAccountOutboxEntries filters by account and sorts by createdAt', () => {
  const result = listAccountOutboxEntries({
    accountId: 'Primary',
    outboxEntries: [
      makeEntry('m3', 'Primary', 30, 300),
      makeEntry('m1', 'Primary', 10, 100),
      makeEntry('m2', 'Other', 20, 200),
    ],
    normalizeAccountId,
  });

  assert.deepEqual(
    result.map((entry) => entry.messageId),
    ['m1', 'm3'],
  );
});

test('findDueOutboxEntry returns first due entry in created order', () => {
  const entries = [
    makeEntry('m1', 'Primary', 10, 200),
    makeEntry('m2', 'Primary', 20, 100),
    makeEntry('m3', 'Primary', 30, 300),
  ];

  const due = findDueOutboxEntry(entries, 150);
  assert.equal(due?.messageId, 'm2');
});

test('computeNextOutboxDelay returns wait until earliest future entry when none are due', () => {
  const entries = [
    makeEntry('m1', 'Primary', 10, 400),
    makeEntry('m2', 'Primary', 20, 700),
  ];

  assert.equal(computeNextOutboxDelay(entries, 250), 150);
});

test('computeNextOutboxDelay returns zero when a due entry already exists', () => {
  const entries = [
    makeEntry('m1', 'Primary', 10, 200),
    makeEntry('m2', 'Primary', 20, 500),
  ];

  assert.equal(computeNextOutboxDelay(entries, 250), 0);
});

test('computeOutboxRetryWait returns non-negative wait until next attempt', () => {
  assert.equal(computeOutboxRetryWait(5000, 4500), 500);
  assert.equal(computeOutboxRetryWait(4500, 5000), 0);
  assert.equal(computeOutboxRetryWait(Number.NaN, 5000), 0);
});

test('updateMinOutboxDelay keeps the smallest non-null delay', () => {
  assert.equal(updateMinOutboxDelay(null, null), null);
  assert.equal(updateMinOutboxDelay(null, 800), 800);
  assert.equal(updateMinOutboxDelay(1200, null), 1200);
  assert.equal(updateMinOutboxDelay(1200, 800), 800);
  assert.equal(updateMinOutboxDelay(800, 1200), 800);
});

test('buildOutboxOnlineDebugInfo formats connection diagnostics payload without mutating source', () => {
  const connections = [
    {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: 100,
      lastSeenAt: 200,
    },
  ];

  const result = buildOutboxOnlineDebugInfo({
    bridgeId: 'bridge-1',
    accountId: 'Primary',
    online: true,
    recentInboundReachable: false,
    connections,
  });

  assert.deepEqual(result, {
    bridge: 'bridge-1',
    accountId: 'Primary',
    online: true,
    recentInboundReachable: false,
    connections: [
      {
        accountId: 'Primary',
        connId: 'conn-a',
        clientId: 'client-a',
        lastSeenAt: 200,
      },
    ],
  });
  assert.equal(connections[0].connectedAt, 100);
});

test('selectOutboxRouteCandidates prefers owner when owner is still in preferred candidates', () => {
  const result = selectOutboxRouteCandidates({
    routeCandidates: ['conn-a', 'conn-b'],
    attemptedConnIds: [],
    recentInboundConnIds: [],
    ownerConnId: 'conn-b',
    recentInboundReachable: false,
    isRevalidatedAttemptedConn: () => false,
  });

  assert.deepEqual(result, {
    connIds: ['conn-b'],
    routeReason: 'owner',
    recentInboundReachable: false,
    ownerConnId: 'conn-b',
  });
});

test('selectOutboxRouteCandidates falls back to recent inbound when no active candidates remain', () => {
  const result = selectOutboxRouteCandidates({
    routeCandidates: [],
    attemptedConnIds: ['conn-a'],
    recentInboundConnIds: ['conn-a', 'conn-b'],
    recentInboundReachable: true,
    isRevalidatedAttemptedConn: () => false,
  });

  assert.deepEqual(result, {
    connIds: ['conn-b'],
    routeReason: 'recent-inbound-fallback',
    recentInboundReachable: true,
  });
});

test('selectOutboxRouteCandidates labels all-visible path when only attempted visible candidates remain', () => {
  const result = selectOutboxRouteCandidates({
    routeCandidates: ['conn-a', 'conn-b'],
    attemptedConnIds: ['conn-a', 'conn-b'],
    recentInboundConnIds: [],
    recentInboundReachable: false,
    isRevalidatedAttemptedConn: () => false,
  });

  assert.deepEqual(result, {
    connIds: ['conn-a', 'conn-b'],
    routeReason: 'active-connections-all-visible',
    recentInboundReachable: false,
  });
});

test('selectOutboxRouteCandidates labels revalidated path when attempted candidate becomes eligible again', () => {
  const result = selectOutboxRouteCandidates({
    routeCandidates: ['conn-a', 'conn-b'],
    attemptedConnIds: ['conn-a', 'conn-b'],
    recentInboundConnIds: [],
    recentInboundReachable: false,
    isRevalidatedAttemptedConn: (connId) => connId === 'conn-b',
  });

  assert.deepEqual(result, {
    connIds: ['conn-a', 'conn-b'],
    routeReason: 'active-connections-revalidated',
    recentInboundReachable: false,
  });
});

test('selectOutboxFileTransferRouteCandidates prefers unattempted owner and keeps file-transfer reason vocabulary', () => {
  const result = selectOutboxFileTransferRouteCandidates({
    routeCandidates: ['conn-a', 'conn-b'],
    attemptedConnIds: [],
    recentInboundConnIds: [],
    ownerConnId: 'conn-b',
    recentInboundReachable: false,
    isRevalidatedAttemptedConn: () => false,
  });

  assert.deepEqual(result, {
    connIds: ['conn-b'],
    routeReason: 'owner',
    recentInboundReachable: false,
    ownerConnId: 'conn-b',
  });
});

test('selectOutboxFileTransferRouteCandidates reuses attempted active candidates when they are revalidated', () => {
  const result = selectOutboxFileTransferRouteCandidates({
    routeCandidates: ['conn-a', 'conn-b'],
    attemptedConnIds: ['conn-a', 'conn-b'],
    recentInboundConnIds: [],
    recentInboundReachable: false,
    isRevalidatedAttemptedConn: (connId) => connId === 'conn-b',
  });

  assert.deepEqual(result, {
    connIds: ['conn-b'],
    routeReason: 'active-connections',
    recentInboundReachable: false,
  });
});

test('selectOutboxFileTransferRouteCandidates falls back to recent inbound when no active candidate remains', () => {
  const result = selectOutboxFileTransferRouteCandidates({
    routeCandidates: [],
    attemptedConnIds: ['conn-a'],
    recentInboundConnIds: ['conn-a', 'conn-b'],
    recentInboundReachable: true,
    isRevalidatedAttemptedConn: () => false,
  });

  assert.deepEqual(result, {
    connIds: ['conn-b'],
    routeReason: 'recent-inbound-fallback',
    recentInboundReachable: true,
  });
});
