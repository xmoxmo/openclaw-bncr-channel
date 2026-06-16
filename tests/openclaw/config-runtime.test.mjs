import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getOpenClawRuntimeConfig,
  getOpenClawRuntimeConfigOrDefault,
} from '../../src/openclaw/config-runtime.ts';

test('getOpenClawRuntimeConfig prefers current()', () => {
  const cfg = getOpenClawRuntimeConfig({
    runtime: {
      config: {
        current: () => ({ from: 'current' }),
        get: () => ({ from: 'get' }),
      },
    },
  });

  assert.deepEqual(cfg, { from: 'current' });
});

test('getOpenClawRuntimeConfig falls back to get()', () => {
  const cfg = getOpenClawRuntimeConfig({
    runtime: {
      config: {
        get: () => ({ from: 'get' }),
      },
    },
  });

  assert.deepEqual(cfg, { from: 'get' });
});

test('getOpenClawRuntimeConfig throws when no readable runtime config api exists', () => {
  assert.throws(
    () => getOpenClawRuntimeConfig({ runtime: { config: {} } }),
    /runtime config read API/,
  );
});

test('getOpenClawRuntimeConfigOrDefault returns fallback when runtime config is unavailable', () => {
  const fallback = { fallback: true };
  assert.deepEqual(getOpenClawRuntimeConfigOrDefault({}, fallback), fallback);
});
