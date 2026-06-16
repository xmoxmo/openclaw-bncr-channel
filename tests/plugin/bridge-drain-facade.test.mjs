import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridgeDrainFacade } from '../../src/plugin/bridge-drain-facade.ts';

test('bridge drain facade coalesces timer scheduling and retries flush failures', async () => {
  const timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _delay) => {
    const timer = { fn };
    timers.push(timer);
    return timer;
  };

  try {
    const calls = { info: [], error: [], flush: [] };
    let pushTimer = null;
    let retryCount = 0;
    let failOnce = true;
    const facade = createBncrBridgeDrainFacade({
      bridgeId: 'bridge-1',
      asString: (value, fallback = '') =>
        typeof value === 'string' ? value : value == null ? fallback : String(value),
      normalizeAccountId: (accountId) => String(accountId || '').trim(),
      getApi: () => ({ ok: true }),
      getStopped: () => false,
      getPushTimer: () => pushTimer,
      setPushTimer: (timer) => {
        pushTimer = timer;
      },
      getRetryCount: () => retryCount,
      setRetryCount: (count) => {
        retryCount = count;
      },
      logInfo: (...args) => calls.info.push(args),
      logError: (...args) => calls.error.push(args),
      async flushPushQueue(args) {
        calls.flush.push(args);
        if (failOnce) {
          failOnce = false;
          throw new Error('temporary network timeout');
        }
      },
      schedulePushDrain(delayMs = 0) {
        facade.schedulePushDrain(delayMs);
      },
      resolveOutboundAckRequired: ({ api, accountId }) => Boolean(api) && accountId === 'a1',
      retryLimit: 3,
      retryDelayMs: 250,
    });

    facade.schedulePushDrain(5);
    facade.schedulePushDrain(50);
    assert.equal(timers.length, 1);
    assert.equal(calls.info.length, 1);

    timers.shift().fn();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.flush.length, 1);
    assert.equal(retryCount, 1);
    assert.equal(calls.error.length, 1);
    assert.equal(timers.length, 1);

    timers.shift().fn();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.flush.length, 2);
    assert.equal(retryCount, 0);
    assert.equal(facade.isOutboundAckRequired('a1'), true);
    assert.equal(facade.isOutboundAckRequired('a2'), false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
