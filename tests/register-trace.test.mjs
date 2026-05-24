import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRegisterTraceSummary } from '../src/core/register-trace.ts';

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
