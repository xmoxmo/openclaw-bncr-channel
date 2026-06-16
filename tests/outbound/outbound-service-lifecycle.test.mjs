import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

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

test('startService reopens runtime scheduling after stopService cleanup', async () => {
  const bridge = createBridge();
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

test('channelStopAccount removes status worker abort listener during cleanup', async () => {
  const bridge = createBridge();
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
  const bridge = createBridge();
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
  const bridge = createBridge();
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
  const bridge = createBridge();
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
  const bridge = createBridge();
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
