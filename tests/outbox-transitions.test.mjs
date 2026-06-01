import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyBncrPushFailureDecisionToEntry,
  applyBncrRetryRerouteDecisionToEntry,
  buildBncrAckOkTelemetryPatch,
  buildBncrAckRetryEntryPatch,
  buildBncrOutboxFailureEntryPatch,
  buildBncrOutboxPushSuccessEntryPatch,
} from '../src/runtime/outbox-transitions.ts';

function makeEntry(overrides = {}) {
  return {
    messageId: 'msg-1',
    accountId: 'Primary',
    sessionKey: 'agent:default:bncr:direct:abc',
    route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
    payload: { text: 'hello' },
    createdAt: 1_000,
    retryCount: 0,
    nextAttemptAt: 1_000,
    ...overrides,
  };
}

test('applyBncrRetryRerouteDecisionToEntry returns retry patch without mutating input entry', () => {
  const entry = makeEntry({ retryCount: 1, routeAttemptConnIds: ['conn-a'] });
  const decision = {
    kind: 'retry',
    nextRetryCount: 2,
    lastAttemptAt: 10_000,
    nextAttemptAt: 11_000,
    lastError: 'push-ack-timeout',
    attemptedConnIds: ['conn-a', 'conn-b'],
    fastReroutePending: true,
    routeAttemptRound: 3,
    hasUntriedAlternative: true,
    shouldFastReroute: true,
    revalidatedConnIds: ['conn-a'],
  };

  const next = applyBncrRetryRerouteDecisionToEntry(entry, decision);

  assert.notEqual(next, entry);
  assert.equal(entry.retryCount, 1);
  assert.deepEqual(entry.routeAttemptConnIds, ['conn-a']);
  assert.equal(next.retryCount, 2);
  assert.equal(next.lastAttemptAt, 10_000);
  assert.equal(next.nextAttemptAt, 11_000);
  assert.equal(next.lastError, 'push-ack-timeout');
  assert.deepEqual(next.routeAttemptConnIds, ['conn-a', 'conn-b']);
  assert.equal(next.fastReroutePending, true);
  assert.equal(next.routeAttemptRound, 3);
});

test('applyBncrPushFailureDecisionToEntry returns push-failure retry patch without mutating input entry', () => {
  const entry = makeEntry({ retryCount: 0, lastError: 'old' });
  const decision = {
    kind: 'retry',
    nextRetryCount: 1,
    lastAttemptAt: 20_000,
    nextAttemptAt: 22_000,
    lastError: 'push-retry',
  };

  const next = applyBncrPushFailureDecisionToEntry(entry, decision);

  assert.notEqual(next, entry);
  assert.equal(entry.retryCount, 0);
  assert.equal(entry.lastError, 'old');
  assert.equal(next.retryCount, 1);
  assert.equal(next.lastAttemptAt, 20_000);
  assert.equal(next.nextAttemptAt, 22_000);
  assert.equal(next.lastError, 'push-retry');
});

test('buildBncrAckRetryEntryPatch marks retry ack state without mutating input entry', () => {
  const entry = makeEntry({ awaitingRetryPush: false });
  const next = buildBncrAckRetryEntryPatch({
    entry,
    error: 'retryable-ack',
    nextAttemptAt: 31_000,
  });

  assert.notEqual(next, entry);
  assert.equal(entry.awaitingRetryPush, false);
  assert.equal(next.nextAttemptAt, 31_000);
  assert.equal(next.lastError, 'retryable-ack');
  assert.equal(next.awaitingRetryPush, true);
});

test('buildBncrOutboxFailureEntryPatch updates lastError without mutating input entry', () => {
  const entry = makeEntry({ lastError: 'old-error' });
  const next = buildBncrOutboxFailureEntryPatch({ entry, lastError: 'new-error' });

  assert.notEqual(next, entry);
  assert.equal(entry.lastError, 'old-error');
  assert.equal(next.lastError, 'new-error');
});

test('buildBncrOutboxPushSuccessEntryPatch records owner and attempted route without mutating input entry', () => {
  const entry = makeEntry({
    lastError: 'old-error',
    awaitingRetryPush: true,
    routeAttemptConnIds: ['conn-a'],
  });
  const next = buildBncrOutboxPushSuccessEntryPatch({
    entry,
    connIds: ['conn-b'],
    pushedAt: 40_000,
    ownerConnId: 'conn-b',
    ownerClientId: 'client-b',
    clearLastError: true,
  });

  assert.notEqual(next, entry);
  assert.deepEqual(entry.routeAttemptConnIds, ['conn-a']);
  assert.equal(entry.lastError, 'old-error');
  assert.equal(entry.awaitingRetryPush, true);
  assert.equal(next.lastPushAt, 40_000);
  assert.equal(next.lastPushConnId, 'conn-b');
  assert.equal(next.lastPushClientId, 'client-b');
  assert.equal(next.awaitingRetryPush, false);
  assert.deepEqual(next.routeAttemptConnIds, ['conn-a', 'conn-b']);
  assert.equal(next.lastError, undefined);
});

test('buildBncrOutboxPushSuccessEntryPatch infers single connection owner when explicit owner is missing', () => {
  const entry = makeEntry();
  const next = buildBncrOutboxPushSuccessEntryPatch({
    entry,
    connIds: ['conn-only'],
    pushedAt: 50_000,
  });

  assert.equal(next.lastPushConnId, 'conn-only');
  assert.deepEqual(next.routeAttemptConnIds, ['conn-only']);
});

test('buildBncrAckOkTelemetryPatch computes normal ack latency and recovery increment', () => {
  const entry = makeEntry({
    createdAt: 1_000,
    lastPushAt: 2_000,
    awaitingRetryPush: false,
  });

  const patch = buildBncrAckOkTelemetryPatch({
    entry,
    ackAt: 3_000,
    defaultAckTimeoutMs: 30_000,
  });

  assert.deepEqual(patch, {
    ackAt: 3_000,
    ackQueueLatencyMs: 2_000,
    ackPushLatencyMs: 1_000,
    lateAccepted: false,
    shouldResetAdaptiveAckRecovery: false,
    shouldIncrementAdaptiveAckRecovery: true,
  });
  assert.equal(entry.awaitingRetryPush, false);
});

test('buildBncrAckOkTelemetryPatch computes late ack telemetry without mutating entry', () => {
  const entry = makeEntry({
    createdAt: 1_000,
    lastPushAt: 2_000,
    awaitingRetryPush: true,
    lastError: 'accepted-after-timeout',
  });

  const patch = buildBncrAckOkTelemetryPatch({
    entry,
    ackAt: 9_000,
    defaultAckTimeoutMs: 30_000,
  });

  assert.deepEqual(patch, {
    ackAt: 9_000,
    ackQueueLatencyMs: 8_000,
    ackPushLatencyMs: 7_000,
    lateAccepted: true,
    shouldResetAdaptiveAckRecovery: true,
    shouldIncrementAdaptiveAckRecovery: false,
  });
  assert.equal(entry.awaitingRetryPush, true);
  assert.equal(entry.lastError, 'accepted-after-timeout');
});

test('buildBncrAckOkTelemetryPatch clamps invalid timestamps to non-negative latencies', () => {
  const entry = makeEntry({
    createdAt: Number.NaN,
    lastPushAt: 5_000,
  });

  const patch = buildBncrAckOkTelemetryPatch({
    entry,
    ackAt: 3_000,
    defaultAckTimeoutMs: 30_000,
  });

  assert.equal(patch.ackAt, 3_000);
  assert.equal(patch.ackQueueLatencyMs, 0);
  assert.equal(patch.ackPushLatencyMs, 0);
  assert.equal(patch.lateAccepted, false);
  assert.equal(patch.shouldIncrementAdaptiveAckRecovery, true);
});
