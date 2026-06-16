import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrOutboxDrainAck } from '../../src/plugin/outbox-drain-ack.ts';
import { createBncrOutboxDrainFailure } from '../../src/plugin/outbox-drain-failure.ts';
import { createBncrOutboxDrainRuntime } from '../../src/plugin/outbox-drain-runtime.ts';

function makeEntry(overrides = {}) {
  return {
    messageId: 'msg-1',
    accountId: 'Primary',
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: 'hello' },
    createdAt: 1,
    nextAttemptAt: 1,
    retryCount: 0,
    ...overrides,
  };
}

test('outbox drain ack logs wait-start and reroutes retry entries', () => {
  const calls = { logs: [], set: [], save: 0, tele: 0, reroute: [] };
  const ack = createBncrOutboxDrainAck({
    bridgeId: 'bridge-1',
    pushEvent: 'push',
    now: () => 100,
    defaultAckTimeoutMs: 30_000,
    adaptiveAckTimeoutEnabled: true,
    outboxSize: () => 1,
    formatDisplayScope: () => 'Bncr:tgBot:10001',
    isFileTransferEntry: () => false,
    setOutboxEntry(messageId, entry) {
      calls.set.push([messageId, entry]);
    },
    scheduleSave() {
      calls.save += 1;
    },
    moveToDeadLetter() {
      throw new Error('should not dead-letter');
    },
    recordAckTimeoutTelemetry() {
      calls.tele += 1;
    },
    logInfo(scope, message) {
      calls.logs.push([scope, message]);
    },
    logOutboxAckReroute(args) {
      calls.reroute.push(args);
    },
  });
  const entry = makeEntry({ lastPushConnId: 'conn-1', lastPushClientId: 'client-1' });

  ack.logAckWaitStart({ entry, requireAck: true, onlineNow: true, recentInboundReachable: true });
  const result = ack.handleAckTimeoutReroute({
    accountId: 'Primary',
    entry,
    requireAck: true,
    currentConnId: 'conn-1',
    availableConnIds: ['conn-1', 'conn-2'],
    decision: {
      kind: 'retry',
      retryCount: 1,
      nextAttemptAt: 500,
      clearAttemptedRoutes: false,
      appendAttemptedRoute: true,
    },
    localNextDelay: null,
    ackTimeoutMs: 10_000,
    updateMinOutboxDelay: (_current, next) => next,
  });

  assert.equal(calls.logs.length, 1);
  assert.equal(calls.save, 1);
  assert.equal(calls.tele, 1);
  assert.equal(calls.reroute.length, 1);
  assert.equal(result.kind, 'retry');
});

test('outbox drain failure defers pre-push guards and retries push failures', () => {
  const scheduled = [];
  const outbox = new Map();
  const failure = createBncrOutboxDrainFailure({
    backoffMs: (retryCount) => retryCount * 1000,
    outbox,
    isPrePushGuardDeferral(entry) {
      return entry.lastError === 'no-gateway-context';
    },
    moveToDeadLetter() {
      throw new Error('should not dead-letter');
    },
    scheduleSave() {},
    outboxDrainSchedule: {
      scheduleAccountWait(args) {
        scheduled.push(args);
        return args.wait;
      },
    },
    maxRetry: 3,
    prePushGuardRetryDelayMs: 250,
  });

  const deferred = failure({
    accountId: 'Primary',
    entry: makeEntry({ lastError: 'no-gateway-context' }),
    localNextDelay: null,
    attemptedAt: 100,
    updateMinOutboxDelay: (_current, next) => next,
  });
  const retried = failure({
    accountId: 'Primary',
    entry: makeEntry({ messageId: 'msg-2', lastError: 'push-error' }),
    localNextDelay: null,
    attemptedAt: 100,
    updateMinOutboxDelay: (_current, next) => next,
  });

  assert.equal(deferred.action, 'break');
  assert.equal(retried.action, 'break');
  assert.equal(scheduled.length, 2);
  assert.equal(outbox.has('msg-2'), true);
});

test('outbox drain runtime flushes due entries through composed handlers', async () => {
  const entry = makeEntry();
  const calls = { pushed: [], merged: [], scheduled: [] };
  const runtime = createBncrOutboxDrainRuntime({
    bridgeId: 'bridge-1',
    now: () => 100,
    asString: (value, fallback = '') =>
      typeof value === 'string' ? value : value == null ? fallback : String(value),
    backoffMs: () => 1000,
    isPlainObject: (value) => Boolean(value) && typeof value === 'object',
    normalizeAccountId: (accountId) => String(accountId || '').trim(),
    stopped: () => false,
    outbox: new Map([[entry.messageId, entry]]),
    deadLetter: () => [],
    connectionsValues: function* () {},
    gatewayContextAvailable: () => true,
    messageAckWaiterCount: () => 0,
    fileAckWaiterCount: () => 0,
    activeConnectionCount: () => 0,
    getAccountPendingOutboxEntries: () => [entry],
    pushDrainRunningAccounts: new Set(),
    pushDrainRunningSinceByAccount: new Map(),
    pushDrainStuckWarnedAtByAccount: new Map(),
    isOnline: () => true,
    hasRecentInboundReachability: () => true,
    isOutboundAckRequired: () => false,
    resolveMessageAckTimeoutMs: () => 30_000,
    async waitForMessageAck() {
      return 'acked';
    },
    logOutboxAckWait() {},
    degradeOutboundCapability() {},
    resolvePushConnIds: () => new Set(['conn-1']),
    async sleepMs() {},
    schedulePushDrain(delayMs) {
      calls.scheduled.push(delayMs);
    },
    outboxDrainSchedule: {
      scheduleAccountWait(args) {
        return args.wait;
      },
      scheduleAccountYield(args) {
        return args.localNextDelay ?? 0;
      },
      mergeAccountNextDelay(args) {
        calls.merged.push(args);
        return args.localNextDelay;
      },
      scheduleFlushNextDrain(args) {
        calls.scheduled.push(args.globalNextDelay);
      },
    },
    outboxDrainAck: {
      logAckWaitStart() {},
      handleAckTimeoutReroute() {
        return { kind: 'retry', localNextDelay: 1 };
      },
    },
    async tryPushEntry(pushedEntry) {
      calls.pushed.push(pushedEntry.messageId);
      return false;
    },
    handleFileTransferPushFailure() {},
    handleTextPushFailure() {},
    isPrePushGuardDeferral: () => true,
    moveToDeadLetter() {},
    scheduleSave() {},
    logInfo() {},
    logWarn() {},
    logError() {},
    flushTriggerTimer: 'timer',
    flushReasonScheduledDrain: 'scheduled-drain',
    pushDrainExceptionRetryLimit: 2,
    pushDrainExceptionRetryDelayMs: 10,
    pushDrainStuckWarnMs: 10_000,
    pushDrainIntervalMs: 5,
    pushDrainAccountTimeBudgetMs: 1_000,
    pushDrainAccountBudget: 10,
    pushAckTimeoutMs: 30_000,
    maxRetry: 3,
    prePushGuardRetryDelayMs: 250,
  });

  await runtime.flushPushQueue({ accountId: 'Primary', trigger: 'manual', reason: 'test' });

  assert.deepEqual(calls.pushed, ['msg-1']);
});
