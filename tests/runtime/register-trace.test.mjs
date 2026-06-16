import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendBoundedRegisterTrace,
  buildRegisterDriftSnapshot,
  buildRegisterTraceEntry,
  buildRegisterTraceSummary,
  dumpRegisterDriftSnapshot,
  normalizeRegisterDriftSnapshot,
} from '../../src/core/register-trace.ts';

function trace(ts, bucket = 'gateway/startup') {
  return {
    ts,
    bridgeId: 'bridge-1',
    gatewayPid: 123,
    registerCount: 1,
    apiGeneration: 1,
    apiRebound: false,
    apiInstanceId: 'api-1',
    registryFingerprint: 'fingerprint-1',
    source: 'test',
    pluginVersion: '0.2.5',
    stack: 'stack',
    stackBucket: bucket,
  };
}

test('buildRegisterTraceSummary falls back to default warmup window for invalid input', () => {
  const firstRegisterAt = 1_000;
  const summary = buildRegisterTraceSummary({
    firstRegisterAt,
    warmupWindowMs: Number.POSITIVE_INFINITY,
    traceRecent: [trace(firstRegisterAt + 20_000), trace(firstRegisterAt + 40_000)],
  });

  assert.equal(summary.startupWindowMs, 30_000);
  assert.equal(summary.warmupRegisterCount, 1);
  assert.equal(summary.postWarmupRegisterCount, 1);
  assert.equal(summary.likelyRuntimeRegistryDrift, true);
});

test('buildRegisterTraceEntry classifies stack buckets without mutating runtime state', () => {
  const entry = buildRegisterTraceEntry({
    ts: 2_000,
    bridgeId: 'bridge-2',
    gatewayPid: 456,
    registerCount: 2,
    apiGeneration: 2,
    apiRebound: true,
    apiInstanceId: 'api-2',
    registryFingerprint: 'fingerprint-2',
    source: 'runtime',
    pluginVersion: '0.2.7',
    stack: 'at prepareSecretsRuntimeSnapshot <- at test',
  });

  assert.equal(entry.stackBucket, 'runtime/webtools');
  assert.equal(entry.apiRebound, true);
  assert.equal(entry.bridgeId, 'bridge-2');
});

test('appendBoundedRegisterTrace keeps only the newest bounded entries', () => {
  const entries = [trace(1_000), trace(2_000), trace(3_000)];
  appendBoundedRegisterTrace(entries, trace(4_000), 2);

  assert.deepEqual(
    entries.map((entry) => entry.ts),
    [3_000, 4_000],
  );
});

test('buildRegisterDriftSnapshot copies summary buckets and trace entries', () => {
  const firstRegisterAt = 1_000;
  const traceRecent = [trace(firstRegisterAt + 40_000, 'runtime/webtools')];
  const summary = buildRegisterTraceSummary({ firstRegisterAt, traceRecent });
  const snapshot = buildRegisterDriftSnapshot({
    capturedAt: 50_000,
    registerCount: 3,
    apiGeneration: 2,
    summary,
    apiInstanceId: 'api-3',
    registryFingerprint: 'fingerprint-3',
    traceRecent,
  });

  summary.sourceBuckets['runtime/webtools'] = 99;
  traceRecent[0].source = 'mutated';

  assert.equal(snapshot.postWarmupRegisterCount, 1);
  assert.equal(snapshot.sourceBuckets['runtime/webtools'], 1);
  assert.equal(snapshot.traceRecent[0].source, 'test');
});

test('normalizeRegisterDriftSnapshot sanitizes persisted diagnostic snapshot', () => {
  const snapshot = normalizeRegisterDriftSnapshot({
    capturedAt: 'bad',
    registerCount: 'bad',
    apiGeneration: '2',
    postWarmupRegisterCount: '3',
    apiInstanceId: ' api-1 ',
    registryFingerprint: '',
    dominantBucket: ' runtime/webtools ',
    sourceBuckets: { 'runtime/webtools': 1 },
    traceWindowSize: 'bad',
    traceRecent: [{ source: 'test' }],
  });

  assert.deepEqual(snapshot, {
    capturedAt: 0,
    registerCount: null,
    apiGeneration: 2,
    postWarmupRegisterCount: 3,
    apiInstanceId: 'api-1',
    registryFingerprint: null,
    dominantBucket: 'runtime/webtools',
    sourceBuckets: { 'runtime/webtools': 1 },
    traceWindowSize: 0,
    traceRecent: [{ source: 'test' }],
  });
  assert.equal(normalizeRegisterDriftSnapshot(null), null);
});

test('dumpRegisterDriftSnapshot copies nested diagnostic fields', () => {
  const snapshot = normalizeRegisterDriftSnapshot({
    capturedAt: 10,
    registerCount: 2,
    apiGeneration: 1,
    postWarmupRegisterCount: 1,
    sourceBuckets: { a: 1 },
    traceRecent: [{ source: 'test' }],
  });

  const dumped = dumpRegisterDriftSnapshot(snapshot);
  assert.deepEqual(dumped, snapshot);
  dumped.sourceBuckets.a = 99;
  dumped.traceRecent[0].source = 'mutated';

  assert.equal(snapshot.sourceBuckets.a, 1);
  assert.equal(snapshot.traceRecent[0].source, 'test');
  assert.equal(dumpRegisterDriftSnapshot(null), null);
});

test('noteRegisterTraceRuntime advances counters and captures drift snapshot after warmup', async () => {
  const { noteRegisterTraceRuntime } = await import('../../src/runtime/register-trace-runtime.ts');
  const state = {
    registerCount: 0,
    apiGeneration: 0,
    firstRegisterAt: null,
    lastRegisterAt: null,
    lastApiRebindAt: null,
    pluginSource: null,
    pluginVersion: null,
    lastApiInstanceId: null,
    lastRegistryFingerprint: null,
    lastDriftSnapshot: null,
    registerTraceRecent: [],
  };

  const first = noteRegisterTraceRuntime({
    state,
    meta: {
      source: 'startup',
      pluginVersion: '0.3.4',
      apiInstanceId: 'api-1',
      registryFingerprint: 'fingerprint-1',
    },
    ts: 1_000,
    stack: 'at startGatewayServer',
    bridgeId: 'bridge-1',
    gatewayPid: 123,
    warmupWindowMs: 30_000,
  });

  assert.equal(first.capturedDriftSnapshot, false);
  assert.equal(state.registerCount, 1);
  assert.equal(state.apiGeneration, 1);
  assert.equal(state.firstRegisterAt, 1_000);
  assert.equal(state.lastDriftSnapshot, null);

  const second = noteRegisterTraceRuntime({
    state,
    meta: {
      apiRebound: true,
      apiInstanceId: 'api-2',
      registryFingerprint: 'fingerprint-2',
    },
    ts: 40_000,
    stack: 'at prepareSecretsRuntimeSnapshot',
    bridgeId: 'bridge-1',
    gatewayPid: 123,
    warmupWindowMs: 30_000,
  });

  assert.equal(second.capturedDriftSnapshot, true);
  assert.equal(state.registerCount, 2);
  assert.equal(state.apiGeneration, 2);
  assert.equal(state.lastApiRebindAt, 40_000);
  assert.equal(state.pluginSource, 'startup');
  assert.equal(state.lastApiInstanceId, 'api-2');
  assert.equal(state.lastRegistryFingerprint, 'fingerprint-2');
  assert.equal(state.lastDriftSnapshot?.postWarmupRegisterCount, 1);
  assert.equal(state.lastDriftSnapshot?.apiInstanceId, 'api-2');
});
