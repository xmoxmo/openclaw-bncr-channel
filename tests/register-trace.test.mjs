import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendBoundedRegisterTrace,
  buildRegisterDriftSnapshot,
  buildRegisterTraceEntry,
  buildRegisterTraceSummary,
} from '../src/core/register-trace.ts';

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
