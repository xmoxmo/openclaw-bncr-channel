import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from '../helpers/bncr-bridge.mjs';

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
