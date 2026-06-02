import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBncrBridge } from '../src/channel.ts';
import { getRevalidatedAttemptReason } from '../src/core/connection-reachability.ts';

function createApiStub(logs = null) {
  const currentConfig = {};
  return {
    logger: {
      info(scope, message) {
        logs?.push?.({ level: 'info', scope, message });
      },
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {
      config: {
        current() {
          return currentConfig;
        },
        get() {
          return currentConfig;
        },
        async loadConfig() {
          return currentConfig;
        },
      },
      channel: {
        routing: {
          resolveAgentRoute() {
            return { sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion' };
          },
        },
      },
    },
  };
}

function makeEntry(messageId, text = messageId) {
  return {
    messageId,
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
    payload: {
      type: 'message.outbound',
      messageId,
      idempotencyKey: messageId,
      sessionKey: 'agent:orion:bncr:direct:demo',
      message: {
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        type: 'text',
        msg: text,
        path: '',
        base64: '',
        fileName: '',
      },
      ts: Date.now(),
    },
    createdAt: Date.now(),
    retryCount: 0,
    nextAttemptAt: Date.now(),
  };
}

function cleanupBridge(bridge) {
  if (bridge.saveTimer) clearTimeout(bridge.saveTimer);
  if (bridge.pushTimer) clearTimeout(bridge.pushTimer);

  for (const waiter of bridge.messageAckWaiters?.values?.() || []) {
    clearTimeout(waiter.timer);
  }
  bridge.messageAckWaiters?.clear?.();
  for (const waiter of bridge.fileAckWaiters?.values?.() || []) {
    clearTimeout(waiter.timer);
  }
  bridge.fileAckWaiters?.clear?.();
}

function spyFlushPushQueue(bridge) {
  const calls = [];
  const original = bridge.flushPushQueue.bind(bridge);
  bridge.flushPushQueue = (args) => {
    calls.push(args);
    return Promise.resolve();
  };
  return {
    calls,
    restore() {
      bridge.flushPushQueue = original;
    },
  };
}

test('schedulePushDrain does not register a second timer while one is already pending', async () => {
  const bridge = createBncrBridge(createApiStub());
  const originalSetTimeout = global.setTimeout;
  const timers = [];

  try {
    global.setTimeout = (fn, delay, ...args) => {
      const timer = { fn, delay, args, cleared: false };
      timers.push(timer);
      return timer;
    };

    bridge.schedulePushDrain(1234);
    bridge.schedulePushDrain(5);

    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 1234);
    assert.ok(bridge.pushTimer);
  } finally {
    global.setTimeout = originalSetTimeout;
    bridge.pushTimer = null;
    cleanupBridge(bridge);
  }
});

test('schedulePushDrain clamps delay into supported range', async () => {
  const bridge = createBncrBridge(createApiStub());
  const originalSetTimeout = global.setTimeout;
  const timers = [];

  try {
    global.setTimeout = (fn, delay, ...args) => {
      const timer = { fn, delay, args, cleared: false };
      timers.push(timer);
      return timer;
    };

    bridge.schedulePushDrain(-50);
    bridge.pushTimer = null;
    bridge.schedulePushDrain(99_999);

    assert.equal(timers.length, 2);
    assert.equal(timers[0].delay, 0);
    assert.equal(timers[1].delay, 30_000);
  } finally {
    global.setTimeout = originalSetTimeout;
    bridge.pushTimer = null;
    cleanupBridge(bridge);
  }
});

test('flushPushQueue does not push entries whose nextAttemptAt is still in the future', async () => {
  const bridge = createBncrBridge(createApiStub());
  const scheduled = [];

  try {
    const futureEntry = makeEntry('msg-future-only', 'future only');
    futureEntry.nextAttemptAt = Date.now() + 5_000;
    bridge.outbox.set(futureEntry.messageId, futureEntry);

    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };
    bridge.tryPushEntry = async () => {
      throw new Error('should not push future-due entry');
    };

    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'future-only' });

    assert.equal(bridge.outbox.has(futureEntry.messageId), true);
    assert.equal(scheduled.length, 1);
    assert.ok(scheduled[0] > 0);
    assert.ok(scheduled[0] <= 5_000);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue does not degrade or reroute when pushed entry leaves outbox before ack handling', async () => {
  const bridge = createBncrBridge(createApiStub());
  const scheduled = [];
  let degraded = false;
  let waited = false;

  try {
    const entry = makeEntry('msg-removed-after-push', 'removed after push');
    entry.lastPushConnId = 'conn-a';
    entry.lastPushClientId = 'client-a';
    bridge.outbox.set(entry.messageId, entry);

    bridge.tryPushEntry = async (pushedEntry) => {
      assert.equal(pushedEntry.messageId, entry.messageId);
      bridge.outbox.delete(pushedEntry.messageId);
      return true;
    };
    bridge.waitForMessageAck = async () => {
      waited = true;
      return 'timeout';
    };
    bridge.degradeOutboundCapability = () => {
      degraded = true;
    };
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };
    bridge.sleepMs = async () => {};
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => true;

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'removed-after-push',
    });

    assert.equal(waited, true);
    assert.equal(degraded, false);
    assert.equal(bridge.outbox.has(entry.messageId), false);
    assert.deepEqual(scheduled, []);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue does not wait for ack or degrade when no-ack pushed entry leaves outbox', async () => {
  const bridge = createBncrBridge(createApiStub());
  let waited = false;
  let degraded = false;

  try {
    const entry = makeEntry('msg-no-ack-removed-after-push', 'no ack removed after push');
    entry.lastPushConnId = 'conn-no-ack';
    entry.lastPushClientId = 'client-no-ack';
    bridge.outbox.set(entry.messageId, entry);

    bridge.tryPushEntry = async (pushedEntry) => {
      assert.equal(pushedEntry.messageId, entry.messageId);
      bridge.outbox.delete(pushedEntry.messageId);
      return true;
    };
    bridge.waitForMessageAck = async () => {
      waited = true;
      return 'timeout';
    };
    bridge.degradeOutboundCapability = () => {
      degraded = true;
    };
    bridge.sleepMs = async () => {};
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => false;

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'no-ack-removed-after-push',
    });

    assert.equal(waited, false);
    assert.equal(degraded, false);
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has(entry.messageId), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue skips reentrant drain for the same account', async () => {
  const logs = [];
  const warnings = [];
  const bridge = createBncrBridge(createApiStub());
  const pushed = [];
  let nestedReturned = false;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;

  try {
    console.log = (...args) => {
      logs.push(args.map((part) => String(part)).join(' '));
    };
    console.warn = (...args) => {
      warnings.push(args.map((part) => String(part)).join(' '));
    };
    bridge.isDebugEnabled = () => true;
    const entry = makeEntry('msg-reentrant-same-account', 'same account reentry');
    entry.nextAttemptAt = Date.now() - 1_000;
    bridge.outbox.set(entry.messageId, entry);

    bridge.tryPushEntry = async (pushedEntry) => {
      pushed.push(pushedEntry.messageId);
      await bridge.flushPushQueue({
        accountId: 'Primary',
        trigger: 'test',
        reason: 'nested-same-account',
      });
      nestedReturned = true;
      bridge.outbox.delete(pushedEntry.messageId);
      return true;
    };
    bridge.sleepMs = async () => {};
    bridge.isOutboundAckRequired = () => false;

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'outer-same-account',
    });

    assert.equal(nestedReturned, true);
    assert.deepEqual(pushed, ['msg-reentrant-same-account']);
    assert.equal(bridge.outbox.has(entry.messageId), false);
    assert.equal(bridge.pushDrainRunningAccounts.has('Primary'), false);
    assert.equal(
      warnings.some((line) => line.includes('[bncr] outbox drain stuck')),
      false,
    );
    const drainSkip = logs.find(
      (line) =>
        line.includes('[bncr] outbox drain-skip') &&
        line.includes('already-running') &&
        !line.includes('msg-reentrant-same-account'),
    );
    assert.ok(drainSkip, 'reentrant drain skip should be observable in debug logs');
  } finally {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    cleanupBridge(bridge);
  }
});

test('flushPushQueue emits non-debug drain stuck summary after long-running account drain', async () => {
  const logs = [];
  const warnings = [];
  const bridge = createBncrBridge(createApiStub());
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;

  try {
    console.log = (...args) => {
      logs.push(args.map((part) => String(part)).join(' '));
    };
    console.warn = (...args) => {
      warnings.push(args.map((part) => String(part)).join(' '));
    };
    bridge.isDebugEnabled = () => true;
    const entry = makeEntry('msg-drain-stuck', 'drain stuck');
    bridge.outbox.set(entry.messageId, entry);
    bridge.pushDrainRunningAccounts.add('Primary');
    bridge.pushDrainRunningSinceByAccount.set('Primary', Date.now() - 31_000);

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'nested-stuck-check',
    });

    const summary = warnings.find((line) => line.includes('[bncr] outbox drain stuck'));
    assert.ok(summary, 'drain stuck summary should be non-debug visible');
    assert.ok(summary.includes('accountId=Primary'));
    assert.ok(summary.includes('pending=1'));
    assert.ok(summary.includes('runningMs='));
    assert.ok(summary.includes('waiters=0/0'));

    const detail = logs.find((line) => line.includes('[bncr] outbox drain-stuck'));
    assert.ok(detail, 'drain stuck detail should be emitted through debug logs');
    assert.ok(detail.includes('msg-drain-stuck'));
    assert.ok(detail.includes('hasGatewayContext'));
  } finally {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    bridge.pushDrainRunningAccounts.delete('Primary');
    bridge.pushDrainRunningSinceByAccount.delete('Primary');
    bridge.pushDrainStuckWarnedAtByAccount.delete('Primary');
    cleanupBridge(bridge);
  }
});

test('flushPushQueue yields after per-account budget instead of draining unbounded entries', async () => {
  const bridge = createBncrBridge(createApiStub());
  const pushed = [];
  const scheduled = [];

  try {
    for (let i = 1; i <= 7; i++) {
      const entry = makeEntry(`msg-budget-${i}`, `budget ${i}`);
      entry.nextAttemptAt = Date.now() - 1_000;
      bridge.outbox.set(entry.messageId, entry);
    }

    bridge.tryPushEntry = async (entry) => {
      pushed.push(entry.messageId);
      bridge.outbox.delete(entry.messageId);
      return true;
    };
    bridge.sleepMs = async () => {};
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };

    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'budget-yield' });

    assert.deepEqual(pushed, [
      'msg-budget-1',
      'msg-budget-2',
      'msg-budget-3',
      'msg-budget-4',
      'msg-budget-5',
    ]);
    assert.equal(bridge.outbox.size, 2);
    assert.equal(bridge.outbox.has('msg-budget-6'), true);
    assert.equal(bridge.outbox.has('msg-budget-7'), true);
    assert.deepEqual(scheduled, [0]);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue merges multi-account next delays using the smallest delay', async () => {
  const bridge = createBncrBridge(createApiStub());
  const pushed = [];
  const scheduled = [];
  const nowTs = Date.now();

  try {
    const futureEntry = makeEntry('msg-primary-future', 'primary future');
    futureEntry.accountId = 'Primary';
    futureEntry.nextAttemptAt = nowTs + 5_000;
    bridge.outbox.set(futureEntry.messageId, futureEntry);

    for (let i = 1; i <= 7; i++) {
      const entry = makeEntry(`msg-secondary-${i}`, `secondary ${i}`);
      entry.accountId = 'Secondary';
      entry.nextAttemptAt = nowTs - 1_000;
      bridge.outbox.set(entry.messageId, entry);
    }

    bridge.tryPushEntry = async (entry) => {
      pushed.push(entry.messageId);
      bridge.outbox.delete(entry.messageId);
      return true;
    };
    bridge.sleepMs = async () => {};
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };
    bridge.isOutboundAckRequired = () => false;

    await bridge.flushPushQueue({ trigger: 'test', reason: 'multi-account-delay-merge' });

    assert.equal(bridge.outbox.has(futureEntry.messageId), true);
    assert.deepEqual(pushed, [
      'msg-secondary-1',
      'msg-secondary-2',
      'msg-secondary-3',
      'msg-secondary-4',
      'msg-secondary-5',
    ]);
    assert.equal(bridge.outbox.has('msg-secondary-6'), true);
    assert.equal(bridge.outbox.has('msg-secondary-7'), true);
    assert.deepEqual(scheduled, [0]);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue marks no-ack offline pushes as unconfirmed retry without waiting for ack', async () => {
  const bridge = createBncrBridge(createApiStub());
  const scheduled = [];
  let waited = false;
  let degraded = null;
  let saveCount = 0;
  const before = Date.now();

  try {
    const entry = makeEntry('msg-no-ack-offline-unconfirmed', 'no ack offline unconfirmed');
    entry.lastPushConnId = 'conn-no-ack-offline';
    entry.lastPushClientId = 'client-no-ack-offline';
    entry.nextAttemptAt = before - 1_000;
    bridge.outbox.set(entry.messageId, entry);

    bridge.tryPushEntry = async (pushedEntry) => {
      assert.equal(pushedEntry.messageId, entry.messageId);
      return true;
    };
    bridge.waitForMessageAck = async () => {
      waited = true;
      return 'timeout';
    };
    bridge.degradeOutboundCapability = (args) => {
      degraded = args;
    };
    bridge.sleepMs = async () => {};
    bridge.isOnline = () => false;
    bridge.isOutboundAckRequired = () => false;
    bridge.scheduleSave = () => {
      saveCount += 1;
    };
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'no-ack-offline-unconfirmed',
    });

    const updated = bridge.outbox.get(entry.messageId);
    assert.ok(updated, 'offline no-ack push should remain queued for retry');
    assert.equal(waited, false);
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(degraded?.reason, 'push-unconfirmed');
    assert.equal(degraded?.connId, 'conn-no-ack-offline');
    assert.equal(degraded?.clientId, 'client-no-ack-offline');
    assert.equal(updated.retryCount, 1);
    assert.equal(updated.lastError, 'push-delivery-unconfirmed');
    assert.ok(updated.lastAttemptAt >= before);
    assert.ok(updated.nextAttemptAt >= updated.lastAttemptAt);
    assert.equal(saveCount, 1);
    assert.equal(bridge.deadLetter.length, 0);
    assert.equal(scheduled.length, 1);
    assert.ok(scheduled[0] >= 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueueBestEffort logs and reschedules drain exceptions with a retry limit', async () => {
  const bridge = createBncrBridge(createApiStub());
  const errors = [];
  const scheduled = [];
  const originalConsoleError = console.error;

  try {
    console.error = (...args) => {
      errors.push(args.map((part) => String(part)).join(' '));
    };
    bridge.flushPushQueue = async () => {
      throw new Error('synthetic drain explosion');
    };
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };

    for (let i = 0; i < 4; i += 1) {
      bridge.flushPushQueueBestEffort({
        accountId: 'Primary',
        trigger: 'test',
        reason: 'drain-exception',
      });
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(errors.length, 4);
    assert.ok(errors[0].includes('[bncr] outbox drain fail'));
    assert.ok(errors[0].includes('accountId=Primary'));
    assert.ok(errors[0].includes('reason=drain-exception'));
    assert.ok(errors[0].includes('synthetic drain explosion'));
    assert.ok(errors[0].includes('retry=1'));
    assert.ok(errors[1].includes('retry=2'));
    assert.ok(errors[2].includes('retry=3'));
    assert.ok(errors[3].includes('retry=false'));
    assert.deepEqual(scheduled, [1_000, 1_000, 1_000]);

    bridge.flushPushQueue = async () => {};
    bridge.flushPushQueueBestEffort({ accountId: 'Primary', trigger: 'test', reason: 'recovered' });
    await new Promise((resolve) => setImmediate(resolve));

    bridge.flushPushQueue = async () => {
      throw new Error('synthetic drain explosion after recovery');
    };
    bridge.flushPushQueueBestEffort({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'drain-exception-after-recovery',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(errors[4].includes('retry=1'));
    assert.equal(scheduled.length, 4);
  } finally {
    console.error = originalConsoleError;
    cleanupBridge(bridge);
  }
});

test('flushPushQueue logs non-debug push skip summary when text push guard rejects', async () => {
  const logs = [];
  const bridge = createBncrBridge(createApiStub());
  const scheduled = [];
  let saveCount = 0;
  const before = Date.now();
  const originalConsoleLog = console.log;

  try {
    console.log = (...args) => {
      logs.push(args.map((part) => String(part)).join(' '));
    };
    const entry = makeEntry('msg-push-skip-no-active-connection', 'push skip no active connection');
    entry.nextAttemptAt = before - 1_000;
    bridge.outbox.set(entry.messageId, entry);

    bridge.gatewayContext = null;
    bridge.sleepMs = async () => {};
    bridge.scheduleSave = () => {
      saveCount += 1;
    };
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'push-skip-summary',
    });

    const skipSummary = logs.find(
      (line) =>
        line.includes('[bncr] outbox push skip') &&
        line.includes(`mid=${entry.messageId}`) &&
        line.includes('reason=no-gateway-context'),
    );
    assert.ok(skipSummary, 'push guard skip should emit non-debug summary log');

    const updated = bridge.outbox.get(entry.messageId);
    assert.ok(updated, 'entry should remain queued for retry after push skip');
    assert.equal(updated.retryCount, 1);
    assert.equal(updated.lastError, 'gateway context unavailable');
    assert.ok(saveCount >= 2, 'guard reason and retry state should both be persisted');
    assert.equal(scheduled.length, 1);
  } finally {
    console.log = originalConsoleLog;
    cleanupBridge(bridge);
  }
});

test('flushPushQueue converts tryPushEntry exceptions into retryable push failure', async () => {
  const bridge = createBncrBridge(createApiStub());
  const logs = [];
  const scheduled = [];
  let saveCount = 0;
  const before = Date.now();
  const originalConsoleLog = console.log;

  try {
    console.log = (...args) => {
      logs.push(args.map((part) => String(part)).join(' '));
    };
    const entry = makeEntry('msg-pre-push-exception', 'pre push exception');
    entry.nextAttemptAt = before - 1_000;
    bridge.outbox.set(entry.messageId, entry);

    bridge.tryPushEntry = async () => {
      throw new Error('synthetic pre-push explosion');
    };
    bridge.sleepMs = async () => {};
    bridge.scheduleSave = () => {
      saveCount += 1;
    };
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'pre-push-exception',
    });

    const failureSummary = logs.find(
      (line) =>
        line.includes('[bncr] outbox push fail') &&
        line.includes(`mid=${entry.messageId}`) &&
        line.includes('synthetic pre-push explosion'),
    );
    assert.ok(failureSummary, 'pre-push exception should emit non-debug push failure summary');

    const updated = bridge.outbox.get(entry.messageId);
    assert.ok(updated, 'entry should remain queued for retry after pre-push exception');
    assert.equal(updated.retryCount, 1);
    assert.equal(updated.lastError, 'synthetic pre-push explosion');
    assert.ok(updated.nextAttemptAt >= updated.lastAttemptAt);
    assert.equal(saveCount, 1);
    assert.equal(scheduled.length, 1);
  } finally {
    console.log = originalConsoleLog;
    cleanupBridge(bridge);
  }
});

test('flushPushQueue schedules retry after push failure without dead-lettering', async () => {
  const bridge = createBncrBridge(createApiStub());
  const scheduled = [];
  let saveCount = 0;
  const before = Date.now();

  try {
    const entry = makeEntry('msg-push-failure-retry', 'push failure retry');
    entry.nextAttemptAt = before - 1_000;
    bridge.outbox.set(entry.messageId, entry);

    bridge.tryPushEntry = async () => false;
    bridge.sleepMs = async () => {};
    bridge.scheduleSave = () => {
      saveCount += 1;
    };
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'push-failure-retry',
    });

    const updated = bridge.outbox.get(entry.messageId);
    assert.ok(updated, 'entry should remain queued for retry');
    assert.equal(updated.retryCount, 1);
    assert.equal(updated.lastError, 'push-retry');
    assert.ok(updated.lastAttemptAt >= before);
    assert.ok(updated.nextAttemptAt >= updated.lastAttemptAt);
    assert.equal(saveCount, 1);
    assert.equal(bridge.deadLetter.length, 0);
    assert.equal(scheduled.length, 1);
    assert.ok(scheduled[0] >= 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue moves push failure retry-limit entries to deadLetter without retry scheduling', async () => {
  const bridge = createBncrBridge(createApiStub());
  const scheduled = [];
  let saveCount = 0;
  const before = Date.now();

  try {
    const entry = makeEntry('msg-push-failure-retry-limit', 'push failure retry limit');
    entry.retryCount = 10;
    entry.nextAttemptAt = before - 1_000;
    entry.lastError = 'push-terminal-seed';
    bridge.outbox.set(entry.messageId, entry);
    const waiter = bridge.waitForMessageAck(entry.messageId, 1_000);

    bridge.tryPushEntry = async () => false;
    bridge.sleepMs = async () => {};
    bridge.scheduleSave = () => {
      saveCount += 1;
    };
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'push-failure-retry-limit',
    });

    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has(entry.messageId), false);
    assert.equal(bridge.deadLetter.length, 1);
    assert.equal(bridge.deadLetter[0].messageId, entry.messageId);
    assert.equal(bridge.deadLetter[0].lastError, 'push-terminal-seed');
    assert.equal(saveCount, 1);
    assert.deepEqual(scheduled, []);
    assert.equal(bridge.resolveMessageAck(entry.messageId, 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('sleepMs clamps invalid and oversized internal delays', async () => {
  const bridge = createBncrBridge(createApiStub());
  const originalSetTimeout = globalThis.setTimeout;
  const observedDelays = [];

  try {
    globalThis.setTimeout = (fn, delay, ...args) => {
      observedDelays.push(delay);
      fn(...args);
      return { [Symbol.toPrimitive]: () => 0 };
    };

    await bridge.sleepMs(Number.NaN);
    await bridge.sleepMs(Number.POSITIVE_INFINITY);
    await bridge.sleepMs(-1);
    await bridge.sleepMs(150_000);

    assert.deepEqual(observedDelays, [0, 0, 0, 120_000]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    cleanupBridge(bridge);
  }
});

test('waitForMessageAck removes waiter after timeout without leaking state', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    assert.equal(bridge.messageAckWaiters.size, 0);

    const waiter = bridge.waitForMessageAck('msg-timeout-cleanup', 40);
    assert.equal(bridge.messageAckWaiters.size, 1);

    const result = await waiter;
    assert.equal(result, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.resolveMessageAck('msg-timeout-cleanup', 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('waitForMessageAck treats invalid timeout inputs as immediate timeout without waiter leak', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    assert.equal(await bridge.waitForMessageAck('msg-invalid-nan-timeout', Number.NaN), 'timeout');
    assert.equal(
      await bridge.waitForMessageAck('msg-invalid-infinity-timeout', Number.POSITIVE_INFINITY),
      'timeout',
    );
    assert.equal(await bridge.waitForMessageAck('msg-invalid-negative-timeout', -1), 'timeout');
    assert.equal(await bridge.waitForMessageAck('', 1_000), 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('waitForMessageAck reuses existing waiter for the same message id', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const waiter1 = bridge.waitForMessageAck('msg-shared-waiter', 200);
    const waiter2 = bridge.waitForMessageAck('msg-shared-waiter', 200);

    assert.equal(bridge.messageAckWaiters.size, 1);
    assert.equal(bridge.resolveMessageAck('msg-shared-waiter', 'acked'), true);
    assert.equal(await waiter1, 'acked');
    assert.equal(await waiter2, 'acked');
    assert.equal(bridge.messageAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('late ack after timeout does not resolve twice or recreate waiter state', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const waiter = bridge.waitForMessageAck('msg-late-ack', 40);
    const result = await waiter;

    assert.equal(result, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.resolveMessageAck('msg-late-ack', 'acked'), false);
    assert.equal(bridge.messageAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('shutdown settles message ack waiters and clears waiter state', async () => {
  const bridge = createBncrBridge(createApiStub());
  const logs = [];
  bridge.logInfo = (scope, message, options) => {
    logs.push({ scope, message, options });
  };

  try {
    const waiter1 = bridge.waitForMessageAck('msg-shutdown-1', 200);
    const waiter2 = bridge.waitForMessageAck('msg-shutdown-2', 200);
    bridge.earlyFileAcks.set('transfer-shutdown|complete|-', {
      payload: { ok: true },
      ok: true,
      at: Date.now(),
    });

    assert.equal(bridge.messageAckWaiters.size, 2);
    bridge.shutdown();

    assert.equal(await waiter1, 'timeout');
    assert.equal(await waiter2, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.resolveMessageAck('msg-shutdown-1', 'acked'), false);
    assert.equal(bridge.resolveMessageAck('msg-shutdown-2', 'acked'), false);

    const cleanupLog = logs.find(
      (item) => item.scope === 'lifecycle' && item.message.startsWith('cleanup '),
    );
    assert.ok(cleanupLog);
    const summary = JSON.parse(cleanupLog.message.slice('cleanup '.length));
    assert.equal(summary.reason, 'shutdown');
    assert.equal(summary.messageAckWaiters, 2);
    assert.equal(summary.earlyFileAcks, 1);
    assert.equal(summary.outbox, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('stopService settles message ack waiters and clears timers like shutdown', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const waiter = bridge.waitForMessageAck('msg-stop-service', 1_000);
    bridge.saveTimer = setTimeout(() => {}, 1_000);
    bridge.pushTimer = setTimeout(() => {}, 1_000);
    bridge.earlyFileAcks.set('transfer-stop|complete|-', {
      payload: { ok: true },
      ok: true,
      at: Date.now(),
    });

    assert.equal(bridge.messageAckWaiters.size, 1);
    assert.ok(bridge.saveTimer);
    assert.ok(bridge.pushTimer);
    assert.equal(bridge.earlyFileAcks.size, 1);

    await bridge.stopService();

    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.saveTimer, null);
    assert.equal(bridge.pushTimer, null);
    assert.equal(bridge.earlyFileAcks.size, 0);
    assert.equal(bridge.resolveMessageAck('msg-stop-service', 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue emits ack wait-start before blocking on message ack waiter', async () => {
  const logs = [];
  const bridge = createBncrBridge(createApiStub());
  const originalConsoleLog = console.log;

  try {
    console.log = (...args) => {
      logs.push(args.map((part) => String(part)).join(' '));
    };
    bridge.isDebugEnabled = () => true;
    const entry = makeEntry('msg-ack-wait-start', 'ack wait start');
    entry.nextAttemptAt = Date.now() - 1_000;
    bridge.outbox.set(entry.messageId, entry);

    bridge.tryPushEntry = async (pushedEntry) => {
      pushedEntry.lastPushConnId = 'conn-wait-start';
      pushedEntry.lastPushClientId = 'client-wait-start';
      return true;
    };
    bridge.sleepMs = async () => {};
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => true;
    bridge.resolveMessageAckTimeoutMs = () => 5;

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'ack-wait-start',
    });

    const waitStart = logs.find(
      (line) =>
        line.includes('[bncr] outbox ack wait-start') &&
        line.includes('msg-ack-wait-start') &&
        line.includes('conn-wait-start'),
    );
    assert.ok(waitStart, 'push success should emit debug ack wait-start before waiter resolves');
  } finally {
    console.log = originalConsoleLog;
    cleanupBridge(bridge);
  }
});

test('resolveMessageAck clears only the targeted waiter and leaves others pending', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const waiter1 = bridge.waitForMessageAck('msg-target', 200);
    const waiter2 = bridge.waitForMessageAck('msg-other', 40);

    assert.equal(bridge.messageAckWaiters.size, 2);
    assert.equal(bridge.resolveMessageAck('msg-target', 'acked'), true);
    assert.equal(bridge.messageAckWaiters.size, 1);

    assert.equal(await waiter1, 'acked');
    assert.equal(await waiter2, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('enqueueOutbound does not wake another message ack waiter on the same account', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const waiter = bridge.waitForMessageAck('msg-1', 40);
    bridge.enqueueOutbound(makeEntry('msg-2', 'second message'));

    const result = await waiter;
    assert.equal(result, 'timeout');
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck resolves only the matching message ack waiter', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const entry1 = makeEntry('msg-1', 'first');
    const entry2 = makeEntry('msg-2', 'second');
    bridge.outbox.set(entry1.messageId, entry1);
    bridge.outbox.set(entry2.messageId, entry2);

    const waiter1 = bridge.waitForMessageAck('msg-1', 200);
    const waiter2 = bridge.waitForMessageAck('msg-2', 40);

    let respondPayload = null;
    await bridge.handleAck({
      params: { accountId: 'Primary', messageId: 'msg-1', ok: true },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(respondPayload, { ok: true, payload: { ok: true } });
    assert.equal(await waiter1, 'acked');
    assert.equal(await waiter2, 'timeout');
    assert.equal(bridge.outbox.has('msg-1'), false);
    assert.equal(bridge.outbox.has('msg-2'), true);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck success flushes queued outbound for the same account', async () => {
  const bridge = createBncrBridge(createApiStub());
  const spy = spyFlushPushQueue(bridge);

  try {
    const entry = makeEntry('msg-ack-flush', 'ack flush');
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: { accountId: 'Primary', messageId: 'msg-ack-flush', ok: true },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(spy.calls, [
      { accountId: 'Primary', trigger: 'ack-ok', reason: 'message-acked' },
    ]);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});

test('handleAck retryable ack keeps entry queued and reports willRetry', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const entry = makeEntry('msg-ack-retryable', 'retry me');
    entry.nextAttemptAt = Date.now() - 1_000;
    bridge.outbox.set(entry.messageId, entry);

    let respondPayload = null;
    const before = Date.now();

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retryable',
        ok: false,
        error: 'retryable-ack-from-test',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    const updated = bridge.outbox.get('msg-ack-retryable');
    assert.ok(updated);
    assert.equal(updated.lastError, 'retryable-ack-from-test');
    assert.ok(updated.nextAttemptAt >= before + 900);
    assert.deepEqual(respondPayload, { ok: true, payload: { ok: true, willRetry: true } });
    assert.equal(
      bridge.deadLetter.some((item) => item.messageId === 'msg-ack-retryable'),
      false,
    );
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck retryable ack does not resolve the pending message ack waiter', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const entry = makeEntry('msg-ack-retryable-waiter', 'retry keeps waiter pending');
    bridge.outbox.set(entry.messageId, entry);
    const waiter = bridge.waitForMessageAck(entry.messageId, 40);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: entry.messageId,
        ok: false,
        error: 'retryable-ack-waiter-test',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(bridge.messageAckWaiters.size, 1);
    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has(entry.messageId), true);
    assert.equal(
      bridge.deadLetter.some((item) => item.messageId === entry.messageId),
      false,
    );
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck fatal ack moves entry to deadLetter and reports movedToDeadLetter', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const entry = makeEntry('msg-ack-fatal', 'fatal me');
    bridge.outbox.set(entry.messageId, entry);

    let respondPayload = null;

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-fatal',
        ok: false,
        fatal: true,
        error: 'fatal-ack-from-test',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(bridge.outbox.has('msg-ack-fatal'), false);
    assert.equal(
      bridge.deadLetter.some((item) => item.messageId === 'msg-ack-fatal'),
      true,
    );
    assert.deepEqual(respondPayload, { ok: true, payload: { ok: true, movedToDeadLetter: true } });
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck fatal ack resolves pending message ack waiter as timeout', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const entry = makeEntry('msg-ack-fatal-waiter', 'fatal resolves waiter timeout');
    bridge.outbox.set(entry.messageId, entry);
    const waiter = bridge.waitForMessageAck(entry.messageId, 1_000);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: entry.messageId,
        ok: false,
        fatal: true,
        error: 'fatal-ack-waiter-test',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has(entry.messageId), false);
    assert.equal(
      bridge.deadLetter.some((item) => item.messageId === entry.messageId),
      true,
    );
    assert.equal(bridge.resolveMessageAck(entry.messageId, 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('moveToDeadLetter resolves pending message ack waiter as timeout', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const entry = makeEntry('msg-deadletter-waiter', 'deadletter resolves waiter timeout');
    bridge.outbox.set(entry.messageId, entry);
    const waiter = bridge.waitForMessageAck(entry.messageId, 1_000);

    bridge.moveToDeadLetter(entry, 'direct-deadletter-waiter-test');

    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has(entry.messageId), false);
    assert.equal(
      bridge.deadLetter.some((item) => item.messageId === entry.messageId),
      true,
    );
    assert.equal(bridge.resolveMessageAck(entry.messageId, 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('collectDue retry-limit dead-letter resolves pending message ack waiter as timeout', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const entry = makeEntry('msg-collectdue-waiter', 'collectDue resolves waiter timeout');
    entry.retryCount = 99;
    entry.nextAttemptAt = Date.now() - 1_000;
    entry.lastError = 'retry-limit-test';
    bridge.outbox.set(entry.messageId, entry);
    const waiter = bridge.waitForMessageAck(entry.messageId, 1_000);

    const payloads = bridge.collectDue('Primary', 10);

    assert.deepEqual(payloads, []);
    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has(entry.messageId), false);
    assert.equal(
      bridge.deadLetter.some((item) => item.messageId === entry.messageId),
      true,
    );
    assert.equal(bridge.resolveMessageAck(entry.messageId, 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('deadLetter memory keeps only the newest bounded entries', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.stopped = true;
    for (let i = 0; i < 1005; i += 1) {
      bridge.moveToDeadLetter(makeEntry(`dead-${i}`, `dead ${i}`), 'test-dead-letter-cap');
    }

    assert.equal(bridge.deadLetter.length, 1000);
    assert.equal(
      bridge.deadLetter.some((entry) => entry.messageId === 'dead-0'),
      false,
    );
    assert.equal(bridge.deadLetter[0].messageId, 'dead-5');
    assert.equal(bridge.deadLetter.at(-1).messageId, 'dead-1004');
  } finally {
    cleanupBridge(bridge);
  }
});

test('late ok ack after fatal ack does not recreate outbox state or duplicate deadLetter entry', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const entry = makeEntry('msg-ack-fatal-late', 'fatal then late ok');
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-fatal-late',
        ok: false,
        fatal: true,
        error: 'fatal-before-late-ok',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    const deadLetterCountBefore = bridge.deadLetter.filter(
      (item) => item.messageId === 'msg-ack-fatal-late',
    ).length;

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-fatal-late',
        ok: true,
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    const deadLetterCountAfter = bridge.deadLetter.filter(
      (item) => item.messageId === 'msg-ack-fatal-late',
    ).length;
    assert.equal(bridge.outbox.has('msg-ack-fatal-late'), false);
    assert.equal(deadLetterCountBefore, 1);
    assert.equal(deadLetterCountAfter, 1);
  } finally {
    cleanupBridge(bridge);
  }
});

test('late ok ack after shutdown does not recreate waiter or outbox state', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const waiter = bridge.waitForMessageAck('msg-ack-shutdown-late', 1_000);
    const entry = makeEntry('msg-ack-shutdown-late', 'shutdown then late ok');
    bridge.outbox.set(entry.messageId, entry);

    bridge.shutdown();

    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-shutdown-late',
        ok: true,
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has('msg-ack-shutdown-late'), true);
    assert.equal(bridge.resolveMessageAck('msg-ack-shutdown-late', 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('stale non-owner ack keeps waiter pending and leaves outbox entry intact', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const entry = makeEntry('msg-stale-non-owner', 'stale should not win');
    entry.lastPushConnId = 'conn-owner';
    entry.lastPushClientId = 'client-owner';
    bridge.outbox.set(entry.messageId, entry);

    const waiter = bridge.waitForMessageAck('msg-stale-non-owner', 40);
    const originalObserveLease = bridge.observeLease.bind(bridge);
    bridge.observeLease = (...args) => ({ ...originalObserveLease(...args), stale: true });

    let respondPayload = null;
    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-stale-non-owner',
        ok: true,
        clientId: 'client-intruder',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-intruder' },
      context: null,
    });

    const waiterResult = await waiter;
    assert.deepEqual(respondPayload, {
      ok: true,
      payload: { ok: true, stale: true, ignored: true },
    });
    assert.equal(waiterResult, 'timeout');
    assert.equal(bridge.outbox.has('msg-stale-non-owner'), true);
    assert.equal(bridge.messageAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('late ok ack after retryable ack clears the queue and records slow-ack observability', async () => {
  const logs = [];
  const bridge = createBncrBridge(createApiStub());
  const originalLogInfo = bridge.logInfo.bind(bridge);
  bridge.logInfo = (scope, message, options) => {
    logs.push({ scope, message, options });
    return originalLogInfo(scope, message, options);
  };

  try {
    const entry = makeEntry('msg-ack-retry-late', 'retry then late ok');
    entry.createdAt = Math.max(0, entry.createdAt - 8000);
    entry.lastPushAt = entry.createdAt + 2000;
    entry.lastPushConnId = 'conn-1';
    entry.lastPushClientId = 'client-1';
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retry-late',
        ok: false,
        error: 'retry-first',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    let respondPayload = null;
    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retry-late',
        ok: true,
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(bridge.outbox.has('msg-ack-retry-late'), false);
    assert.deepEqual(respondPayload, { ok: true, payload: { ok: true } });
    assert.equal(bridge.getCounter(bridge.lateAckOkCountByAccount, 'Primary'), 1);
    assert.ok(bridge.lastLateAckOkByAccount.get('Primary'));
    assert.ok(bridge.lastAckOkByAccount.get('Primary'));
    assert.ok((bridge.lastAckQueueLatencyMsByAccount.get('Primary') || 0) >= 8000);
    assert.ok((bridge.lastAckPushLatencyMsByAccount.get('Primary') || 0) >= 6000);
    assert.equal(
      bridge.lastLateAckQueueLatencyMsByAccount.get('Primary'),
      bridge.lastAckQueueLatencyMsByAccount.get('Primary'),
    );
    assert.equal(
      bridge.lastLateAckPushLatencyMsByAccount.get('Primary'),
      bridge.lastAckPushLatencyMsByAccount.get('Primary'),
    );
    const lateAckLog = logs.find((item) => item.scope === 'outbox ack ok late');
    assert.ok(lateAckLog);
    assert.match(lateAckLog.message, /queueMs=\d+/);
    assert.match(lateAckLog.message, /pushMs=\d+/);
  } finally {
    bridge.logInfo = originalLogInfo;
    cleanupBridge(bridge);
  }
});

test('runtime snapshot exposes ack latency observability for status surfaces', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.lastAckQueueLatencyMsByAccount.set('Primary', 1234);
    bridge.lastAckPushLatencyMsByAccount.set('Primary', 567);
    bridge.lastLateAckQueueLatencyMsByAccount.set('Primary', 4321);
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 765);

    const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

    assert.equal(snapshot.ackObservability.lastAckQueueLatencyMs, 1234);
    assert.equal(snapshot.ackObservability.lastAckPushLatencyMs, 567);
    assert.equal(snapshot.ackObservability.lastLateAckQueueLatencyMs, 4321);
    assert.equal(snapshot.ackObservability.lastLateAckPushLatencyMs, 765);
    assert.equal(snapshot.ackObservability.currentAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutReason, 'no-timeout-evidence');
    assert.deepEqual(snapshot.ackStrategy, {
      mode: 'adaptive',
      currentMs: 30000,
      defaultMs: 30000,
      maxMs: 90000,
      reason: 'no-timeout-evidence',
      active: false,
      lastLateAckAgeMs: null,
      lateAckObservationTtlMs: 3600000,
      recovered: false,
    });
    assert.deepEqual(snapshot.meta.ackObservability, snapshot.ackObservability);
    assert.deepEqual(snapshot.diagnostics.ackObservability, snapshot.ackObservability);
    assert.deepEqual(snapshot.meta.diagnostics.ackObservability, snapshot.ackObservability);
    assert.deepEqual(snapshot.meta.ackStrategy, snapshot.ackStrategy);
    assert.deepEqual(snapshot.diagnostics.ackStrategy, snapshot.ackStrategy);
    assert.deepEqual(snapshot.meta.diagnostics.ackStrategy, snapshot.ackStrategy);
  } finally {
    cleanupBridge(bridge);
  }
});

test('runtime ack strategy falls back when observability timeouts are invalid', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.buildAckObservability = () => ({
      adaptiveAckTimeoutEnabled: true,
      currentAckTimeoutMs: 'not-a-number',
      defaultAckTimeoutMs: 'not-a-number',
      recommendedAckTimeoutReason: 'invalid-test',
      lastLateAckAgeMs: null,
      lateAckObservationTtlMs: 3_600_000,
      adaptiveAckRecovered: false,
    });

    const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

    assert.equal(snapshot.ackStrategy.currentMs, 30000);
    assert.equal(snapshot.ackStrategy.defaultMs, 30000);
    assert.equal(snapshot.ackStrategy.active, false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('adaptive ack timeout matrix locks reasons and effective timeout bounds', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const nowMs = Date.now();
    const cases = [
      {
        name: 'no timeout evidence',
        setup() {},
        timeoutMs: 30000,
        reason: 'no-timeout-evidence',
        active: false,
      },
      {
        name: 'no late ack evidence',
        setup() {
          bridge.ackTimeoutCountByAccount.set('Primary', 1);
        },
        timeoutMs: 30000,
        reason: 'no-late-ack-evidence',
        active: false,
      },
      {
        name: 'missing latency',
        setup() {
          bridge.ackTimeoutCountByAccount.set('Primary', 1);
          bridge.lateAckOkCountByAccount.set('Primary', 1);
          bridge.lastLateAckOkByAccount.set('Primary', nowMs);
        },
        timeoutMs: 30000,
        reason: 'missing-latency',
        active: false,
      },
      {
        name: 'late ack observed',
        setup() {
          bridge.ackTimeoutCountByAccount.set('Primary', 1);
          bridge.lateAckOkCountByAccount.set('Primary', 1);
          bridge.lastLateAckOkByAccount.set('Primary', nowMs);
          bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);
        },
        timeoutMs: 60000,
        reason: 'late-ack-observed',
        active: true,
      },
      {
        name: 'capped max',
        setup() {
          bridge.ackTimeoutCountByAccount.set('Primary', 1);
          bridge.lateAckOkCountByAccount.set('Primary', 1);
          bridge.lastLateAckOkByAccount.set('Primary', nowMs);
          bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 120000);
        },
        timeoutMs: 90000,
        reason: 'capped-max',
        active: true,
      },
      {
        name: 'late ack expired',
        setup() {
          bridge.ackTimeoutCountByAccount.set('Primary', 1);
          bridge.lateAckOkCountByAccount.set('Primary', 1);
          bridge.lastLateAckOkByAccount.set('Primary', nowMs - 3_700_000);
          bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);
        },
        timeoutMs: 30000,
        reason: 'late-ack-expired',
        active: false,
        expired: true,
      },
      {
        name: 'recovered',
        setup() {
          bridge.ackTimeoutCountByAccount.set('Primary', 1);
          bridge.lateAckOkCountByAccount.set('Primary', 1);
          bridge.lastLateAckOkByAccount.set('Primary', nowMs);
          bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);
          bridge.adaptiveAckRecoveryOkCountByAccount.set('Primary', 3);
        },
        timeoutMs: 30000,
        reason: 'recovered',
        active: false,
        recovered: true,
      },
    ];

    for (const item of cases) {
      bridge.ackTimeoutCountByAccount.clear();
      bridge.lateAckOkCountByAccount.clear();
      bridge.lastLateAckOkByAccount.clear();
      bridge.lastLateAckPushLatencyMsByAccount.clear();
      bridge.adaptiveAckRecoveryOkCountByAccount.clear();
      bridge.adaptiveAckTimeoutLogStateByAccount.clear();

      item.setup();
      const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

      assert.equal(snapshot.ackObservability.currentAckTimeoutMs, item.timeoutMs, item.name);
      assert.equal(snapshot.ackObservability.recommendedAckTimeoutMs, item.timeoutMs, item.name);
      assert.equal(snapshot.ackObservability.recommendedAckTimeoutReason, item.reason, item.name);
      assert.equal(snapshot.ackObservability.defaultAckTimeoutMs, 30000, item.name);
      assert.equal(snapshot.ackObservability.adaptiveAckTimeoutEnabled, true, item.name);
      assert.equal(
        snapshot.ackObservability.lateAckObservationExpired,
        item.expired === true,
        item.name,
      );
      assert.equal(
        snapshot.ackObservability.adaptiveAckRecovered,
        item.recovered === true,
        item.name,
      );
      assert.equal(snapshot.ackStrategy.currentMs, item.timeoutMs, item.name);
      assert.equal(snapshot.ackStrategy.defaultMs, 30000, item.name);
      assert.equal(snapshot.ackStrategy.maxMs, 90000, item.name);
      assert.equal(snapshot.ackStrategy.reason, item.reason, item.name);
      assert.equal(snapshot.ackStrategy.active, item.active, item.name);
      assert.equal(snapshot.ackStrategy.recovered, item.recovered === true, item.name);
      assert.equal(bridge.resolveMessageAckTimeoutMs('Primary'), item.timeoutMs, item.name);
      assert.equal(
        bridge.buildRuntimeFlags('Primary').messageAckTimeoutMs,
        item.timeoutMs,
        item.name,
      );
    }
  } finally {
    cleanupBridge(bridge);
  }
});

test('ack observability recommends a conservative timeout when late ack follows timeout', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.ackTimeoutCountByAccount.set('Primary', 2);
    bridge.lateAckOkCountByAccount.set('Primary', 1);
    bridge.lastLateAckOkByAccount.set('Primary', Date.now());
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);

    const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

    assert.equal(snapshot.ackObservability.adaptiveAckTimeoutEnabled, true);
    assert.equal(snapshot.ackObservability.defaultAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.currentAckTimeoutMs, 60000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutMs, 60000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutReason, 'late-ack-observed');
    assert.equal(snapshot.ackObservability.lateAckObservationTtlMs, 3600000);
    assert.equal(snapshot.ackObservability.lateAckObservationExpired, false);
    assert.equal(snapshot.ackStrategy.mode, 'adaptive');
    assert.equal(snapshot.ackStrategy.currentMs, 60000);
    assert.equal(snapshot.ackStrategy.defaultMs, 30000);
    assert.equal(snapshot.ackStrategy.maxMs, 90000);
    assert.equal(snapshot.ackStrategy.reason, 'late-ack-observed');
    assert.equal(snapshot.ackStrategy.active, true);
    assert.equal(snapshot.ackStrategy.lateAckObservationTtlMs, 3600000);
    assert.equal(snapshot.ackStrategy.recovered, false);
    assert.equal(bridge.resolveMessageAckTimeoutMs('Primary'), 60000);
    assert.equal(bridge.buildRuntimeFlags('Primary').messageAckTimeoutMs, 60000);
    assert.equal(bridge.buildRuntimeFlags('Primary').adaptiveAckTimeoutEnabled, true);
  } finally {
    cleanupBridge(bridge);
  }
});

test('ack observability recovers to default after consecutive normal ack successes', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.ackTimeoutCountByAccount.set('Primary', 2);
    bridge.lateAckOkCountByAccount.set('Primary', 1);
    bridge.lastLateAckOkByAccount.set('Primary', Date.now());
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);
    bridge.adaptiveAckRecoveryOkCountByAccount.set('Primary', 3);

    const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

    assert.equal(snapshot.ackObservability.currentAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.adaptiveAckRecoveryOkCount, 3);
    assert.equal(snapshot.ackObservability.adaptiveAckRecoveryOkThreshold, 3);
    assert.equal(snapshot.ackObservability.adaptiveAckRecovered, true);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutReason, 'recovered');
    assert.equal(bridge.resolveMessageAckTimeoutMs('Primary'), 30000);
  } finally {
    cleanupBridge(bridge);
  }
});

test('ack observability ignores expired late ack telemetry for adaptive timeout', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.ackTimeoutCountByAccount.set('Primary', 2);
    bridge.lateAckOkCountByAccount.set('Primary', 1);
    bridge.lastLateAckOkByAccount.set('Primary', Date.now() - 3_700_000);
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);

    const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

    assert.equal(snapshot.ackObservability.currentAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutMs, 30000);
    assert.equal(snapshot.ackObservability.lateAckObservationTtlMs, 3600000);
    assert.equal(snapshot.ackObservability.lateAckObservationExpired, true);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutReason, 'late-ack-expired');
    assert.equal(bridge.resolveMessageAckTimeoutMs('Primary'), 30000);
  } finally {
    cleanupBridge(bridge);
  }
});

test('adaptive ack timeout logs strategy changes with throttle', async () => {
  const logs = [];
  const bridge = createBncrBridge(createApiStub());
  const originalLogInfo = bridge.logInfo.bind(bridge);
  bridge.logInfo = (scope, message, options) => {
    logs.push({ scope, message, options });
    return originalLogInfo(scope, message, options);
  };

  try {
    bridge.ackTimeoutCountByAccount.set('Primary', 2);
    bridge.lateAckOkCountByAccount.set('Primary', 1);
    bridge.lastLateAckOkByAccount.set('Primary', Date.now());
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);

    assert.equal(bridge.resolveMessageAckTimeoutMs('Primary'), 60000);
    assert.equal(bridge.resolveMessageAckTimeoutMs('Primary'), 60000);

    const adaptiveLogs = logs.filter((item) => item.scope === 'outbox ack timeout-adaptive');
    assert.equal(adaptiveLogs.length, 1);
    assert.match(
      adaptiveLogs[0].message,
      /^Primary\|current=60000\|default=30000\|reason=late-ack-observed\|latePushMs=48000$/,
    );
  } finally {
    bridge.logInfo = originalLogInfo;
    cleanupBridge(bridge);
  }
});

test('ack observability reports capped max reason for oversized late ack latency', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.ackTimeoutCountByAccount.set('Primary', 2);
    bridge.lateAckOkCountByAccount.set('Primary', 1);
    bridge.lastLateAckOkByAccount.set('Primary', Date.now());
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 120000);

    const snapshot = bridge.getAccountRuntimeSnapshot('Primary');

    assert.equal(snapshot.ackObservability.currentAckTimeoutMs, 90000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutMs, 90000);
    assert.equal(snapshot.ackObservability.recommendedAckTimeoutReason, 'capped-max');
  } finally {
    cleanupBridge(bridge);
  }
});

test('normal ack successes increment adaptive recovery counter', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    for (let i = 1; i <= 3; i += 1) {
      const entry = makeEntry(`msg-ack-recover-${i}`, 'recover');
      entry.createdAt = Date.now();
      entry.lastPushAt = Date.now() - 100;
      entry.lastPushConnId = 'conn-1';
      entry.lastPushClientId = 'client-1';
      bridge.outbox.set(entry.messageId, entry);
      await bridge.handleAck({
        params: { accountId: 'Primary', messageId: entry.messageId, ok: true },
        respond() {},
        client: { connId: 'conn-1' },
        context: null,
      });
    }

    assert.equal(bridge.getCounter(bridge.adaptiveAckRecoveryOkCountByAccount, 'Primary'), 3);
  } finally {
    cleanupBridge(bridge);
  }
});

test('ok ack is accepted again after retryable entry is pushed again', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const entry = makeEntry('msg-ack-retry-repush', 'retry then repush then ok');
    entry.lastPushConnId = 'conn-1';
    entry.lastPushClientId = 'client-1';
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retry-repush',
        ok: false,
        error: 'retry-first',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    const retried = bridge.outbox.get('msg-ack-retry-repush');
    assert.ok(retried);
    assert.equal(retried.awaitingRetryPush, true);

    bridge.recordOutboxPushSuccess({
      entry: retried,
      connIds: ['conn-2'],
      ownerConnId: 'conn-2',
      ownerClientId: 'client-2',
      clearLastError: false,
    });

    let respondPayload = null;
    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retry-repush',
        ok: true,
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-2' },
      context: null,
    });

    assert.equal(bridge.outbox.has('msg-ack-retry-repush'), false);
    assert.deepEqual(respondPayload, { ok: true, payload: { ok: true } });
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleActivity flushes queued outbound for the same account', async () => {
  const bridge = createBncrBridge(createApiStub());
  const spy = spyFlushPushQueue(bridge);

  try {
    await bridge.handleActivity({
      params: { accountId: 'Primary', clientId: 'client-1' },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(spy.calls, [
      { accountId: 'Primary', trigger: 'activity', reason: 'activity-heartbeat' },
    ]);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});

test('handleInbound flushes queued outbound for the same account before async dispatch', async () => {
  const bridge = createBncrBridge(createApiStub());
  const spy = spyFlushPushQueue(bridge);

  try {
    await bridge.handleInbound({
      params: {
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        type: 'text',
        msg: 'hello inbound',
        msgId: 'inbound-1',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(spy.calls, [
      { accountId: 'Primary', trigger: 'inbound', reason: 'inbound-accepted' },
    ]);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});

test('reputation sorting prefers lower failure score and fresher ack', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      pushFailureScore: 3,
      lastAckOkAt: nowTs - 30_000,
      lastPushTimeoutAt: nowTs - 5_000,
    });
    bridge.connections.set('Primary:client-b', {
      accountId: 'Primary',
      connId: 'conn-b',
      clientId: 'client-b',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      pushFailureScore: 0,
      lastAckOkAt: nowTs - 1_000,
      lastPushTimeoutAt: 0,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');

    const owner = bridge.resolveOutboxPushOwner('Primary');
    const connIds = Array.from(bridge.resolvePushConnIds('Primary'));

    assert.equal(owner?.connId, 'conn-a');
    assert.ok(connIds.includes('conn-a'));
  } finally {
    cleanupBridge(bridge);
  }
});

test('route candidate scoring treats invalid reputation numbers as neutral', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-bad', {
      accountId: 'Primary',
      connId: 'conn-bad',
      clientId: 'client-bad',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: 'not-a-number',
      preferredForOutboundUntil: 'not-a-number',
      pushFailureScore: 'not-a-number',
      lastAckOkAt: 'not-a-number',
      lastPushTimeoutAt: 'not-a-number',
    });
    bridge.connections.set('Primary:client-good', {
      accountId: 'Primary',
      connId: 'conn-good',
      clientId: 'client-good',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      pushFailureScore: 0,
      lastAckOkAt: nowTs - 1_000,
      lastPushTimeoutAt: 0,
    });

    const connIds = Array.from(bridge.resolvePushConnIds('Primary'));

    assert.equal(connIds[0], 'conn-good');
    assert.ok(connIds.includes('conn-bad'));
  } finally {
    cleanupBridge(bridge);
  }
});

test('diagnostics exposes reputation details per connection', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      pushFailureScore: 2,
      lastAckOkAt: nowTs - 3_000,
      lastPushTimeoutAt: nowTs - 2_000,
    });

    const diagnostics = bridge.buildExtendedDiagnostics('Primary');
    assert.ok(diagnostics.connection);
    assert.equal(diagnostics.connection.active > 0, true);
  } finally {
    cleanupBridge(bridge);
  }
});

test('markSeen preserves capability and reputation state', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 10_000,
      inboundOnly: true,
      lastAckOkAt: nowTs - 5_000,
      lastPushTimeoutAt: nowTs - 7_000,
      pushFailureScore: 2,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');

    bridge.markSeen('Primary', 'conn-a', 'client-a');
    const conn = bridge.connections.get('Primary:client-a');
    assert.equal(conn.outboundReadyUntil > nowTs, true);
    assert.equal(conn.preferredForOutboundUntil > nowTs, true);
    assert.equal(conn.inboundOnly, true);
    assert.equal(conn.lastAckOkAt > 0, true);
    assert.equal(conn.lastPushTimeoutAt > 0, true);
    assert.equal(conn.pushFailureScore, 2);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck success clears failure score and refreshes lastAckOkAt', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      pushFailureScore: 3,
      lastPushTimeoutAt: nowTs - 2_000,
    });
    const entry = makeEntry('msg-ack-rep', 'ack rep');
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: { accountId: 'Primary', clientId: 'client-a', messageId: 'msg-ack-rep', ok: true },
      respond() {},
      client: { connId: 'conn-a' },
      context: null,
    });

    const conn = bridge.connections.get('Primary:client-a');
    assert.equal(conn.pushFailureScore, 3);
    assert.equal(conn.lastAckOkAt > 0, false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck success treats invalid entry createdAt as zero queue latency', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
    });
    const entry = makeEntry('msg-invalid-created-at-ack', 'ack invalid createdAt');
    entry.createdAt = 'not-a-number';
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: { accountId: 'Primary', clientId: 'client-a', messageId: entry.messageId, ok: true },
      respond() {},
      client: { connId: 'conn-a' },
      context: null,
    });

    assert.equal(bridge.lastAckQueueLatencyMsByAccount.get('Primary'), 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('ack timeout increments failure score and degrades capability', async () => {
  const logs = [];
  const bridge = createBncrBridge(createApiStub());
  const originalLogInfo = bridge.logInfo.bind(bridge);
  bridge.logInfo = (scope, message, options) => {
    logs.push({ scope, message, options });
    return originalLogInfo(scope, message, options);
  };
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 10_000,
      pushFailureScore: 0,
    });
    bridge.gatewayContext = { broadcastToConnIds() {} };
    const entry = makeEntry('msg-timeout', 'timeout rep');
    entry.lastPushConnId = 'conn-a';
    entry.lastPushClientId = 'client-a';
    bridge.outbox.set(entry.messageId, entry);
    bridge.ackTimeoutCountByAccount.set('Primary', 1);
    bridge.lateAckOkCountByAccount.set('Primary', 1);
    bridge.lastLateAckPushLatencyMsByAccount.set('Primary', 48000);
    bridge.tryPushEntry = async () => true;
    let observedWaitMs = null;
    bridge.waitForMessageAck = async (_messageId, waitMs) => {
      observedWaitMs = waitMs;
      return 'timeout';
    };
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => true;
    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'timeout' });
    assert.equal(observedWaitMs, 60000);
    const timeoutSummary = logs.find((item) => item.scope === 'outbox ack timeout');
    assert.ok(timeoutSummary);
    assert.match(timeoutSummary.message, /waitMs=60000/);
    const ackDebug = logs.find(
      (item) => item.scope === 'outbox' && item.message.startsWith('ack '),
    );
    assert.ok(ackDebug);
    assert.match(ackDebug.message, /"ackTimeoutMs":60000/);
    assert.match(ackDebug.message, /"adaptiveAckTimeoutEnabled":true/);
    const conn = bridge.connections.get('Primary:client-a');
    assert.equal(conn.pushFailureScore, 0);
    assert.equal(Number(conn.outboundReadyUntil || 0) > 0, true);
    assert.equal(Number(conn.preferredForOutboundUntil || 0) > 0, true);
  } finally {
    bridge.logInfo = originalLogInfo;
    cleanupBridge(bridge);
  }
});

test('handleFileInit rejects oversized and inconsistent transfer declarations without creating state', async () => {
  const bridge = createBncrBridge(createApiStub());
  const validSessionKey = `agent:orion:bncr:direct:${Buffer.from('tgBot:0:10001').toString('hex')}`;

  try {
    const invalidCases = [
      {
        name: 'oversized fileSize',
        transferId: 'recv-init-oversized',
        fileSize: 50 * 1024 * 1024 + 1,
        chunkSize: 256 * 1024,
        totalChunks: 201,
        error: /fileSize too large/,
      },
      {
        name: 'inconsistent totalChunks',
        transferId: 'recv-init-inconsistent',
        fileSize: 5,
        chunkSize: 2,
        totalChunks: 2,
        error: /totalChunks mismatch/,
      },
      {
        name: 'excessive totalChunks',
        transferId: 'recv-init-too-many-chunks',
        fileSize: 4097,
        chunkSize: 1,
        totalChunks: 4097,
        error: /totalChunks too large/,
      },
    ];

    for (const item of invalidCases) {
      let respondPayload = null;
      await bridge.handleFileInit({
        params: {
          accountId: 'Primary',
          clientId: 'client-a',
          transferId: item.transferId,
          sessionKey: validSessionKey,
          platform: 'tgBot',
          groupId: '0',
          userId: '10001',
          fileName: `${item.name}.txt`,
          mimeType: 'text/plain',
          fileSize: item.fileSize,
          chunkSize: item.chunkSize,
          totalChunks: item.totalChunks,
        },
        respond(ok, payload) {
          respondPayload = { ok, payload };
        },
        client: { connId: 'conn-1' },
        context: null,
      });

      assert.equal(respondPayload.ok, false, item.name);
      assert.match(respondPayload.payload.error, item.error, item.name);
      assert.equal(bridge.fileRecvTransfers.has(item.transferId), false, item.name);
    }
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileChunk rejects invalid numeric chunk inputs without mutating transfer state', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileRecvTransfers.set('recv-invalid-chunk', {
      transferId: 'recv-invalid-chunk',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
      fileSha256: '',
      startedAt: Date.now(),
      status: 'init',
      bufferByChunk: new Map(),
      receivedChunks: new Set(),
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileChunk({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-invalid-chunk',
        chunkIndex: 'not-a-number',
        offset: 0,
        size: 5,
        base64: Buffer.from('hello').toString('base64'),
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, false);
    assert.match(respondPayload.payload.error, /chunkIndex/);
    const st = bridge.fileRecvTransfers.get('recv-invalid-chunk');
    assert.equal(st.receivedChunks.size, 0);
    assert.equal(st.bufferByChunk.size, 0);
    assert.equal(st.status, 'init');
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileChunk rejects out-of-range chunk indexes without mutating transfer state', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileRecvTransfers.set('recv-out-of-range-chunk', {
      transferId: 'recv-out-of-range-chunk',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
      fileSha256: '',
      startedAt: Date.now(),
      status: 'init',
      bufferByChunk: new Map(),
      receivedChunks: new Set(),
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileChunk({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-out-of-range-chunk',
        chunkIndex: 1,
        offset: 5,
        size: 5,
        base64: Buffer.from('hello').toString('base64'),
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, false);
    assert.match(respondPayload.payload.error, /chunkIndex out of range/);
    const st = bridge.fileRecvTransfers.get('recv-out-of-range-chunk');
    assert.equal(st.receivedChunks.size, 0);
    assert.equal(st.bufferByChunk.size, 0);
    assert.equal(st.status, 'init');
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileComplete aborts inbound transfer when chunks are missing', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileRecvTransfers.set('recv-complete-missing-chunk', {
      transferId: 'recv-complete-missing-chunk',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'missing-chunk.txt',
      mimeType: 'text/plain',
      fileSize: 10,
      chunkSize: 5,
      totalChunks: 2,
      fileSha256: '',
      startedAt: Date.now() - 1_000,
      status: 'transferring',
      bufferByChunk: new Map([[0, Buffer.from('hello')]]),
      receivedChunks: new Set([0]),
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileComplete({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-complete-missing-chunk',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, false);
    assert.match(respondPayload.payload.error, /chunk not complete received=1 total=2/);
    const st = bridge.fileRecvTransfers.get('recv-complete-missing-chunk');
    assert.equal(st.status, 'aborted');
    assert.match(st.error, /chunk not complete received=1 total=2/);
    assert.equal(typeof st.terminalAt, 'number');
    assert.equal(st.completedPath, undefined);
    assert.equal(st.receivedChunks.size, 1);
    assert.equal(st.bufferByChunk.get(0).toString(), 'hello');
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileComplete aborts inbound transfer on sha256 mismatch', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileRecvTransfers.set('recv-complete-sha-mismatch', {
      transferId: 'recv-complete-sha-mismatch',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'sha-mismatch.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
      fileSha256: '0000000000000000000000000000000000000000000000000000000000000000',
      startedAt: Date.now() - 1_000,
      status: 'transferring',
      bufferByChunk: new Map([[0, Buffer.from('hello')]]),
      receivedChunks: new Set([0]),
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileComplete({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-complete-sha-mismatch',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, false);
    assert.match(respondPayload.payload.error, /file sha256 mismatch/);
    const st = bridge.fileRecvTransfers.get('recv-complete-sha-mismatch');
    assert.equal(st.status, 'aborted');
    assert.equal(st.error, 'file sha256 mismatch');
    assert.equal(typeof st.terminalAt, 'number');
    assert.equal(st.completedPath, undefined);
    assert.equal(st.receivedChunks.size, 1);
    assert.equal(st.bufferByChunk.get(0).toString(), 'hello');
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileChunk ignores chunks after inbound transfer is completed', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileRecvTransfers.set('recv-completed-late-chunk', {
      transferId: 'recv-completed-late-chunk',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
      fileSha256: '',
      startedAt: Date.now() - 1_000,
      terminalAt: Date.now() - 500,
      completedPath: '/tmp/completed-demo.txt',
      status: 'completed',
      bufferByChunk: new Map([[0, Buffer.from('hello')]]),
      receivedChunks: new Set([0]),
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileChunk({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-completed-late-chunk',
        chunkIndex: 0,
        offset: 0,
        size: 4,
        base64: Buffer.from('oops').toString('base64'),
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, true);
    assert.equal(respondPayload.payload.status, 'completed');
    assert.equal(respondPayload.payload.ignored, true);
    assert.equal(respondPayload.payload.terminal, true);
    const st = bridge.fileRecvTransfers.get('recv-completed-late-chunk');
    assert.equal(st.status, 'completed');
    assert.equal(st.completedPath, '/tmp/completed-demo.txt');
    assert.equal(st.bufferByChunk.get(0).toString(), 'hello');
    assert.equal(st.receivedChunks.size, 1);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileAbort ignores abort after inbound transfer is completed', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileRecvTransfers.set('recv-completed-late-abort', {
      transferId: 'recv-completed-late-abort',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
      fileSha256: '',
      startedAt: Date.now() - 1_000,
      terminalAt: Date.now() - 500,
      completedPath: '/tmp/completed-demo.txt',
      status: 'completed',
      bufferByChunk: new Map([[0, Buffer.from('hello')]]),
      receivedChunks: new Set([0]),
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileAbort({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'recv-completed-late-abort',
        reason: 'late abort should not override completed',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, true);
    assert.equal(respondPayload.payload.status, 'completed');
    assert.equal(respondPayload.payload.ignored, true);
    assert.equal(respondPayload.payload.terminal, true);
    const st = bridge.fileRecvTransfers.get('recv-completed-late-abort');
    assert.equal(st.status, 'completed');
    assert.equal(st.completedPath, '/tmp/completed-demo.txt');
    assert.equal(st.error, undefined);
  } finally {
    cleanupBridge(bridge);
  }
});

test('waitChunkAck uses file ack waiter instead of polling transfer state', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileSendTransfers.set('transfer-event-chunk', {
      transferId: 'transfer-event-chunk',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      status: 'init',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const waiter = bridge.waitChunkAck({
      transferId: 'transfer-event-chunk',
      chunkIndex: 0,
      timeoutMs: 1_000,
    });
    assert.equal(bridge.fileAckWaiters.size, 1);

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-event-chunk',
        stage: 'chunk',
        chunkIndex: 0,
        ok: true,
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    await waiter;
    assert.equal(bridge.fileAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('waitCompleteAck uses file ack waiter instead of polling transfer state', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileSendTransfers.set('transfer-event-complete', {
      transferId: 'transfer-event-complete',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      status: 'transferring',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const waiter = bridge.waitCompleteAck({
      transferId: 'transfer-event-complete',
      timeoutMs: 1_000,
    });
    assert.equal(bridge.fileAckWaiters.size, 1);

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-event-complete',
        stage: 'complete',
        ok: true,
        path: '/tmp/demo.png',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(await waiter, { path: '/tmp/demo.png' });
    assert.equal(bridge.fileAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('waitForFileAck falls back to bounded timeout for invalid timeout input', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const waiter = bridge.waitForFileAck({
      transferId: 'transfer-invalid-timeout',
      stage: 'chunk',
      chunkIndex: 0,
      timeoutMs: 'not-a-number',
    });
    const stored = bridge.fileAckWaiters.get('transfer-invalid-timeout|chunk|0');
    assert.ok(stored?.timer);

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-invalid-timeout',
        stage: 'chunk',
        chunkIndex: 0,
        ok: true,
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    await waiter;
    assert.equal(bridge.fileAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('file ack keys treat non-integer chunk indexes as stage-level acks', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const waiter = bridge.waitForFileAck({
      transferId: 'transfer-decimal-chunk',
      stage: 'chunk',
      chunkIndex: 1.5,
      timeoutMs: 1_000,
    });

    assert.equal(bridge.fileAckWaiters.has('transfer-decimal-chunk|chunk|-'), true);
    assert.equal(bridge.fileAckWaiters.has('transfer-decimal-chunk|chunk|1.5'), false);

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-decimal-chunk',
        stage: 'chunk',
        chunkIndex: 1.5,
        ok: true,
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    await waiter;
    assert.equal(bridge.fileAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('waitForFileAck reuses duplicate waiter for the same transfer stage key', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileSendTransfers.set('transfer-event-duplicate', {
      transferId: 'transfer-event-duplicate',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      status: 'transferring',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const waiter1 = bridge.waitCompleteAck({
      transferId: 'transfer-event-duplicate',
      timeoutMs: 1_000,
    });
    const waiter2 = bridge.waitCompleteAck({
      transferId: 'transfer-event-duplicate',
      timeoutMs: 1_000,
    });

    assert.equal(bridge.fileAckWaiters.size, 1);

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-event-duplicate',
        stage: 'complete',
        ok: true,
        path: '/tmp/demo-duplicate.png',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(await waiter1, { path: '/tmp/demo-duplicate.png' });
    assert.deepEqual(await waiter2, { path: '/tmp/demo-duplicate.png' });
    assert.equal(bridge.fileAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('file ack debug logs include transfer owner context', async () => {
  const logs = [];
  const bridge = createBncrBridge(createApiStub());
  const originalLogInfo = bridge.logInfo.bind(bridge);
  bridge.logInfo = (scope, message, options) => {
    logs.push({ scope, message, options });
    return originalLogInfo(scope, message, options);
  };

  try {
    bridge.fileSendTransfers.set('transfer-owner-logs', {
      transferId: 'transfer-owner-logs',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      ownerConnId: 'conn-owner',
      ownerClientId: 'client-owner',
      status: 'transferring',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const waiter = bridge.waitChunkAck({
      transferId: 'transfer-owner-logs',
      chunkIndex: 0,
      timeoutMs: 1_000,
    });
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-owner-logs',
        stage: 'chunk',
        chunkIndex: 0,
        ok: true,
      },
      respond() {},
      client: { connId: 'conn-owner' },
      context: null,
    });

    await waiter;

    const waitLog = logs.find((item) => item.scope === 'file-ack-wait');
    const resolveLog = logs.find((item) => item.scope === 'file-ack-resolve');
    assert.equal(JSON.parse(waitLog.message).ownerConnId, 'conn-owner');
    assert.equal(JSON.parse(waitLog.message).ownerClientId, 'client-owner');
    assert.equal(JSON.parse(resolveLog.message).ownerConnId, 'conn-owner');
    assert.equal(JSON.parse(resolveLog.message).ownerClientId, 'client-owner');
  } finally {
    bridge.logInfo = originalLogInfo;
    cleanupBridge(bridge);
  }
});

test('handleFileAck failure rejects waiter and clears file ack waiter state', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileSendTransfers.set('transfer-event-fail', {
      transferId: 'transfer-event-fail',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      status: 'transferring',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const waiter = bridge.waitCompleteAck({ transferId: 'transfer-event-fail', timeoutMs: 1_000 });
    assert.equal(bridge.fileAckWaiters.size, 1);

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-event-fail',
        stage: 'complete',
        ok: false,
        errorCode: 'ACK_FAILED',
        errorMessage: 'explicit fail ack',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    await assert.rejects(waiter, /explicit fail ack/);
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.fileSendTransfers.get('transfer-event-fail')?.status, 'aborted');
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileAck ignores chunk ack mutation after outbound transfer is completed', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileSendTransfers.set('transfer-ack-completed-late-chunk', {
      transferId: 'transfer-ack-completed-late-chunk',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set([0]),
      failedChunks: new Map(),
      status: 'completed',
      completedPath: '/tmp/completed.png',
      terminalAt: Date.now() - 500,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'transfer-ack-completed-late-chunk',
        stage: 'chunk',
        chunkIndex: 0,
        ok: false,
        errorCode: 'LATE_CHUNK_FAIL',
        errorMessage: 'should stay completed',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, true);
    assert.equal(respondPayload.payload.state, 'completed');
    assert.equal(respondPayload.payload.ignored, true);
    assert.equal(respondPayload.payload.terminal, true);
    const st = bridge.fileSendTransfers.get('transfer-ack-completed-late-chunk');
    assert.equal(st.status, 'completed');
    assert.equal(st.completedPath, '/tmp/completed.png');
    assert.equal(st.failedChunks.size, 0);
    assert.equal(st.error, undefined);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileAck ignores complete ok mutation after outbound transfer is aborted', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileSendTransfers.set('transfer-ack-aborted-late-complete', {
      transferId: 'transfer-ack-aborted-late-complete',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map([[0, 'CHUNK_FAILED:original']]),
      status: 'aborted',
      error: 'CHUNK_FAILED:original',
      terminalAt: Date.now() - 500,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
      ownerConnId: 'conn-1',
      ownerClientId: 'client-a',
    });

    let respondPayload = null;
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'transfer-ack-aborted-late-complete',
        stage: 'complete',
        ok: true,
        path: '/tmp/late-complete.png',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(respondPayload.ok, true);
    assert.equal(respondPayload.payload.state, 'aborted');
    assert.equal(respondPayload.payload.ignored, true);
    assert.equal(respondPayload.payload.terminal, true);
    const st = bridge.fileSendTransfers.get('transfer-ack-aborted-late-complete');
    assert.equal(st.status, 'aborted');
    assert.equal(st.completedPath, undefined);
    assert.equal(st.error, 'CHUNK_FAILED:original');
    assert.equal(st.failedChunks.get(0), 'CHUNK_FAILED:original');
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleFileAck reports stale terminal completed ack as ignored without staleAccepted', async () => {
  const bridge = createBncrBridge(createApiStub());
  const originalObserveLease = bridge.observeLease;

  try {
    bridge.observeLease = (...args) => ({
      ...originalObserveLease.call(bridge, ...args),
      stale: true,
    });
    bridge.fileSendTransfers.set('transfer-ack-stale-terminal-completed', {
      transferId: 'transfer-ack-stale-terminal-completed',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set([0]),
      failedChunks: new Map(),
      status: 'completed',
      completedPath: '/tmp/completed.png',
      terminalAt: Date.now() - 500,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
      ownerConnId: 'conn-owner',
      ownerClientId: 'owner',
    });

    let respondPayload = null;
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        clientId: 'other',
        transferId: 'transfer-ack-stale-terminal-completed',
        stage: 'chunk',
        chunkIndex: 0,
        ok: false,
        errorCode: 'STALE_LATE_CHUNK',
        errorMessage: 'should stay terminal ignored',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-other' },
      context: null,
    });

    assert.equal(respondPayload.ok, true);
    assert.equal(respondPayload.payload.state, 'completed');
    assert.equal(respondPayload.payload.stale, true);
    assert.equal(respondPayload.payload.ignored, true);
    assert.equal(respondPayload.payload.terminal, true);
    assert.equal('staleAccepted' in respondPayload.payload, false);
    const st = bridge.fileSendTransfers.get('transfer-ack-stale-terminal-completed');
    assert.equal(st.status, 'completed');
    assert.equal(st.completedPath, '/tmp/completed.png');
    assert.equal(st.ownerConnId, 'conn-owner');
    assert.equal(st.ownerClientId, 'owner');
    assert.equal(st.failedChunks.size, 0);
    assert.equal(st.error, undefined);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    bridge.observeLease = originalObserveLease;
    cleanupBridge(bridge);
  }
});

test('handleFileAck reports stale terminal aborted ack as ignored without staleAccepted', async () => {
  const bridge = createBncrBridge(createApiStub());
  const originalObserveLease = bridge.observeLease;

  try {
    bridge.observeLease = (...args) => ({
      ...originalObserveLease.call(bridge, ...args),
      stale: true,
    });
    bridge.fileSendTransfers.set('transfer-ack-stale-terminal-aborted', {
      transferId: 'transfer-ack-stale-terminal-aborted',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map([[0, 'CHUNK_FAILED:original']]),
      status: 'aborted',
      error: 'CHUNK_FAILED:original',
      terminalAt: Date.now() - 500,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
      ownerConnId: 'conn-owner',
      ownerClientId: 'owner',
    });

    let respondPayload = null;
    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        clientId: 'other',
        transferId: 'transfer-ack-stale-terminal-aborted',
        stage: 'complete',
        ok: true,
        path: '/tmp/stale-late-complete.png',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-other' },
      context: null,
    });

    assert.equal(respondPayload.ok, true);
    assert.equal(respondPayload.payload.state, 'aborted');
    assert.equal(respondPayload.payload.stale, true);
    assert.equal(respondPayload.payload.ignored, true);
    assert.equal(respondPayload.payload.terminal, true);
    assert.equal('staleAccepted' in respondPayload.payload, false);
    const st = bridge.fileSendTransfers.get('transfer-ack-stale-terminal-aborted');
    assert.equal(st.status, 'aborted');
    assert.equal(st.completedPath, undefined);
    assert.equal(st.error, 'CHUNK_FAILED:original');
    assert.equal(st.failedChunks.get(0), 'CHUNK_FAILED:original');
    assert.equal(st.ownerConnId, 'conn-owner');
    assert.equal(st.ownerClientId, 'owner');
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    bridge.observeLease = originalObserveLease;
    cleanupBridge(bridge);
  }
});

test('early cached complete file ack resolves later waiter immediately', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileSendTransfers.set('transfer-event-early-complete', {
      transferId: 'transfer-event-early-complete',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      status: 'transferring',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-event-early-complete',
        stage: 'complete',
        ok: true,
        path: '/tmp/early-complete.png',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 1);
    assert.equal(
      bridge.fileSendTransfers.get('transfer-event-early-complete')?.status,
      'completed',
    );
    assert.equal(
      bridge.fileSendTransfers.get('transfer-event-early-complete')?.completedPath,
      '/tmp/early-complete.png',
    );

    bridge.fileSendTransfers.get('transfer-event-early-complete').status = 'transferring';
    bridge.fileSendTransfers.get('transfer-event-early-complete').completedPath = undefined;

    const result = await bridge.waitCompleteAck({
      transferId: 'transfer-event-early-complete',
      timeoutMs: 1_000,
    });
    assert.deepEqual(result, { path: '/tmp/early-complete.png' });
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('early cached failed file ack rejects later waiter immediately', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileSendTransfers.set('transfer-event-early-fail', {
      transferId: 'transfer-event-early-fail',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      status: 'transferring',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await bridge.handleFileAck({
      params: {
        accountId: 'Primary',
        transferId: 'transfer-event-early-fail',
        stage: 'complete',
        ok: false,
        errorCode: 'EARLY_FAIL',
        errorMessage: 'cached fail ack',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    bridge.fileSendTransfers.get('transfer-event-early-fail').status = 'transferring';
    bridge.fileSendTransfers.get('transfer-event-early-fail').error = undefined;

    assert.equal(bridge.fileAckWaiters.size, 0);
    await assert.rejects(
      bridge.waitCompleteAck({ transferId: 'transfer-event-early-fail', timeoutMs: 1_000 }),
      /cached fail ack/,
    );
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('early file ack cache keeps bounded newest entries', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    for (let i = 0; i < 1005; i++) {
      bridge.resolveFileAck({
        transferId: `transfer-early-${i}`,
        stage: 'complete',
        payload: { ok: true, transferId: `transfer-early-${i}` },
        ok: true,
      });
    }

    assert.equal(bridge.earlyFileAcks.size, 1000);
    assert.equal(bridge.earlyFileAcks.has('transfer-early-0|complete|-'), false);
    assert.equal(bridge.earlyFileAcks.has('transfer-early-4|complete|-'), false);
    assert.equal(bridge.earlyFileAcks.has('transfer-early-5|complete|-'), true);
    assert.equal(bridge.earlyFileAcks.has('transfer-early-1004|complete|-'), true);
  } finally {
    cleanupBridge(bridge);
  }
});

test('shutdown rejects file ack waiters and clears cached early file ack state', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileSendTransfers.set('transfer-event-shutdown', {
      transferId: 'transfer-event-shutdown',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      status: 'transferring',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const waiter = bridge.waitCompleteAck({
      transferId: 'transfer-event-shutdown',
      timeoutMs: 1_000,
    });
    bridge.earlyFileAcks.set('transfer-event-shutdown|complete|-', {
      payload: {
        ok: false,
        transferId: 'transfer-event-shutdown',
        stage: 'complete',
        errorMessage: 'cached before shutdown',
      },
      ok: false,
      at: Date.now(),
    });

    assert.equal(bridge.fileAckWaiters.size, 1);
    assert.equal(bridge.earlyFileAcks.size, 1);

    bridge.shutdown();

    await assert.rejects(waiter, /shutdown/);
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('stopService rejects file ack waiters and clears cached early file ack state', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    bridge.fileSendTransfers.set('transfer-event-stop-service', {
      transferId: 'transfer-event-stop-service',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'demo.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      status: 'transferring',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const waiter = bridge.waitCompleteAck({
      transferId: 'transfer-event-stop-service',
      timeoutMs: 1_000,
    });
    bridge.earlyFileAcks.set('transfer-event-stop-service|complete|-', {
      payload: {
        ok: false,
        transferId: 'transfer-event-stop-service',
        stage: 'complete',
        errorMessage: 'cached before stop',
      },
      ok: false,
      at: Date.now(),
    });

    assert.equal(bridge.fileAckWaiters.size, 1);
    assert.equal(bridge.earlyFileAcks.size, 1);

    await bridge.stopService();

    await assert.rejects(waiter, /service stopped/);
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('getRevalidatedAttemptReason treats invalid numeric fields as stale', () => {
  const nowTs = Date.now();
  const entry = makeEntry('msg-invalid-revalidate', 'invalid revalidate');
  entry.lastAttemptAt = 'not-a-number';

  const result = getRevalidatedAttemptReason({
    entry,
    connId: 'conn-bad',
    accountId: 'Primary',
    now: nowTs,
    connectTtlMs: 30_000,
    recentInboundReachable: true,
    connections: [
      {
        accountId: 'Primary',
        connId: 'conn-bad',
        clientId: 'client-bad',
        connectedAt: nowTs - 10_000,
        lastSeenAt: nowTs - 1_000,
        preferredForOutboundUntil: 'not-a-number',
        outboundReadyUntil: 'not-a-number',
        lastAckOkAt: 'not-a-number',
        lastPushTimeoutAt: 'not-a-number',
      },
    ],
  });

  assert.equal(result, null);
});

test('startService reopens runtime scheduling after stopService cleanup', async () => {
  const bridge = createBncrBridge(createApiStub());
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-start-stop-'));

  try {
    await bridge.stopService();
    assert.equal(bridge.stopped, true);

    await bridge.startService({ stateDir }, false);
    assert.equal(bridge.stopped, false);

    bridge.schedulePushDrain(1_000);
    assert.ok(bridge.pushTimer, 'schedulePushDrain should work after restart');
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('transferMediaToBncrClient chunk mode records init transferring and completed states', async () => {
  const bridge = createBncrBridge(createApiStub());
  const originalLoad = bridge.loadOutboundTransferMedia;
  const broadcasts = [];

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');
    bridge.loadOutboundTransferMedia = async () => ({
      loaded: {
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 7),
        contentType: 'application/octet-stream',
        fileName: 'large.bin',
      },
      size: 5 * 1024 * 1024 + 1,
      mimeType: 'application/octet-stream',
      fileName: 'large.bin',
    });
    bridge.gatewayContext = {
      broadcastToConnIds(event, payload, connIds) {
        broadcasts.push({ event, payload, connIds: Array.from(connIds) });
        if (event === 'plugin.bncr.file.chunk') {
          queueMicrotask(() => {
            bridge.handleFileAck({
              params: {
                accountId: 'Primary',
                clientId: 'client-a',
                transferId: payload.transferId,
                stage: 'chunk',
                chunkIndex: payload.chunkIndex,
                ok: true,
              },
              respond() {},
              client: { connId: 'conn-a' },
              context: bridge.gatewayContext,
            });
          });
        }
        if (event === 'plugin.bncr.file.complete') {
          queueMicrotask(() => {
            bridge.handleFileAck({
              params: {
                accountId: 'Primary',
                clientId: 'client-a',
                transferId: payload.transferId,
                stage: 'complete',
                ok: true,
                path: '/tmp/large.bin',
              },
              respond() {},
              client: { connId: 'conn-a' },
              context: bridge.gatewayContext,
            });
          });
        }
      },
    };

    const result = await bridge.transferMediaToBncrClient({
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      mediaUrl: 'file:///tmp/large.bin',
    });

    const init = broadcasts.find((call) => call.event === 'plugin.bncr.file.init');
    const chunks = broadcasts.filter((call) => call.event === 'plugin.bncr.file.chunk');
    const complete = broadcasts.find((call) => call.event === 'plugin.bncr.file.complete');
    assert.equal(result.mode, 'chunk');
    assert.equal(result.path, '/tmp/large.bin');
    assert.ok(init, 'init event should be broadcast');
    assert.equal(init.payload.totalChunks, 21);
    assert.equal(chunks.length, 21);
    assert.ok(complete, 'complete event should be broadcast');
    assert.equal(complete.payload.transferId, init.payload.transferId);
    assert.deepEqual(init.connIds, ['conn-a']);

    const state = bridge.fileSendTransfers.get(init.payload.transferId);
    assert.ok(state, 'send transfer state should remain for cleanup TTL');
    assert.equal(state.status, 'completed');
    assert.equal(state.completedPath, '/tmp/large.bin');
    assert.equal(state.ackedChunks.size, 21);
    assert.equal(state.failedChunks.size, 0);
    assert.equal(state.ownerConnId, 'conn-a');
    assert.equal(state.ownerClientId, 'client-a');
    assert.equal(bridge.fileAckWaiters.size, 0);
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    bridge.loadOutboundTransferMedia = originalLoad;
    cleanupBridge(bridge);
  }
});

test('transferMediaToBncrClient aborts chunk mode after retry exhaustion', async () => {
  const bridge = createBncrBridge(createApiStub());
  const originalLoad = bridge.loadOutboundTransferMedia;
  const originalSleep = bridge.sleepMs;
  const broadcasts = [];

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');
    bridge.loadOutboundTransferMedia = async () => ({
      loaded: {
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 9),
        contentType: 'application/octet-stream',
        fileName: 'retry.bin',
      },
      size: 5 * 1024 * 1024 + 1,
      mimeType: 'application/octet-stream',
      fileName: 'retry.bin',
    });
    bridge.sleepMs = async () => {};
    bridge.gatewayContext = {
      broadcastToConnIds(event, payload, connIds) {
        broadcasts.push({ event, payload, connIds: Array.from(connIds) });
        if (event === 'plugin.bncr.file.chunk') {
          queueMicrotask(() => {
            bridge.handleFileAck({
              params: {
                accountId: 'Primary',
                clientId: 'client-a',
                transferId: payload.transferId,
                stage: 'chunk',
                chunkIndex: payload.chunkIndex,
                ok: false,
                errorCode: 'CHUNK_WRITE_FAILED',
                errorMessage: 'cannot write chunk',
              },
              respond() {},
              client: { connId: 'conn-a' },
              context: bridge.gatewayContext,
            });
          });
        }
      },
    };

    await assert.rejects(
      bridge.transferMediaToBncrClient({
        accountId: 'Primary',
        sessionKey: 'agent:orion:bncr:direct:demo',
        route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
        mediaUrl: 'file:///tmp/retry.bin',
      }),
      /CHUNK_WRITE_FAILED:cannot write chunk/,
    );

    const init = broadcasts.find((call) => call.event === 'plugin.bncr.file.init');
    const chunks = broadcasts.filter((call) => call.event === 'plugin.bncr.file.chunk');
    const abort = broadcasts.find((call) => call.event === 'plugin.bncr.file.abort');
    const complete = broadcasts.find((call) => call.event === 'plugin.bncr.file.complete');
    assert.ok(init, 'init event should be broadcast before retries');
    assert.equal(chunks.length, 3, 'first chunk should be retried three times before abort');
    assert.ok(chunks.every((call) => call.payload.transferId === init.payload.transferId));
    assert.ok(chunks.every((call) => call.payload.chunkIndex === 0));
    assert.ok(abort, 'abort event should be broadcast after retry exhaustion');
    assert.equal(abort.payload.transferId, init.payload.transferId);
    assert.match(abort.payload.reason, /CHUNK_WRITE_FAILED:cannot write chunk/);
    assert.equal(complete, undefined);

    const state = bridge.fileSendTransfers.get(init.payload.transferId);
    assert.ok(state, 'aborted send transfer state should remain for cleanup TTL');
    assert.equal(state.status, 'aborted');
    assert.match(state.error, /CHUNK_WRITE_FAILED:cannot write chunk/);
    assert.equal(state.failedChunks.get(0), 'CHUNK_WRITE_FAILED:cannot write chunk');
    assert.equal(state.ackedChunks.size, 0);
    assert.ok(typeof state.terminalAt === 'number');
    assert.equal(state.ownerConnId, 'conn-a');
    assert.equal(state.ownerClientId, 'client-a');
    assert.equal(bridge.fileAckWaiters.size, 0);
  } finally {
    bridge.loadOutboundTransferMedia = originalLoad;
    bridge.sleepMs = originalSleep;
    cleanupBridge(bridge);
  }
});

test('file transfer adopt only allows current outbound owner', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:owner', {
      accountId: 'Primary',
      connId: 'conn-owner',
      clientId: 'owner',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 10_000,
    });
    bridge.connections.set('Primary:other', {
      accountId: 'Primary',
      connId: 'conn-other',
      clientId: 'other',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 500,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: 0,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:owner');
    const transfer = { ownerConnId: undefined, ownerClientId: undefined };
    assert.equal(
      bridge.tryAdoptTransferOwner({
        accountId: 'Primary',
        transfer,
        connId: 'conn-other',
        clientId: 'other',
      }),
      false,
    );
    assert.equal(
      bridge.tryAdoptTransferOwner({
        accountId: 'Primary',
        transfer,
        connId: 'conn-owner',
        clientId: 'owner',
      }),
      false,
    );
  } finally {
    cleanupBridge(bridge);
  }
});

test('push path does not depend on recent inbound helper fallback', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: 0,
      preferredForOutboundUntil: 0,
      inboundOnly: false,
    });
    bridge.lastInboundByAccount.set('Primary', nowTs - 500);
    let broadcastCalls = 0;
    bridge.gatewayContext = {
      broadcastToConnIds() {
        broadcastCalls += 1;
      },
    };

    const entry = makeEntry('msg-no-recent-inbound', 'no recent inbound fallback');
    bridge.outbox.set(entry.messageId, entry);

    const pushed = await bridge.tryPushEntry(entry);
    assert.equal(pushed, true);
    assert.equal(broadcastCalls, 1);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleInbound does not force inboundOnly false', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      inboundOnly: true,
    });
    await bridge.handleInbound({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        type: 'text',
        msg: 'hello',
        msgId: 'inbound-keep-inboundOnly',
      },
      respond() {},
      client: { connId: 'conn-a' },
      context: null,
    });
    const conn = bridge.connections.get('Primary:client-a');
    assert.equal(conn.inboundOnly, true);
  } finally {
    cleanupBridge(bridge);
  }
});

test('first ack timeout fast-reroutes away from lastPushConnId when an alternative exists', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.connections.set('Primary:client-b', {
      accountId: 'Primary',
      connId: 'conn-b',
      clientId: 'client-b',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');

    const firstPushes = [];
    bridge.gatewayContext = {
      broadcastToConnIds(_event, _payload, connIds) {
        firstPushes.push(Array.from(connIds));
      },
    };

    const entry = makeEntry('msg-fast-reroute', 'fast reroute');
    entry.lastPushConnId = 'conn-a';
    entry.lastPushClientId = 'client-a';
    bridge.outbox.set(entry.messageId, entry);
    bridge.waitForMessageAck = async () => 'timeout';
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => true;

    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'fast-reroute' });

    const updated = bridge.outbox.get(entry.messageId);
    assert.deepEqual(firstPushes[0], ['conn-a']);
    assert.deepEqual(updated.routeAttemptConnIds, ['conn-a']);
    assert.equal(updated.fastReroutePending, true);
    assert.equal(updated.nextAttemptAt - updated.lastAttemptAt <= 1_100, true);

    const pushedEntry = makeEntry('msg-fast-reroute-next', 'fast reroute next');
    pushedEntry.routeAttemptConnIds = ['conn-a'];
    let pushedConnIds = null;
    bridge.gatewayContext = {
      broadcastToConnIds(_event, _payload, connIds) {
        pushedConnIds = Array.from(connIds);
      },
    };
    const pushed = await bridge.tryPushEntry(pushedEntry);
    assert.equal(pushed, true);
    assert.deepEqual(pushedConnIds, ['conn-b']);
    assert.equal(pushedEntry.lastPushConnId, 'conn-b');
  } finally {
    cleanupBridge(bridge);
  }
});

test('route attempts reset after all visible candidates are exhausted and original ordering becomes reusable', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.connections.set('Primary:client-b', {
      accountId: 'Primary',
      connId: 'conn-b',
      clientId: 'client-b',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');

    const firstPushes = [];
    bridge.gatewayContext = {
      broadcastToConnIds(_event, _payload, connIds) {
        firstPushes.push(Array.from(connIds));
      },
    };

    const entry = makeEntry('msg-route-reset', 'route reset');
    entry.lastPushConnId = 'conn-b';
    entry.lastPushClientId = 'client-b';
    entry.routeAttemptConnIds = ['conn-a'];
    entry.fastReroutePending = true;
    bridge.outbox.set(entry.messageId, entry);
    bridge.waitForMessageAck = async () => 'timeout';
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => true;

    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'route-reset' });

    const updated = bridge.outbox.get(entry.messageId);
    assert.deepEqual(firstPushes[0], ['conn-b']);
    assert.deepEqual(updated.routeAttemptConnIds, []);
    assert.equal(updated.fastReroutePending, false);
    assert.equal(updated.routeAttemptRound, 1);

    const pushedEntry = makeEntry('msg-route-reset-next', 'route reset next');
    let pushedConnIds = null;
    bridge.gatewayContext = {
      broadcastToConnIds(_event, _payload, connIds) {
        pushedConnIds = Array.from(connIds);
      },
    };
    const pushed = await bridge.tryPushEntry(pushedEntry);
    assert.equal(pushed, true);
    assert.ok(Array.isArray(pushedConnIds));
    assert.ok(pushedConnIds.includes('conn-a'));
  } finally {
    cleanupBridge(bridge);
  }
});

test('resolvePushConnIds prefers outbound-capable live connections and falls back to ttl-live live connections', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: 0,
      preferredForOutboundUntil: 0,
      inboundOnly: false,
    });

    const owner = bridge.resolveOutboxPushOwner('Primary');
    const connIds = Array.from(bridge.resolvePushConnIds('Primary'));

    assert.equal(owner?.connId, 'conn-a');
    assert.ok(connIds.includes('conn-a'));
  } finally {
    cleanupBridge(bridge);
  }
});

test('cleanupFileTransfers prunes terminal transfers after short ttl but keeps active transfers on long ttl', async () => {
  const bridge = createBncrBridge(createApiStub());
  const originalNow = Date.now;
  const nowTs = originalNow() + 2_000_000;
  Date.now = () => nowTs;

  try {
    bridge.fileSendTransfers.set('send-completed-old', {
      transferId: 'send-completed-old',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'done.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      startedAt: nowTs - 20 * 60_000,
      terminalAt: nowTs - 11 * 60_000,
      status: 'completed',
      ackedChunks: new Set(),
      failedChunks: new Map(),
    });
    bridge.fileSendTransfers.set('send-transferring-young-for-long-ttl', {
      transferId: 'send-transferring-young-for-long-ttl',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'active.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      startedAt: nowTs - 20 * 60_000,
      status: 'transferring',
      ackedChunks: new Set(),
      failedChunks: new Map(),
    });
    bridge.fileRecvTransfers.set('recv-aborted-old', {
      transferId: 'recv-aborted-old',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'aborted.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      startedAt: nowTs - 20 * 60_000,
      terminalAt: nowTs - 11 * 60_000,
      status: 'aborted',
      bufferByChunk: new Map(),
      receivedChunks: new Set(),
    });
    bridge.fileRecvTransfers.set('recv-completed-recent', {
      transferId: 'recv-completed-recent',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'recent.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      startedAt: nowTs - 20 * 60_000,
      terminalAt: nowTs - 9 * 60_000,
      status: 'completed',
      bufferByChunk: new Map(),
      receivedChunks: new Set(),
    });
    bridge.fileSendTransfers.set('send-completed-invalid-terminal-falls-back-to-started', {
      transferId: 'send-completed-invalid-terminal-falls-back-to-started',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'invalid-terminal.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      startedAt: nowTs - 20 * 60_000,
      terminalAt: Number.NaN,
      status: 'completed',
      ackedChunks: new Set(),
      failedChunks: new Map(),
    });
    bridge.fileRecvTransfers.set('recv-active-invalid-started-kept', {
      transferId: 'recv-active-invalid-started-kept',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'invalid-started.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      startedAt: Number.POSITIVE_INFINITY,
      status: 'receiving',
      bufferByChunk: new Map(),
      receivedChunks: new Set(),
    });

    bridge.cleanupFileTransfers();

    assert.equal(bridge.fileSendTransfers.has('send-completed-old'), false);
    assert.equal(bridge.fileRecvTransfers.has('recv-aborted-old'), false);
    assert.equal(bridge.fileSendTransfers.has('send-transferring-young-for-long-ttl'), true);
    assert.equal(bridge.fileRecvTransfers.has('recv-completed-recent'), true);
    assert.equal(
      bridge.fileSendTransfers.has('send-completed-invalid-terminal-falls-back-to-started'),
      false,
    );
    assert.equal(bridge.fileRecvTransfers.has('recv-active-invalid-started-kept'), true);
  } finally {
    Date.now = originalNow;
    cleanupBridge(bridge);
  }
});

test('route owner ignores stale active and inboundOnly candidates when outbound-ready owner exists', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:stale-active', {
      accountId: 'Primary',
      connId: 'conn-stale-active',
      clientId: 'stale-active',
      connectedAt: nowTs - 10 * 60_000,
      lastSeenAt: nowTs - 5 * 60_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      inboundOnly: false,
    });
    bridge.connections.set('Primary:inbound-only', {
      accountId: 'Primary',
      connId: 'conn-inbound-only',
      clientId: 'inbound-only',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 500,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      inboundOnly: true,
    });
    bridge.connections.set('Primary:outbound-ready', {
      accountId: 'Primary',
      connId: 'conn-outbound-ready',
      clientId: 'outbound-ready',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:stale-active');
    bridge.lastInboundByAccount.set('Primary', nowTs - 500);
    bridge.lastActivityByAccount.set('Primary', nowTs - 500);

    const ownerFromStaleActive = bridge.resolveOutboxPushOwner('Primary');
    const connIdsFromStaleActive = Array.from(bridge.resolvePushConnIds('Primary'));

    assert.equal(ownerFromStaleActive?.connId, 'conn-outbound-ready');
    assert.deepEqual(connIdsFromStaleActive, ['conn-outbound-ready']);

    bridge.activeConnectionByAccount.set('Primary', 'Primary:inbound-only');

    const ownerFromInboundOnlyActive = bridge.resolveOutboxPushOwner('Primary');
    const connIdsFromInboundOnlyActive = Array.from(bridge.resolvePushConnIds('Primary'));

    assert.equal(ownerFromInboundOnlyActive?.connId, 'conn-outbound-ready');
    assert.deepEqual(connIdsFromInboundOnlyActive, ['conn-outbound-ready']);
  } finally {
    cleanupBridge(bridge);
  }
});

test('startService tolerates corrupt persisted state by falling back to empty state', async () => {
  const bridge = createBncrBridge(createApiStub());
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-corrupt-state-'));
  try {
    await fs.writeFile(path.join(stateDir, 'bncr-bridge-state.json'), '{"outbox":[', 'utf8');

    await bridge.startService({ stateDir }, false);

    assert.equal(bridge.outbox.size, 0);
    assert.equal(bridge.deadLetter.length, 0);
    assert.equal(bridge.sessionRoutes.size, 0);
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('startService caps oversized persisted account activity arrays during load', async () => {
  const bridge = createBncrBridge(createApiStub());
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-large-activity-state-'));
  try {
    const nowTs = Date.now();
    const mkAccount = (i) => `Account-${i}`;
    const mkSession = (i) => {
      const groupId = `-${200000 + i}`;
      return {
        accountId: mkAccount(i),
        sessionKey: `agent:orion:bncr:direct:${Buffer.from(`tgBot:${groupId}:10001`).toString('hex')}`,
        scope: 'ignored',
        updatedAt: nowTs + i,
      };
    };
    const mkActivity = (i) => ({ accountId: mkAccount(i), updatedAt: nowTs + i });
    const state = {
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
      lastSessionByAccount: Array.from({ length: 1005 }, (_, i) => mkSession(i)),
      lastActivityByAccount: Array.from({ length: 1005 }, (_, i) => mkActivity(i)),
      lastInboundByAccount: Array.from({ length: 1005 }, (_, i) => mkActivity(i)),
      lastOutboundByAccount: Array.from({ length: 1005 }, (_, i) => mkActivity(i)),
    };
    await fs.writeFile(
      path.join(stateDir, 'bncr-bridge-state.json'),
      JSON.stringify(state),
      'utf8',
    );

    await bridge.startService({ stateDir }, false);

    assert.equal(bridge.lastSessionByAccount.size, 1000);
    assert.equal(bridge.lastActivityByAccount.size, 1000);
    assert.equal(bridge.lastInboundByAccount.size, 1000);
    assert.equal(bridge.lastOutboundByAccount.size, 1000);
    for (const map of [
      bridge.lastSessionByAccount,
      bridge.lastActivityByAccount,
      bridge.lastInboundByAccount,
      bridge.lastOutboundByAccount,
    ]) {
      assert.equal(map.has('Account-4'), false);
      assert.equal(map.has('Account-5'), true);
      assert.equal(map.has('Account-1004'), true);
    }
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('startService caps oversized persisted session routes during load', async () => {
  const bridge = createBncrBridge(createApiStub());
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-large-routes-state-'));
  try {
    const sessionRoutes = Array.from({ length: 1005 }, (_, i) => {
      const groupId = `-${100000 + i}`;
      const route = { platform: 'tgBot', groupId, userId: '10001' };
      return {
        sessionKey: `agent:orion:bncr:direct:${Buffer.from(`tgBot:${groupId}:10001`).toString('hex')}`,
        accountId: 'Primary',
        route,
        updatedAt: Date.now() + i,
      };
    });
    const state = {
      outbox: [],
      deadLetter: [],
      sessionRoutes,
    };
    await fs.writeFile(
      path.join(stateDir, 'bncr-bridge-state.json'),
      JSON.stringify(state),
      'utf8',
    );

    await bridge.startService({ stateDir }, false);

    assert.equal(bridge.sessionRoutes.size, 1000);
    assert.equal(bridge.routeAliases.size, 1000);
    assert.equal(
      bridge.sessionRoutes.has(
        `agent:orion:bncr:direct:${Buffer.from('tgBot:-100000:10001').toString('hex')}`,
      ),
      false,
    );
    assert.equal(
      bridge.sessionRoutes.has(
        `agent:orion:bncr:direct:${Buffer.from('tgBot:-100004:10001').toString('hex')}`,
      ),
      false,
    );
    assert.equal(
      bridge.sessionRoutes.has(
        `agent:orion:bncr:direct:${Buffer.from('tgBot:-100005:10001').toString('hex')}`,
      ),
      true,
    );
    assert.equal(
      bridge.sessionRoutes.has(
        `agent:orion:bncr:direct:${Buffer.from('tgBot:-101004:10001').toString('hex')}`,
      ),
      true,
    );
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('startService caps oversized persisted deadLetter state during load', async () => {
  const bridge = createBncrBridge(createApiStub());
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-large-dead-state-'));
  try {
    const persistedSessionKey = 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031';
    const deadLetter = Array.from({ length: 1005 }, (_, i) => {
      const entry = makeEntry(`persisted-dead-${i}`, `dead ${i}`);
      entry.sessionKey = persistedSessionKey;
      entry.payload.sessionKey = persistedSessionKey;
      return entry;
    });
    const state = {
      outbox: [],
      deadLetter,
      sessionRoutes: [],
    };
    await fs.writeFile(
      path.join(stateDir, 'bncr-bridge-state.json'),
      JSON.stringify(state),
      'utf8',
    );

    await bridge.startService({ stateDir }, false);

    assert.equal(bridge.deadLetter.length, 1000);
    assert.equal(bridge.deadLetter[0].messageId, 'persisted-dead-5');
    assert.equal(bridge.deadLetter.at(-1).messageId, 'persisted-dead-1004');
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('startService skips malformed persisted entries without blocking valid state', async () => {
  const bridge = createBncrBridge(createApiStub());
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-dirty-state-'));
  try {
    const nowTs = Date.now();
    const persistedSessionKey = 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031';
    const goodOutbox = makeEntry('persisted-good-outbox', 'good outbox');
    goodOutbox.sessionKey = persistedSessionKey;
    goodOutbox.payload.sessionKey = persistedSessionKey;
    goodOutbox.createdAt = String(nowTs - 10_000);
    goodOutbox.nextAttemptAt = String(nowTs - 5_000);
    goodOutbox.retryCount = '2';
    goodOutbox.lastAttemptAt = 'not-a-number';
    const goodDeadLetter = makeEntry('persisted-good-dead', 'good dead');
    goodDeadLetter.sessionKey = persistedSessionKey;
    goodDeadLetter.payload.sessionKey = persistedSessionKey;
    goodDeadLetter.createdAt = 'not-a-number';
    goodDeadLetter.nextAttemptAt = 'not-a-number';
    goodDeadLetter.retryCount = 'not-a-number';
    goodDeadLetter.lastAttemptAt = 'not-a-number';
    const state = {
      outbox: [
        null,
        {},
        { messageId: 'bad-missing-session', accountId: 'Primary' },
        { ...goodOutbox, route: { malformed: true } },
      ],
      deadLetter: [{ messageId: 'bad-dead-missing-session', accountId: 'Primary' }, goodDeadLetter],
      sessionRoutes: [
        null,
        { sessionKey: 'bad-session-key', accountId: 'Primary', route: {}, updatedAt: nowTs },
        {
          sessionKey: persistedSessionKey,
          accountId: 'Primary',
          route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
          updatedAt: 'not-a-number',
        },
      ],
      lastSessionByAccount: [
        { accountId: 'Primary', sessionKey: 'bad-session-key', scope: 'bad', updatedAt: nowTs },
        {
          accountId: 'Primary',
          sessionKey: persistedSessionKey,
          scope: 'ignored-stored-scope',
          updatedAt: String(nowTs),
        },
      ],
      lastActivityByAccount: [
        { accountId: 'Primary', updatedAt: 'not-a-number' },
        { accountId: 'Primary', updatedAt: String(nowTs - 1_000) },
      ],
      lastInboundByAccount: [
        { accountId: 'Primary', updatedAt: 0 },
        { accountId: 'Primary', updatedAt: String(nowTs - 2_000) },
      ],
      lastOutboundByAccount: [
        { accountId: 'Primary', updatedAt: -1 },
        { accountId: 'Primary', updatedAt: String(nowTs - 3_000) },
      ],
      lastDriftSnapshot: {
        capturedAt: 'not-a-number',
        registerCount: 'not-a-number',
        apiGeneration: '2',
        postWarmupRegisterCount: '3',
        apiInstanceId: 'api-1',
        registryFingerprint: 'fingerprint-1',
        dominantBucket: 'bucket-1',
        sourceBuckets: { 'bucket-1': 1 },
        traceWindowSize: 'not-a-number',
        traceRecent: [{ source: 'test' }],
      },
    };
    await fs.writeFile(
      path.join(stateDir, 'bncr-bridge-state.json'),
      JSON.stringify(state),
      'utf8',
    );

    await bridge.startService({ stateDir }, false);

    assert.deepEqual(Array.from(bridge.outbox.keys()), ['persisted-good-outbox']);
    const loadedOutbox = bridge.outbox.get('persisted-good-outbox');
    assert.equal(loadedOutbox.retryCount, 2);
    assert.equal(loadedOutbox.createdAt, nowTs - 10_000);
    assert.equal(loadedOutbox.nextAttemptAt, nowTs - 5_000);
    assert.equal(loadedOutbox.lastAttemptAt, undefined);
    assert.deepEqual(loadedOutbox.route, {
      platform: 'tgBot',
      groupId: '-1001',
      userId: '10001',
    });
    assert.deepEqual(
      bridge.deadLetter.map((entry) => entry.messageId),
      ['persisted-good-dead'],
    );
    assert.equal(Number.isFinite(bridge.deadLetter[0].createdAt), true);
    assert.equal(bridge.deadLetter[0].retryCount, 0);
    assert.equal(Number.isFinite(bridge.deadLetter[0].nextAttemptAt), true);
    assert.equal(bridge.deadLetter[0].lastAttemptAt, undefined);
    assert.equal(bridge.sessionRoutes.size, 1);
    assert.equal(Number.isFinite(Array.from(bridge.sessionRoutes.values())[0].updatedAt), true);
    assert.equal(bridge.lastSessionByAccount.get('Primary')?.scope, 'Bncr:tgBot:-1001:10001');
    assert.equal(bridge.lastActivityByAccount.get('Primary'), nowTs - 1_000);
    assert.equal(bridge.lastInboundByAccount.get('Primary'), nowTs - 2_000);
    assert.equal(bridge.lastOutboundByAccount.get('Primary'), nowTs - 3_000);
    const diagnostics = bridge.buildExtendedDiagnostics('Primary');
    assert.equal(diagnostics.register.lastDriftSnapshot.capturedAt, 0);
    assert.equal(diagnostics.register.lastDriftSnapshot.registerCount, null);
    assert.equal(diagnostics.register.lastDriftSnapshot.apiGeneration, 2);
    assert.equal(diagnostics.register.lastDriftSnapshot.postWarmupRegisterCount, 3);
    assert.equal(diagnostics.register.lastDriftSnapshot.traceWindowSize, 0);
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('flushPushQueue yields after per-account time budget instead of monopolizing the drain', async () => {
  const bridge = createBncrBridge(createApiStub());
  const originalNow = Date.now;
  let fakeNow = originalNow() + 3_000_000;
  Date.now = () => fakeNow;
  const pushed = [];
  const scheduled = [];

  try {
    for (let i = 1; i <= 3; i++) {
      const entry = makeEntry(`msg-time-budget-${i}`, `time budget ${i}`);
      entry.createdAt = fakeNow + i;
      entry.nextAttemptAt = fakeNow - 1_000;
      bridge.outbox.set(entry.messageId, entry);
    }

    bridge.tryPushEntry = async (entry) => {
      pushed.push(entry.messageId);
      bridge.outbox.delete(entry.messageId);
      fakeNow += 2_500;
      return true;
    };
    bridge.sleepMs = async () => {};
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => false;

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'time-budget-yield',
    });

    assert.deepEqual(pushed, ['msg-time-budget-1']);
    assert.equal(bridge.outbox.size, 2);
    assert.equal(bridge.outbox.has('msg-time-budget-2'), true);
    assert.equal(bridge.outbox.has('msg-time-budget-3'), true);
    assert.deepEqual(scheduled, [0]);
  } finally {
    Date.now = originalNow;
    cleanupBridge(bridge);
  }
});

async function assertResolvesWithin(promise, ms, label) {
  await Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not resolve`)), ms)),
  ]);
}

function createAccountStatusCtx(accountId = 'Primary') {
  let status = {};
  return {
    accountId,
    getStatus() {
      return status;
    },
    setStatus(next) {
      status = next;
    },
  };
}

function createCountingAbortSignal() {
  const listeners = new Set();
  return {
    signal: {
      aborted: false,
      addEventListener(event, listener) {
        if (event === 'abort') listeners.add(listener);
      },
      removeEventListener(event, listener) {
        if (event === 'abort') listeners.delete(listener);
      },
    },
    listenerCount() {
      return listeners.size;
    },
    abort() {
      this.signal.aborted = true;
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

test('channelStopAccount removes status worker abort listener during cleanup', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const abort = createCountingAbortSignal();
    const ctx = {
      ...createAccountStatusCtx('Primary'),
      abortSignal: abort.signal,
    };
    const started = bridge.channelStartAccount(ctx);
    assert.equal(abort.listenerCount(), 1);

    await bridge.channelStopAccount(ctx);

    assert.equal(abort.listenerCount(), 0);
    abort.abort();
    assert.equal(abort.listenerCount(), 0);
    await assertResolvesWithin(started, 50, 'channelStartAccount after abort listener cleanup');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channelStopAccount resolves a running status worker instead of only clearing its interval', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const ctx = createAccountStatusCtx('Primary');
    const started = bridge.channelStartAccount(ctx);
    assert.equal(bridge.channelAccountWorkers.size, 1);

    await bridge.channelStopAccount(ctx);

    assert.equal(bridge.channelAccountWorkers.size, 0);
    await assertResolvesWithin(started, 50, 'channelStartAccount after channelStopAccount');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channelStartAccount start-replace resolves the previous status worker', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const firstCtx = createAccountStatusCtx('Primary');
    const firstStarted = bridge.channelStartAccount(firstCtx);
    assert.equal(bridge.channelAccountWorkers.size, 1);

    const secondCtx = createAccountStatusCtx('Primary');
    const secondStarted = bridge.channelStartAccount(secondCtx);

    await assertResolvesWithin(
      firstStarted,
      50,
      'previous channelStartAccount after start-replace',
    );
    assert.equal(bridge.channelAccountWorkers.size, 1);

    await bridge.channelStopAccount(secondCtx);
    await assertResolvesWithin(secondStarted, 50, 'replacement channelStartAccount after stop');
    assert.equal(bridge.channelAccountWorkers.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('stopService clears and resolves running status workers', async () => {
  const bridge = createBncrBridge(createApiStub());
  try {
    const ctx = createAccountStatusCtx('Primary');
    const started = bridge.channelStartAccount(ctx);
    assert.equal(bridge.channelAccountWorkers.size, 1);

    await bridge.stopService();

    assert.equal(bridge.channelAccountWorkers.size, 0);
    await assertResolvesWithin(started, 50, 'channelStartAccount after stopService');
  } finally {
    cleanupBridge(bridge);
  }
});

test('log dedupe state prunes expired and oversized keys', () => {
  const bridge = createBncrBridge(createApiStub());
  const originalNow = Date.now;
  const fakeNow = originalNow() + 10_000_000;
  Date.now = () => fakeNow;

  try {
    bridge.logDedupeState.set('expired', { at: fakeNow - 700_000, sig: 'old' });
    for (let i = 0; i < 1_005; i += 1) {
      bridge.logDedupeState.set(`key-${i}`, { at: fakeNow - 1_000 + i, sig: `sig-${i}` });
    }

    const emitted = bridge.shouldEmitDedupLog('fresh', 'sig-fresh');

    assert.equal(emitted, true);
    assert.equal(bridge.logDedupeState.has('expired'), false);
    assert.equal(bridge.logDedupeState.has('fresh'), true);
    assert.ok(bridge.logDedupeState.size <= 1000);
  } finally {
    Date.now = originalNow;
    cleanupBridge(bridge);
  }
});
