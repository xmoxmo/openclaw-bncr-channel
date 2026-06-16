import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPushFailureDebugInfo,
  buildRetryRerouteDebugInfo,
} from '../../src/messaging/outbound/diagnostics.ts';

test('buildRetryRerouteDebugInfo returns retry payload copies without mutating decision arrays', () => {
  const decision = {
    kind: 'retry',
    nextRetryCount: 2,
    lastAttemptAt: 12_000,
    nextAttemptAt: 13_000,
    lastError: 'push-ack-timeout',
    attemptedConnIds: ['conn-a'],
    fastReroutePending: true,
    routeAttemptRound: 0,
    hasUntriedAlternative: true,
    shouldFastReroute: true,
    revalidatedConnIds: ['conn-a'],
  };

  const result = buildRetryRerouteDebugInfo({
    messageId: 'mid-1',
    accountId: 'Primary',
    currentConnId: 'conn-a',
    decision,
    availableConnIds: ['conn-a', 'conn-b'],
  });

  assert.deepEqual(result, {
    messageId: 'mid-1',
    accountId: 'Primary',
    currentConnId: 'conn-a',
    attemptedConnIds: ['conn-a'],
    availableConnIds: ['conn-a', 'conn-b'],
    revalidatedConnIds: ['conn-a'],
    hasUntriedAlternative: true,
    shouldFastReroute: true,
    routeAttemptRound: 0,
    nextAttemptAt: 13_000,
    fastReroutePending: true,
    nextRetryCount: 2,
    lastAttemptAt: 12_000,
    lastError: 'push-ack-timeout',
    kind: 'retry',
  });

  assert.notEqual(result.attemptedConnIds, decision.attemptedConnIds);
  assert.notEqual(result.revalidatedConnIds, decision.revalidatedConnIds);
});

test('buildRetryRerouteDebugInfo returns dead-letter payload when decision is terminal', () => {
  const result = buildRetryRerouteDebugInfo({
    messageId: 'mid-2',
    accountId: 'Primary',
    currentConnId: 'conn-a',
    decision: {
      kind: 'dead-letter',
      terminalReason: 'push-delivery-unconfirmed',
      nextRetryCount: 4,
      lastAttemptAt: 20_000,
    },
    availableConnIds: ['conn-a'],
  });

  assert.deepEqual(result, {
    messageId: 'mid-2',
    accountId: 'Primary',
    currentConnId: 'conn-a',
    availableConnIds: ['conn-a'],
    kind: 'dead-letter',
    terminalReason: 'push-delivery-unconfirmed',
    nextRetryCount: 4,
    lastAttemptAt: 20_000,
  });
});

test('buildPushFailureDebugInfo includes optional kind and retryable fields when provided', () => {
  const result = buildPushFailureDebugInfo({
    messageId: 'mid-fail-rich',
    accountId: 'Primary',
    retryCount: 2,
    kind: 'file-transfer',
    retryable: true,
    lastError: 'file-transfer-error',
  });

  assert.deepEqual(result, {
    messageId: 'mid-fail-rich',
    accountId: 'Primary',
    kind: 'file-transfer',
    retryable: true,
    retryCount: 2,
    error: 'file-transfer-error',
  });
});

test('buildPushFailureDebugInfo falls back to push-retry when lastError is absent', () => {
  const result = buildPushFailureDebugInfo({
    messageId: 'mid-3',
    accountId: 'Primary',
    retryCount: 3,
  });

  assert.deepEqual(result, {
    messageId: 'mid-3',
    accountId: 'Primary',
    retryCount: 3,
    error: 'push-retry',
  });
});
