import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_BNCR_MEDIA_MAX_MB } from '../../src/core/config-schema.ts';
import {
  fallbackBncrMediaMaxBytes,
  resolveBncrMediaMaxBytes,
} from '../../src/openclaw/media-limit-runtime.ts';

function apiWithConfig(cfg) {
  return { runtime: { config: { current: () => cfg } } };
}

test('Bncr media limit defaults to 2 GiB when no configuration is available', () => {
  assert.equal(DEFAULT_BNCR_MEDIA_MAX_MB, 2048);
  assert.equal(fallbackBncrMediaMaxBytes(), 2048 * 1024 * 1024);
  assert.equal(resolveBncrMediaMaxBytes({}, 'Primary'), fallbackBncrMediaMaxBytes());
});

test('Bncr media limit uses the channel configuration as the single authority', () => {
  const api = apiWithConfig({ channels: { bncr: { mediaMaxMb: 3072 } } });
  assert.equal(resolveBncrMediaMaxBytes(api, 'Primary'), 3072 * 1024 * 1024);
});

test('Bncr media limit supports an explicit per-account override', () => {
  const api = apiWithConfig({
    channels: { bncr: { mediaMaxMb: 2048, accounts: { Primary: { mediaMaxMb: 1024 } } } },
  });
  assert.equal(resolveBncrMediaMaxBytes(api, 'Primary'), 1024 * 1024 * 1024);
});

test('Bncr media limit falls back to the OpenClaw agent default when channel config is absent', () => {
  const api = apiWithConfig({ channels: { bncr: {} }, agents: { defaults: { mediaMaxMb: 64 } } });
  assert.equal(resolveBncrMediaMaxBytes(api, 'Primary'), 64 * 1024 * 1024);
});

test('Bncr media limit keeps account overrides when the host lowercases the account id', () => {
  // The host normalizes account ids to lowercase before invoking resolveChannelLimitMb, while
  // Bncr stores its account keys verbatim (e.g. "Primary"). The account override must still win.
  const api = apiWithConfig({
    channels: { bncr: { mediaMaxMb: 2048, accounts: { Primary: { mediaMaxMb: 1024 } } } },
  });
  assert.equal(resolveBncrMediaMaxBytes(api, 'Primary'), 1024 * 1024 * 1024);
  assert.equal(resolveBncrMediaMaxBytes(api, 'primary'), 1024 * 1024 * 1024);
});

test('Bncr media limit applies account overrides for non-default accounts', () => {
  const api = apiWithConfig({
    channels: {
      bncr: { mediaMaxMb: 2048, accounts: { Primary: {}, Secondary: { mediaMaxMb: 512 } } },
    },
  });
  assert.equal(resolveBncrMediaMaxBytes(api, 'Secondary'), 512 * 1024 * 1024);
  assert.equal(resolveBncrMediaMaxBytes(api, 'secondary'), 512 * 1024 * 1024);
});

test('Bncr media limit treats malformed account entries as absent instead of throwing', () => {
  for (const account of [null, 'x', 7, true]) {
    const api = apiWithConfig({ channels: { bncr: { accounts: { Primary: account } } } });
    assert.equal(resolveBncrMediaMaxBytes(api, 'Primary'), fallbackBncrMediaMaxBytes());
  }
});

test('Bncr media limit survives a null or undefined runtime config without throwing', () => {
  for (const cfg of [null, undefined]) {
    const api = { runtime: { config: { current: () => cfg } } };
    assert.equal(resolveBncrMediaMaxBytes(api, 'Primary'), fallbackBncrMediaMaxBytes());
  }
  const nullChannel = { runtime: { config: { current: () => ({ channels: { bncr: null } }) } } };
  assert.equal(resolveBncrMediaMaxBytes(nullChannel, 'Primary'), fallbackBncrMediaMaxBytes());
});
