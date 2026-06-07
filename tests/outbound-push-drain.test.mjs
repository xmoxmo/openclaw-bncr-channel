import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from './helpers/bncr-bridge.mjs';
import { withConsoleCapture } from './helpers/console-capture.mjs';

test('schedulePushDrain does not register a second timer while one is already pending', async () => {
  const bridge = createBridge();
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
  const bridge = createBridge();
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
  const bridge = createBridge();
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
  const bridge = createBridge();
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
  const bridge = createBridge();
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
  const bridge = createBridge();
  const pushed = [];
  let nestedReturned = false;

  try {
    await withConsoleCapture(['log', 'warn'], async ({ log: logs, warn: warnings }) => {
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
    });
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue emits non-debug drain stuck summary after long-running account drain', async () => {
  const bridge = createBridge();

  try {
    await withConsoleCapture(['log', 'warn'], async ({ log: logs, warn: warnings }) => {
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
    });
  } finally {
    bridge.pushDrainRunningAccounts.delete('Primary');
    bridge.pushDrainRunningSinceByAccount.delete('Primary');
    bridge.pushDrainStuckWarnedAtByAccount.delete('Primary');
    cleanupBridge(bridge);
  }
});

test('flushPushQueue yields after per-account budget instead of draining unbounded entries', async () => {
  const bridge = createBridge();
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
  const bridge = createBridge();
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
  const bridge = createBridge();
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
  const bridge = createBridge();
  const scheduled = [];

  try {
    await withConsoleCapture('error', async ({ error: errors }) => {
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
      bridge.flushPushQueueBestEffort({
        accountId: 'Primary',
        trigger: 'test',
        reason: 'recovered',
      });
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
    });
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue logs non-debug push skip summary when text push guard rejects', async () => {
  const bridge = createBridge();
  const scheduled = [];
  let saveCount = 0;
  const before = Date.now();

  try {
    await withConsoleCapture('log', async ({ log: logs }) => {
      const entry = makeEntry(
        'msg-push-skip-no-active-connection',
        'push skip no active connection',
      );
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
      assert.equal(updated.retryCount, 0);
      assert.equal(updated.lastError, 'gateway context unavailable');
      assert.ok(saveCount >= 1, 'guard reason should be persisted');
      assert.deepEqual(scheduled, [1_000]);
    });
  } finally {
    cleanupBridge(bridge);
  }
});

test('pre-push guard skip does not consume retry budget or dead-letter queued entry', async () => {
  const bridge = createBridge();
  const scheduled = [];
  const before = Date.now();

  try {
    const entry = makeEntry('msg-push-skip-retry-budget', 'push skip retry budget');
    entry.retryCount = 10;
    entry.nextAttemptAt = before - 1_000;
    bridge.outbox.set(entry.messageId, entry);

    bridge.gatewayContext = null;
    bridge.sleepMs = async () => {};
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'pre-push-guard-retry-budget',
    });

    const updated = bridge.outbox.get(entry.messageId);
    assert.ok(updated, 'pre-push guard skip should keep entry queued');
    assert.equal(updated.retryCount, 10);
    assert.equal(updated.lastError, 'gateway context unavailable');
    assert.equal(bridge.deadLetter.length, 0);
    assert.deepEqual(scheduled, [1_000]);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue converts tryPushEntry exceptions into retryable push failure', async () => {
  const bridge = createBridge();
  const scheduled = [];
  let saveCount = 0;
  const before = Date.now();

  try {
    await withConsoleCapture('log', async ({ log: logs }) => {
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
    });
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue schedules retry after push failure without dead-lettering', async () => {
  const bridge = createBridge();
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
  const bridge = createBridge();
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
  const bridge = createBridge();
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
