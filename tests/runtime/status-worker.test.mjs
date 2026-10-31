import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHealthStatusLogState,
  startBncrStatusWorker,
  stopBncrStatusWorker,
  updateHealthStatusLogState,
} from '../../src/runtime/status-worker.ts';

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
    assert.equal(status.lifecycle, 'ready');
  } finally {
    await stopBncrStatusWorker(runtime, { accountId: 'Primary' });
    abort.abort();
    await done;
  }
});

test('status worker publishes ready on connect and stopped on stop', async () => {
  const workers = new Map();
  let status = {};
  const online = true;
  const runtime = {
    workers,
    bridgeId: 'bridge-lifecycle',
    hooks: {
      isOnline: () => online,
      hasRecentInboundReachability: () => false,
      getLastActivityAt: () => null,
      getActiveConnectionKey: () => (online ? 'Primary:conn-1' : null),
      getActiveConnections: () => (online ? [{ connId: 'conn-1' }] : []),
      buildStatusMeta: () => ({}),
      logInfo: () => {},
      logInfoDedup: () => {},
      now: () => 0,
      healthStableWindowMs: 0,
    },
  };
  const abort = new AbortController();
  const ctx = {
    accountId: 'Primary',
    getStatus: () => status,
    setStatus: (next) => {
      status = next;
    },
    abortSignal: abort.signal,
  };
  const done = startBncrStatusWorker(runtime, ctx);
  try {
    const worker = workers.get('Primary');
    assert.ok(worker, 'worker should be registered after start');
    assert.equal(status.lifecycle, 'ready');

    // 模拟 10.8 host 在 getStatus 里回灌 starting，worker 必须把它纠正回 ready。
    status = { ...status, lifecycle: 'starting' };
    worker.timer._onTimeout();
    assert.equal(status.lifecycle, 'ready');
  } finally {
    await stopBncrStatusWorker(runtime, ctx);
    abort.abort();
    await done;
  }
  assert.equal(status.lifecycle, 'stopped');
});
