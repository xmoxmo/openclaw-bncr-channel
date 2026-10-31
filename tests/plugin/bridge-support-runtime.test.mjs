import assert from 'node:assert/strict';
import test from 'node:test';

import { createBridgeSupportRuntime } from '../../src/plugin/bridge-support-runtime.ts';

function createRuntime(overrides = {}) {
  const calls = { warn: [], cache: [] };
  let cached = null;
  const runtime = createBridgeSupportRuntime({
    isStopped: () => false,
    hasSaveTimer: () => false,
    setSaveTimer: () => {},
    flushState: async () => {},
    normalizeAccountId: (value) => value || 'Primary',
    getCounterValue: (map, key) => map.get(key) || 0,
    getRuntimeConfig: () => ({}),
    channelId: 'bncr',
    readCurrentCanonicalAgentId: () => cached,
    resolveAgentRoute: () => null,
    readCachedCanonicalAgentId: () => cached,
    writeCachedCanonicalAgentId: (value) => {
      cached = value;
      calls.cache.push(value);
    },
    logInfo: () => {},
    logWarn: (scope, message, options) => calls.warn.push({ scope, message, options }),
    readDebugVerbose: () => false,
    writeDebugVerbose: () => {},
    ...overrides,
  });
  return { runtime, calls, readCache: () => cached };
}

const resolveArgs = { cfg: {}, accountId: 'Primary', channelId: 'bncr' };

test('ensureCanonicalAgentId keeps the bound agent when a binding resolves', () => {
  const { runtime, calls, readCache } = createRuntime({
    resolveAgentRoute: () => ({ agentId: 'orion' }),
  });

  assert.equal(runtime.ensureCanonicalAgentId(resolveArgs), 'orion');
  assert.equal(readCache(), 'orion');
  assert.deepEqual(calls.warn, []);
});

test('ensureCanonicalAgentId falls back to the host default agent and says so visibly', () => {
  const { runtime, calls, readCache } = createRuntime();

  assert.equal(runtime.ensureCanonicalAgentId(resolveArgs), 'main');
  assert.equal(readCache(), 'main');
  assert.equal(calls.warn.length, 1);
  assert.equal(calls.warn[0].scope, 'target');
  assert.match(calls.warn[0].message, /no binding matched channel bncr/);
  assert.match(calls.warn[0].message, /running as main until restart/);
  // The operator has to see this without turning on debug logging.
  assert.equal(calls.warn[0].options, undefined);
});

test('ensureCanonicalAgentId caches the fallback so later calls stay quiet', () => {
  const { runtime, calls } = createRuntime();

  runtime.ensureCanonicalAgentId(resolveArgs);
  runtime.ensureCanonicalAgentId(resolveArgs);

  assert.equal(calls.warn.length, 1);
  assert.deepEqual(calls.cache, ['main']);
});
