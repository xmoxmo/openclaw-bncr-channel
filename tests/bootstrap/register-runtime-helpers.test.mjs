import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hydrateBridgeRegisterState,
  sameBridgeOwner,
  snapshotBridgeRegisterState,
} from '../../src/bootstrap/register-runtime-helpers.ts';

test('register-runtime helpers snapshot and hydrate preserve bounded register state', () => {
  const source = {
    registerCount: '7',
    apiGeneration: '3',
    firstRegisterAt: 10,
    lastRegisterAt: 20,
    lastApiRebindAt: 30,
    pluginSource: '/tmp/index.ts',
    pluginVersion: '0.3.6',
    lastApiInstanceId: 'api-1',
    lastRegistryFingerprint: 'svc:chn:mth',
    lastDriftSnapshot: { drift: true },
    registerTraceRecent: [{ id: 1 }, { id: 2 }],
  };

  const snapshot = snapshotBridgeRegisterState(source);
  assert.deepEqual(snapshot, {
    registerCount: 7,
    apiGeneration: 3,
    firstRegisterAt: 10,
    lastRegisterAt: 20,
    lastApiRebindAt: 30,
    pluginSource: '/tmp/index.ts',
    pluginVersion: '0.3.6',
    lastApiInstanceId: 'api-1',
    lastRegistryFingerprint: 'svc:chn:mth',
    lastDriftSnapshot: { drift: true },
    registerTraceRecent: [{ id: 1 }, { id: 2 }],
  });

  source.registerTraceRecent[0].id = 99;
  const target = {};
  hydrateBridgeRegisterState(target, snapshot);
  assert.deepEqual(target.registerTraceRecent, [{ id: 1 }, { id: 2 }]);
});

test('register-runtime helpers compare bridge owners correctly', () => {
  const ownerA = {
    moduleEpoch: 'epoch',
    bridgeFactoryId: 'factory',
    apiInstanceId: 'api-1',
    registryFingerprint: 'svc:chn:mth',
  };
  const ownerB = { ...ownerA };
  const ownerC = { ...ownerA, apiInstanceId: 'api-2' };

  assert.equal(sameBridgeOwner(ownerA, ownerB), true);
  assert.equal(sameBridgeOwner(ownerA, ownerC), false);
});
