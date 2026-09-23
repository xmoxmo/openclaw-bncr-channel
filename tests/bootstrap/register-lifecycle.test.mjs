import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activatePendingLifecycle,
  beginLifecycleRetirement,
  commitLifecycleAdoption,
  createRegisterLifecycleState,
  dumpLifecycleOwner,
  failLifecycle,
  isLifecycleRegistryActive,
  isLifecycleRegistryStoppable,
  planLifecycleAdoption,
  reactivateStoppedLifecycle,
  settleLifecycleRetirement,
} from '../../src/bootstrap/register-lifecycle.ts';

const bridgeGeneration = {
  moduleEpoch: 'module-1',
  bridgeFactoryId: 'factory-1',
  pluginVersion: '0.6.8',
  registrationMode: 'full',
  pluginRoot: '/plugins/bncr',
  pluginFile: '/plugins/bncr/index.ts',
};

function input(apiInstanceId, registryFingerprint, overrides = {}) {
  return {
    apiInstanceId,
    registryFingerprint,
    bridgeGeneration,
    now: 1_000,
    ...overrides,
  };
}

test('lifecycle state initializes and duplicates an active owner without rebinding', () => {
  const state = createRegisterLifecycleState();
  const first = planLifecycleAdoption(state, input('api-1', 'registry-1'));

  assert.equal(first.kind, 'initialize');
  commitLifecycleAdoption(state, first);
  assert.equal(state.active?.key.generation, 1);
  assert.equal(state.active?.phase, 'active');

  const duplicate = planLifecycleAdoption(state, input('api-2', 'registry-2'));
  assert.equal(duplicate.kind, 'duplicate');
  assert.equal(duplicate.reason, 'active-owner');

  commitLifecycleAdoption(state, duplicate);
  assert.equal(state.active?.key.apiInstanceId, 'api-1');
  assert.equal(state.active?.key.registryFingerprint, 'registry-1');
});

test('lifecycle state defers a successor while the active owner is stopping', async () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));

  const retirement = beginLifecycleRetirement(state, 'registry-1', 2_000);
  assert.ok(retirement);
  assert.equal(state.active?.phase, 'stopping');

  const deferred = planLifecycleAdoption(state, input('api-2', 'registry-2'));
  assert.equal(deferred.kind, 'defer');
  assert.equal(deferred.mode, 'reuse');
  commitLifecycleAdoption(state, deferred);

  assert.equal(state.pending?.key.apiInstanceId, 'api-2');
  assert.equal(isLifecycleRegistryActive(state, 'registry-2'), false);

  settleLifecycleRetirement(state, 'registry-1', { ok: true }, 3_000);
  assert.deepEqual(await retirement, { ok: true });
  assert.equal(state.active?.phase, 'stopped');

  const activated = activatePendingLifecycle(state, 'registry-2', 4_000);
  assert.equal(activated?.key.apiInstanceId, 'api-2');
  assert.equal(activated?.phase, 'active');
  assert.equal(isLifecycleRegistryActive(state, 'registry-2'), true);
  assert.equal(isLifecycleRegistryActive(state, 'registry-2', 2), true);
  assert.equal(isLifecycleRegistryActive(state, 'registry-2', 1), false);
  assert.equal(isLifecycleRegistryActive(state, 'registry-1'), false);
});

test('lifecycle state selects reuse and replacement takeover modes', () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));
  state.active.phase = 'stopped';

  const reused = planLifecycleAdoption(state, input('api-2', 'registry-2'));
  assert.equal(reused.kind, 'takeover');
  assert.equal(reused.mode, 'reuse');

  const replaced = planLifecycleAdoption(
    state,
    input('api-3', 'registry-3', {
      bridgeGeneration: { ...bridgeGeneration, bridgeFactoryId: 'factory-2' },
    }),
  );
  assert.equal(replaced.kind, 'takeover');
  assert.equal(replaced.mode, 'replace');
});

test('same lifecycle stopped registration is a duplicate when bridge generation is unchanged', () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));
  state.active.phase = 'stopped';

  const duplicate = planLifecycleAdoption(state, input('api-1', 'registry-1'));

  assert.equal(duplicate.kind, 'duplicate');
  assert.equal(duplicate.reason, 'same-lifecycle-stopped');
  assert.equal(duplicate.owner.key.generation, 2);
  commitLifecycleAdoption(state, duplicate);
  assert.equal(state.active?.key.generation, 1);
});

test('same lifecycle changed code generation is rejected', () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));
  state.active.phase = 'stopped';

  const rejected = planLifecycleAdoption(
    state,
    input('api-1', 'registry-1', {
      bridgeGeneration: { ...bridgeGeneration, bridgeFactoryId: 'factory-2' },
    }),
  );

  assert.equal(rejected.kind, 'reject');
  assert.equal(rejected.reason, 'registration-generation-conflict');
  commitLifecycleAdoption(state, rejected);
  assert.equal(state.active?.key.generation, 1);
});

test('lifecycle state treats a repeated registration during stopping as a duplicate', () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));
  assert.ok(beginLifecycleRetirement(state, 'registry-1', 2_000));

  const duplicate = planLifecycleAdoption(state, input('api-1', 'registry-1'));

  assert.equal(duplicate.kind, 'duplicate');
  assert.equal(duplicate.reason, 'lifecycle-stopping');
});

test('lifecycle state rejects a stopping registration when its code generation changes', () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));
  assert.ok(beginLifecycleRetirement(state, 'registry-1', 2_000));

  const replaced = planLifecycleAdoption(
    state,
    input('api-1', 'registry-1', {
      bridgeGeneration: { ...bridgeGeneration, bridgeFactoryId: 'factory-2' },
    }),
  );

  assert.equal(replaced.kind, 'reject');
  assert.equal(replaced.reason, 'registration-generation-conflict');

  commitLifecycleAdoption(state, replaced);
  assert.equal(state.pending, undefined);
  assert.equal(state.active?.phase, 'stopping');
});

test('lifecycle state rejects an existing pending successor with a newer code generation', () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));
  assert.ok(beginLifecycleRetirement(state, 'registry-1', 2_000));

  const first = planLifecycleAdoption(state, input('api-2', 'registry-2'));
  assert.equal(first.kind, 'defer');
  commitLifecycleAdoption(state, first);
  assert.equal(state.pending?.key.generation, 2);

  const duplicate = planLifecycleAdoption(state, input('api-2', 'registry-2'));
  assert.equal(duplicate.kind, 'duplicate');
  assert.equal(duplicate.reason, 'pending-successor');

  const replaced = planLifecycleAdoption(
    state,
    input('api-2', 'registry-2', {
      bridgeGeneration: { ...bridgeGeneration, bridgeFactoryId: 'factory-2' },
    }),
  );
  assert.equal(replaced.kind, 'reject');
  assert.equal(replaced.reason, 'registration-generation-conflict');

  commitLifecycleAdoption(state, replaced);
  assert.equal(state.pending?.key.generation, 2);
  assert.equal(state.pending?.bridgeGeneration.bridgeFactoryId, 'factory-1');
});

test('lifecycle state rejects a different pending successor', () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));
  assert.ok(beginLifecycleRetirement(state, 'registry-1', 2_000));

  const first = planLifecycleAdoption(state, input('api-2', 'registry-2'));
  commitLifecycleAdoption(state, first);

  const conflict = planLifecycleAdoption(state, input('api-3', 'registry-3'));
  assert.equal(conflict.kind, 'reject');
  assert.equal(conflict.reason, 'pending-successor-conflict');
});

test('pending successor prevents a stopped predecessor callback from reactivating', async () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));
  const retirement = beginLifecycleRetirement(state, 'registry-1', 2_000);
  assert.ok(retirement);

  const deferred = planLifecycleAdoption(state, input('api-2', 'registry-2'));
  assert.equal(deferred.kind, 'defer');
  commitLifecycleAdoption(state, deferred);
  assert.equal(settleLifecycleRetirement(state, 'registry-1', { ok: true }, 3_000), true);
  assert.deepEqual(await retirement, { ok: true });

  assert.equal(reactivateStoppedLifecycle(state, 'registry-1', 4_000), null);
  const activated = activatePendingLifecycle(state, 'registry-2', 5_000);
  assert.equal(activated?.key.apiInstanceId, 'api-2');
});

test('lifecycle state rejects adoption after a failed predecessor', () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));
  const retirement = beginLifecycleRetirement(state, 'registry-1', 2_000);
  assert.ok(retirement);
  settleLifecycleRetirement(state, 'registry-1', { ok: false, error: 'stop failed' }, 3_000);

  const decision = planLifecycleAdoption(state, input('api-2', 'registry-2'));
  assert.equal(decision.kind, 'reject');
  assert.equal(decision.reason, 'predecessor-failed');
});

test('lifecycle state rejects a pending replacement after retirement fails', () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));
  assert.ok(beginLifecycleRetirement(state, 'registry-1', 2_000));

  const deferred = planLifecycleAdoption(state, input('api-2', 'registry-2'));
  assert.equal(deferred.kind, 'defer');
  commitLifecycleAdoption(state, deferred);
  assert.equal(
    settleLifecycleRetirement(state, 'registry-1', { ok: false, error: 'stop failed' }, 3_000),
    true,
  );

  const replacement = planLifecycleAdoption(
    state,
    input('api-2', 'registry-2', {
      bridgeGeneration: { ...bridgeGeneration, bridgeFactoryId: 'factory-2' },
    }),
  );
  assert.equal(replacement.kind, 'reject');
  assert.equal(replacement.reason, 'predecessor-failed');
  assert.equal(state.pending?.key.generation, 2);
});

test('lifecycle state suppresses stale stop callbacks and records failure', async () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));
  const retirement = beginLifecycleRetirement(state, 'registry-1', 2_000);
  assert.ok(retirement);
  settleLifecycleRetirement(state, 'registry-1', { ok: true }, 3_000);

  const takeover = planLifecycleAdoption(state, input('api-2', 'registry-2'));
  assert.equal(takeover.kind, 'takeover');
  commitLifecycleAdoption(state, takeover);

  assert.equal(beginLifecycleRetirement(state, 'registry-1', 5_000), null);
  assert.equal(state.staleCallbackSuppressions, 1);
  assert.equal(failLifecycle(state, 'registry-1', new Error('stale start failed')), false);
  assert.equal(failLifecycle(state, 'registry-2', new Error('start failed')), true);
  assert.equal(state.active?.phase, 'failed');
});

test('a late start failure cannot overwrite an in-flight retirement', async () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));
  const retirement = beginLifecycleRetirement(state, 'registry-1', 2_000);
  assert.ok(retirement);

  assert.equal(failLifecycle(state, 'registry-1', new Error('late start failed')), false);
  assert.equal(state.active?.phase, 'stopping');
  assert.equal(settleLifecycleRetirement(state, 'registry-1', { ok: true }, 3_000), true);
  assert.deepEqual(await retirement, { ok: true });
  assert.equal(state.active?.phase, 'stopped');
});

test('lifecycle state allows stop only while its registry owns the active lifecycle', () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));

  assert.equal(isLifecycleRegistryStoppable(state, 'registry-1'), true);
  assert.equal(isLifecycleRegistryStoppable(state, 'registry-2'), false);

  state.active.phase = 'stopping';
  assert.equal(isLifecycleRegistryStoppable(state, 'registry-1'), true);

  state.active.phase = 'stopped';
  assert.equal(isLifecycleRegistryStoppable(state, 'registry-1'), false);
});

test('lifecycle diagnostics dump bounded owner fields', () => {
  const state = createRegisterLifecycleState();
  commitLifecycleAdoption(state, planLifecycleAdoption(state, input('api-1', 'registry-1')));

  assert.deepEqual(dumpLifecycleOwner(state.active), {
    generation: 1,
    apiInstanceId: 'api-1',
    registryFingerprint: 'registry-1',
    phase: 'active',
    moduleEpoch: 'module-1',
    bridgeFactoryId: 'factory-1',
    pluginVersion: '0.6.8',
    startedAt: 1_000,
    stopRequestedAt: null,
    stoppedAt: null,
    failure: null,
  });
});
