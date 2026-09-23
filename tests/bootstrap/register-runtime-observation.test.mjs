import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRegistryRuntimeObservation,
  evaluateRegistryRuntimeObservation,
  normalizeRegistryRuntimeObservation,
  REGISTRY_RUNTIME_OBSERVATION_POLL_MS,
  REGISTRY_RUNTIME_OBSERVATION_TIMEOUT_MS,
} from '../../src/bootstrap/register-runtime-observation.ts';

test('runtime observation waits until the 30 second deadline then enters polling', () => {
  const observation = createRegistryRuntimeObservation(1_000);

  assert.equal(observation.phase, 'awaiting');
  assert.equal(observation.deadlineAt, 1_000 + REGISTRY_RUNTIME_OBSERVATION_TIMEOUT_MS);

  const pending = evaluateRegistryRuntimeObservation({
    observation,
    now: observation.deadlineAt - 1,
    lifecycleActive: true,
    probe: { serviceRunning: true, activeChannelAccounts: 0 },
  });
  assert.equal(pending.action, 'wait');
  assert.equal(pending.observation.phase, 'awaiting');
  assert.equal(pending.observation.serviceObservedAt, observation.deadlineAt - 1);

  const polling = evaluateRegistryRuntimeObservation({
    observation: pending.observation,
    now: observation.deadlineAt,
    lifecycleActive: true,
    probe: { serviceRunning: true, activeChannelAccounts: 0 },
  });
  assert.equal(polling.action, 'poll');
  assert.equal(polling.transitionedToPolling, true);
  assert.equal(polling.observation.phase, 'polling');
  assert.equal(polling.observation.pollingStartedAt, observation.deadlineAt);
  assert.equal(REGISTRY_RUNTIME_OBSERVATION_POLL_MS, 5_000);
});

test('runtime observation becomes ready when both service and channel are observed', () => {
  const observation = createRegistryRuntimeObservation(10_000);
  const serviceOnly = evaluateRegistryRuntimeObservation({
    observation,
    now: 11_000,
    lifecycleActive: true,
    probe: { serviceRunning: true, activeChannelAccounts: 0 },
  });
  const ready = evaluateRegistryRuntimeObservation({
    observation: serviceOnly.observation,
    now: 12_000,
    lifecycleActive: true,
    probe: { serviceRunning: true, channelRunning: true, activeChannelAccounts: 1 },
  });

  assert.equal(ready.action, 'ready');
  assert.equal(ready.transitionedToReady, true);
  assert.equal(ready.observation.phase, 'ready');
  assert.equal(ready.observation.serviceObservedAt, 11_000);
  assert.equal(ready.observation.channelObservedAt, 12_000);
  assert.equal(ready.observation.readyAt, 12_000);
});

test('runtime observation does not become ready when service and channel were only observed separately', () => {
  const observation = createRegistryRuntimeObservation(10_000);
  const channelOnly = evaluateRegistryRuntimeObservation({
    observation,
    now: 11_000,
    lifecycleActive: true,
    probe: { serviceRunning: false, channelRunning: true },
  });
  const serviceOnly = evaluateRegistryRuntimeObservation({
    observation: channelOnly.observation,
    now: 12_000,
    lifecycleActive: true,
    probe: { serviceRunning: true, channelRunning: false },
  });

  assert.equal(serviceOnly.action, 'wait');
  assert.equal(serviceOnly.observation.phase, 'awaiting');
  assert.equal(serviceOnly.observation.channelObservedAt, 11_000);
  assert.equal(serviceOnly.observation.serviceObservedAt, 12_000);
});

test('runtime observation retires when its lifecycle is no longer active', () => {
  const observation = createRegistryRuntimeObservation(20_000);
  const retired = evaluateRegistryRuntimeObservation({
    observation,
    now: 21_000,
    lifecycleActive: false,
    probe: {},
  });

  assert.equal(retired.action, 'retired');
  assert.equal(retired.observation.phase, 'retired');
  assert.equal(retired.observation.retiredAt, 21_000);
});

test('ready runtime observation retires when its lifecycle is no longer active', () => {
  const ready = evaluateRegistryRuntimeObservation({
    observation: createRegistryRuntimeObservation(20_000),
    now: 21_000,
    lifecycleActive: true,
    probe: { serviceRunning: true, channelRunning: true },
  });

  const retired = evaluateRegistryRuntimeObservation({
    observation: ready.observation,
    now: 22_000,
    lifecycleActive: false,
    probe: { serviceRunning: true, channelRunning: true },
  });

  assert.equal(ready.action, 'ready');
  assert.equal(retired.action, 'retired');
  assert.equal(retired.observation.phase, 'retired');
  assert.equal(retired.observation.retiredAt, 22_000);
});

test('runtime observation normalization rejects malformed persisted state', () => {
  assert.equal(normalizeRegistryRuntimeObservation({ phase: 'ready' }), undefined);
  assert.deepEqual(
    normalizeRegistryRuntimeObservation({
      phase: 'ready',
      startedAt: 1,
      deadlineAt: 2,
      pollingStartedAt: null,
      readyAt: 3,
      retiredAt: null,
      lastProbeAt: 2,
      probeCount: '4',
      serviceObservedAt: 1,
      channelObservedAt: 3,
    }),
    {
      phase: 'ready',
      startedAt: 1,
      deadlineAt: 2,
      pollingStartedAt: null,
      readyAt: 3,
      retiredAt: null,
      lastProbeAt: 2,
      probeCount: 0,
      serviceObservedAt: 1,
      channelObservedAt: 3,
    },
  );
});
