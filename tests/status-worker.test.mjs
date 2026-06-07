import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHealthStatusLogState,
  startBncrStatusWorker,
  stopBncrStatusWorker,
  updateHealthStatusLogState,
} from '../src/runtime/status-worker.ts';

test('health status log state emits only after a signature remains stable', () => {
  const state = createHealthStatusLogState();

  assert.equal(
    updateHealthStatusLogState({ state, sig: 'offline', nowMs: 0, stableWindowMs: 10_000 }),
    'pending',
  );
  assert.equal(
    updateHealthStatusLogState({ state, sig: 'online', nowMs: 5_000, stableWindowMs: 10_000 }),
    'pending',
  );
  assert.equal(
    updateHealthStatusLogState({ state, sig: 'offline', nowMs: 9_000, stableWindowMs: 10_000 }),
    'pending',
  );
  assert.equal(
    updateHealthStatusLogState({ state, sig: 'offline', nowMs: 18_999, stableWindowMs: 10_000 }),
    'pending',
  );
  assert.equal(
    updateHealthStatusLogState({ state, sig: 'offline', nowMs: 19_000, stableWindowMs: 10_000 }),
    'stable',
  );
  assert.equal(
    updateHealthStatusLogState({ state, sig: 'offline', nowMs: 30_000, stableWindowMs: 10_000 }),
    'unchanged',
  );
});

test('health status log state can emit immediately when stable window is disabled', () => {
  const state = createHealthStatusLogState();

  assert.equal(
    updateHealthStatusLogState({ state, sig: 'online', nowMs: 0, stableWindowMs: 0 }),
    'stable',
  );
  assert.equal(
    updateHealthStatusLogState({ state, sig: 'online', nowMs: 1, stableWindowMs: 0 }),
    'unchanged',
  );
});

test('health status log state falls back to default window for invalid stable window', () => {
  const state = createHealthStatusLogState();

  assert.equal(
    updateHealthStatusLogState({ state, sig: 'online', nowMs: 0, stableWindowMs: Number.NaN }),
    'pending',
  );
  assert.equal(
    updateHealthStatusLogState({ state, sig: 'online', nowMs: 9_999, stableWindowMs: Number.NaN }),
    'pending',
  );
  assert.equal(
    updateHealthStatusLogState({
      state,
      sig: 'online',
      nowMs: 10_000,
      stableWindowMs: Number.NaN,
    }),
    'stable',
  );
});

test('status worker delays non-debug health summary until stable window passes', async () => {
  const workers = new Map();
  const logs = [];
  let nowMs = 0;
  let online = false;
  let status = {};
  const runtime = {
    workers,
    bridgeId: 'bridge-test',
    hooks: {
      isOnline: () => online,
      hasRecentInboundReachability: () => false,
      getLastActivityAt: () => null,
      getActiveConnectionKey: () => (online ? 'Primary:conn-1' : null),
      getActiveConnections: () => (online ? [{ connId: 'conn-1' }] : []),
      buildStatusMeta: () => ({}),
      logInfo: (scope, message, options) => {
        logs.push({ scope, message, debugOnly: options?.debugOnly === true });
      },
      logInfoDedup: (scope, message, options) => {
        logs.push({ scope, message, debugOnly: options?.debugOnly === true, sig: options.sig });
      },
      now: () => nowMs,
      healthStableWindowMs: 20,
    },
  };
  const abort = new AbortController();
  const done = startBncrStatusWorker(runtime, {
    accountId: 'Primary',
    getStatus: () => status,
    setStatus: (next) => {
      status = next;
    },
    abortSignal: abort.signal,
  });

  try {
    const worker = workers.get('Primary');
    assert.ok(worker, 'worker should be registered after start');
    assert.equal(
      logs.some((log) => log.message.includes('status-tick Primary|stable|')),
      false,
    );

    nowMs = 10;
    online = true;
    worker.finish = worker.finish.bind(worker);
    // Run the captured interval callback directly through the worker timer's private _onTimeout
    // hook to avoid slow real-time sleeps in this wiring test.
    worker.timer._onTimeout();
    assert.equal(
      logs.some((log) => log.message.includes('status-tick Primary|stable|')),
      false,
    );

    nowMs = 30;
    worker.timer._onTimeout();
    assert.equal(
      logs.some((log) => log.message.includes('status-tick Primary|stable|linked')),
      true,
    );
  } finally {
    await stopBncrStatusWorker(runtime, { accountId: 'Primary' });
    abort.abort();
    await done;
  }
});
