import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computePushFailureDecision,
  computeRetryRerouteDecision,
} from '../src/messaging/outbound/retry-policy.ts';

test('computeRetryRerouteDecision schedules fast reroute when ack timeout has untried alternative', () => {
  const result = computeRetryRerouteDecision(
    {
      nowMs: 10_000,
      maxRetry: 5,
      requireAck: true,
      currentRetryCount: 0,
      currentRouteAttemptRound: 0,
      currentFastReroutePending: false,
      currentConnId: 'conn-a',
      attemptedConnIds: ['conn-a'],
      availableConnIds: ['conn-a', 'conn-b'],
    },
    { backoffMs: (retryCount) => retryCount * 5_000 },
  );

  assert.equal(result.kind, 'retry');
  if (result.kind !== 'retry') return;
  assert.equal(result.shouldFastReroute, true);
  assert.equal(result.hasUntriedAlternative, true);
  assert.equal(result.nextAttemptAt, 11_000);
  assert.deepEqual(result.attemptedConnIds, ['conn-a']);
  assert.equal(result.fastReroutePending, true);
  assert.equal(result.routeAttemptRound, 0);
  assert.deepEqual(result.revalidatedConnIds, ['conn-a']);
});

test('computeRetryRerouteDecision clears attempted routes after exhausting current alternatives', () => {
  const result = computeRetryRerouteDecision(
    {
      nowMs: 20_000,
      maxRetry: 5,
      requireAck: true,
      currentRetryCount: 1,
      currentRouteAttemptRound: 2,
      currentFastReroutePending: true,
      currentConnId: 'conn-a',
      attemptedConnIds: ['conn-a', 'conn-b'],
      availableConnIds: ['conn-a', 'conn-b'],
    },
    { backoffMs: (retryCount) => retryCount * 1_000 },
  );

  assert.equal(result.kind, 'retry');
  if (result.kind !== 'retry') return;
  assert.equal(result.hasUntriedAlternative, false);
  assert.equal(result.shouldFastReroute, false);
  assert.deepEqual(result.attemptedConnIds, []);
  assert.equal(result.fastReroutePending, false);
  assert.equal(result.routeAttemptRound, 3);
  assert.equal(result.nextAttemptAt, 22_000);
});

test('computeRetryRerouteDecision returns dead-letter once retry limit is exceeded', () => {
  const result = computeRetryRerouteDecision(
    {
      nowMs: 30_000,
      maxRetry: 2,
      requireAck: false,
      currentRetryCount: 2,
      currentRouteAttemptRound: 0,
      currentFastReroutePending: false,
      attemptedConnIds: [],
      availableConnIds: [],
      lastError: 'push-delivery-unconfirmed',
    },
    { backoffMs: (retryCount) => retryCount * 1_000 },
  );

  assert.equal(result.kind, 'dead-letter');
  if (result.kind !== 'dead-letter') return;
  assert.equal(result.terminalReason, 'push-delivery-unconfirmed');
  assert.equal(result.nextRetryCount, 3);
  assert.equal(result.lastAttemptAt, 30_000);
});

test('computePushFailureDecision schedules backoff retry before max retry', () => {
  const result = computePushFailureDecision(
    {
      nowMs: 40_000,
      maxRetry: 5,
      currentRetryCount: 1,
      lastError: 'push-retry',
    },
    { backoffMs: (retryCount) => retryCount * 2_000 },
  );

  assert.equal(result.kind, 'retry');
  if (result.kind !== 'retry') return;
  assert.equal(result.nextRetryCount, 2);
  assert.equal(result.lastAttemptAt, 40_000);
  assert.equal(result.nextAttemptAt, 44_000);
  assert.equal(result.lastError, 'push-retry');
});

test('computePushFailureDecision returns dead-letter after retry limit', () => {
  const result = computePushFailureDecision(
    {
      nowMs: 50_000,
      maxRetry: 1,
      currentRetryCount: 1,
      lastError: 'push-retry-limit',
    },
    { backoffMs: (retryCount) => retryCount * 2_000 },
  );

  assert.equal(result.kind, 'dead-letter');
  if (result.kind !== 'dead-letter') return;
  assert.equal(result.terminalReason, 'push-retry-limit');
  assert.equal(result.nextRetryCount, 2);
  assert.equal(result.lastAttemptAt, 50_000);
});
