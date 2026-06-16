import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrStatusSurface } from '../../src/plugin/status.ts';

function createBridge(overrides = {}) {
  return {
    getChannelSummary(defaultAccountId) {
      return { defaultAccountId };
    },
    getAccountRuntimeSnapshot(accountId) {
      return {
        connected: false,
        running: true,
        pending: 0,
        deadLetter: 0,
        diagnostics: { accountId },
      };
    },
    getStatusHeadline() {
      return 'configured';
    },
    ...overrides,
  };
}

test('status surface resolves disabled/not configured/configured/linked account states', () => {
  const status = createBncrStatusSurface(() => createBridge());
  const cfg = { accounts: [{ id: 'Primary', enable: true }] };

  assert.equal(
    status.resolveAccountState({
      enabled: false,
      configured: true,
      account: { accountId: 'Primary' },
      cfg,
    }),
    'disabled',
  );
  assert.equal(
    status.resolveAccountState({
      enabled: true,
      configured: false,
      account: { accountId: 'Primary' },
      cfg,
    }),
    'not configured',
  );
  assert.equal(
    status.resolveAccountState({
      enabled: true,
      configured: true,
      account: { accountId: 'Primary' },
      cfg,
      runtime: { connected: false },
    }),
    'configured',
  );
  assert.equal(
    status.resolveAccountState({
      enabled: true,
      configured: true,
      account: { accountId: 'Primary' },
      cfg,
      runtime: { connected: true },
    }),
    'linked',
  );
});

test('status surface uses default display name fallback for unnamed account snapshot', async () => {
  const status = createBncrStatusSurface(() => createBridge({ getStatusHeadline: () => 'linked' }));
  const snapshot = await status.buildAccountSnapshot({
    account: { accountId: 'Primary', name: '' },
    runtime: { connected: true, running: true, pending: 0, deadLetter: 0 },
  });

  assert.equal(snapshot.accountId, 'Primary');
  assert.equal(snapshot.name, 'Monitor');
  assert.equal(snapshot.healthSummary, 'linked');
});
