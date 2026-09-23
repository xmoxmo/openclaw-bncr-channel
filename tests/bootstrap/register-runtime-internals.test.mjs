import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrRegisterRuntime } from '../../src/bootstrap/register-runtime.ts';
import { createBncrGatewayMethodRegistry } from '../../src/bootstrap/register-runtime-gateway.ts';
import { createBncrBridgeSingletonManager } from '../../src/bootstrap/register-runtime-singleton.ts';
import { withConsoleCapture } from '../helpers/console-capture.mjs';
import { createRegisterApiStub, resetBncrRegisterGlobals } from '../helpers/register-api.mjs';

test('register api stub matches the host service and channel dedup contract', () => {
  const api = createRegisterApiStub();
  const firstService = { id: 'bncr-bridge-service', marker: 'first', start() {} };
  const secondService = { id: ' bncr-bridge-service ', marker: 'second', start() {} };
  const firstChannel = { plugin: { id: 'bncr', marker: 'first' } };
  const secondChannel = { plugin: { id: 'bncr', marker: 'second' } };

  api.registerService(firstService);
  api.registerService(secondService);
  api.registerChannel(firstChannel);
  api.registerChannel(secondChannel);

  // Host keeps the first service for a duplicate id, but latest channel wins.
  assert.equal(api.services.length, 1);
  assert.equal(api.services[0].marker, 'first');
  assert.equal(api.channels.length, 1);
  assert.equal(api.channels[0].plugin.marker, 'second');

  const reused = createRegisterApiStub({ reuseRegistry: true });
  reused.registerService(firstService);
  reused.registerService(secondService);
  reused.registerChannel(firstChannel);
  reused.registerChannel(secondChannel);
  assert.equal(reused.services.length, 2);
  assert.equal(reused.channels.length, 2);
});

test('register runtime gateway registry deduplicates per api and registry fingerprint', () => {
  const calls = [];
  const api = {
    methods: [],
    registerGatewayMethod(name, handler) {
      this.methods.push({ name, handler });
    },
  };
  const meta = { methods: new Set(), registryFingerprint: 'svc:chn:mth' };
  const gatewayRuntime = {
    currentBridge: { getBridgeId: () => 'bridge-1', gatewayPid: 123 },
    registeredMethodsByRegistry: new Map(),
  };
  const registry = createBncrGatewayMethodRegistry({
    getRegisterMeta: () => meta,
    getRegistryFingerprint: () => 'svc:chn:mth',
    getGatewayRuntime: () => gatewayRuntime,
    gatewayMethodDispatchers: {
      'bncr.connect': (_bridge, opts) => opts,
      'bncr.inbound': (_bridge, opts) => opts,
      'bncr.activity': (_bridge, opts) => opts,
      'bncr.ack': (_bridge, opts) => opts,
      'bncr.diagnostics': (_bridge, opts) => opts,
      'bncr.deadLetter.inspect': (_bridge, opts) => opts,
      'bncr.deadLetter.prune': (_bridge, opts) => opts,
      'bncr.rpc.response': (_bridge, opts) => opts,
      'bncr.file.init': (_bridge, opts) => opts,
      'bncr.file.chunk': (_bridge, opts) => opts,
      'bncr.file.complete': (_bridge, opts) => opts,
      'bncr.file.abort': (_bridge, opts) => opts,
      'bncr.file.ack': (_bridge, opts) => opts,
    },
    getBridgeRegisterStateCarrier: (bridge) => bridge,
  });

  registry.ensureGatewayMethodRegistered(api, 'bncr.connect', (...args) =>
    calls.push(args.join(' ')),
  );
  registry.ensureGatewayMethodRegistered(api, 'bncr.connect', (...args) =>
    calls.push(args.join(' ')),
  );

  assert.equal(api.methods.length, 1);
  assert.equal(meta.methods.has('bncr.connect'), true);
  assert.match(calls[1], /already registered on this api/);
});

test('gateway method handlers resolve the latest process dispatcher generation', () => {
  const methodNames = [
    'bncr.connect',
    'bncr.inbound',
    'bncr.activity',
    'bncr.ack',
    'bncr.diagnostics',
    'bncr.deadLetter.inspect',
    'bncr.deadLetter.prune',
    'bncr.rpc.response',
    'bncr.file.init',
    'bncr.file.chunk',
    'bncr.file.complete',
    'bncr.file.abort',
    'bncr.file.ack',
  ];
  const createDispatchers = (label) =>
    Object.fromEntries(methodNames.map((name) => [name, () => label]));
  const api = {
    methods: [],
    registerGatewayMethod(name, handler) {
      this.methods.push({ name, handler });
    },
  };
  const meta = { methods: new Set(), registryFingerprint: 'svc:chn:mth' };
  const gatewayRuntime = {
    currentBridge: { getBridgeId: () => 'bridge-1', gatewayPid: 123 },
    registeredMethodsByRegistry: new Map(),
    gatewayMethodDispatchers: createDispatchers('generation-1'),
  };
  const registry = createBncrGatewayMethodRegistry({
    getRegisterMeta: () => meta,
    getRegistryFingerprint: () => 'svc:chn:mth',
    getGatewayRuntime: () => gatewayRuntime,
    gatewayMethodDispatchers: createDispatchers('generation-0'),
    getBridgeRegisterStateCarrier: (bridge) => bridge,
  });

  registry.ensureGatewayMethodRegistered(api, 'bncr.connect', () => {});
  assert.equal(api.methods[0].handler({}), 'generation-1');

  gatewayRuntime.gatewayMethodDispatchers = createDispatchers('generation-2');
  assert.equal(api.methods[0].handler({}), 'generation-2');
});

test('gateway diagnostics attach lifecycle observation without breaking the payload contract', () => {
  const calls = [];
  let observation = { phase: 'ready' };
  let observationUnavailable = false;
  const gatewayRuntime = {
    currentBridge: { getBridgeId: () => 'bridge-1', gatewayPid: 123 },
    registeredMethodsByRegistry: new Map(),
    registryDeclarations: new Map([['registry-1', { state: 'active' }]]),
  };
  const registry = createBncrGatewayMethodRegistry({
    getRegisterMeta: (api) => api.meta,
    getRegistryFingerprint: (api) => api.registryFingerprint,
    getGatewayRuntime: () => gatewayRuntime,
    gatewayMethodDispatchers: {
      'bncr.diagnostics': (_bridge, opts) => {
        opts.respond(true, { marker: 'diagnostics' });
      },
    },
    getBridgeRegisterStateCarrier: (bridge) => bridge,
    getRegistryRuntimeObservation: () => {
      if (observationUnavailable) throw new Error('observation unavailable');
      return observation;
    },
  });
  const api = {
    methods: [],
    meta: { methods: new Set(), registryFingerprint: 'registry-1' },
    registryFingerprint: 'registry-1',
    registerGatewayMethod(name, handler) {
      this.methods.push({ name, handler });
    },
  };

  registry.ensureGatewayMethodRegistered(api, 'bncr.diagnostics', () => {});
  api.methods[0].handler({ respond: (...args) => calls.push(args) });
  assert.deepEqual(calls[0][1], {
    marker: 'diagnostics',
    lifecycleObservation: { phase: 'ready' },
  });

  observation = null;
  observationUnavailable = true;
  api.methods[0].handler({ respond: (...args) => calls.push(args) });
  assert.deepEqual(calls[1][1], {
    marker: 'diagnostics',
    lifecycleObservation: null,
  });
});

test('shadow registry diagnostics fall back to the active lifecycle observation', () => {
  resetBncrRegisterGlobals();
  const runtime = createBncrRegisterRuntime();
  const activeApi = createRegisterApiStub();
  const shadowApi = createRegisterApiStub();

  try {
    const activeDecision = runtime.planLifecycle(activeApi);
    runtime.commitLifecycle(activeDecision);
    const activeRegistry = activeDecision.owner.key.registryFingerprint;
    const activeBridgeGeneration = runtime.getBridgeGenerationKey(
      activeDecision.owner.bridgeGeneration,
    );
    runtime.markRegistryServiceDeclared(
      activeRegistry,
      activeBridgeGeneration,
      activeDecision.owner.key.generation,
    );
    runtime.markRegistryChannelDeclared(
      activeRegistry,
      activeBridgeGeneration,
      activeDecision.owner.key.generation,
    );
    runtime.markRegistryRegistrationComplete(
      activeRegistry,
      activeBridgeGeneration,
      activeDecision.owner.key.generation,
    );

    const shadowDecision = runtime.planLifecycle(shadowApi);
    assert.equal(shadowDecision.kind, 'duplicate');
    runtime.commitLifecycle(shadowDecision);
    const shadowRegistry = shadowDecision.owner.key.registryFingerprint;

    assert.equal(
      runtime.getRegistryRuntimeObservation(shadowRegistry)?.phase,
      runtime.getRegistryRuntimeObservation(activeRegistry)?.phase,
    );
  } finally {
    resetBncrRegisterGlobals();
  }
});

test('register runtime registers the client RPC response method', () => {
  const api = {
    methods: [],
    registerGatewayMethod(name, handler) {
      this.methods.push({ name, handler });
    },
  };
  const meta = { methods: new Set(), registryFingerprint: 'svc:chn:mth' };
  const gatewayRuntime = {
    currentBridge: { getBridgeId: () => 'bridge-1', gatewayPid: 123 },
    registeredMethodsByRegistry: new Map(),
  };
  const registry = createBncrGatewayMethodRegistry({
    getRegisterMeta: () => meta,
    getRegistryFingerprint: () => 'svc:chn:mth',
    getGatewayRuntime: () => gatewayRuntime,
    gatewayMethodDispatchers: {
      'bncr.connect': (_bridge, opts) => opts,
      'bncr.inbound': (_bridge, opts) => opts,
      'bncr.activity': (_bridge, opts) => opts,
      'bncr.ack': (_bridge, opts) => opts,
      'bncr.diagnostics': (_bridge, opts) => opts,
      'bncr.deadLetter.inspect': (_bridge, opts) => opts,
      'bncr.deadLetter.prune': (_bridge, opts) => opts,
      'bncr.rpc.response': (_bridge, opts) => opts,
      'bncr.file.init': (_bridge, opts) => opts,
      'bncr.file.chunk': (_bridge, opts) => opts,
      'bncr.file.complete': (_bridge, opts) => opts,
      'bncr.file.abort': (_bridge, opts) => opts,
      'bncr.file.ack': (_bridge, opts) => opts,
    },
    getBridgeRegisterStateCarrier: (bridge) => bridge,
  });

  registry.ensureGatewayMethodRegistered(api, 'bncr.rpc.response', () => {});

  assert.deepEqual(
    api.methods.map((item) => item.name),
    ['bncr.rpc.response'],
  );
});

test('register runtime allows shadow method dispatch but blocks retired registries', () => {
  const gatewayRuntime = {
    currentBridge: { getBridgeId: () => 'bridge-1', gatewayPid: 123 },
    registeredMethodsByRegistry: new Map(),
    registryDeclarations: new Map([
      ['active-registry', { state: 'active' }],
      ['shadow-registry', { state: 'shadow' }],
      ['retired-registry', { state: 'retired' }],
    ]),
  };
  const registry = createBncrGatewayMethodRegistry({
    getRegisterMeta: (api) => api.meta,
    getRegistryFingerprint: (api) => api.registryFingerprint,
    getGatewayRuntime: () => gatewayRuntime,
    gatewayMethodDispatchers: {
      'bncr.connect': (_bridge, opts) => opts,
      'bncr.inbound': (_bridge, opts) => opts,
      'bncr.activity': (_bridge, opts) => opts,
      'bncr.ack': (_bridge, opts) => opts,
      'bncr.diagnostics': (_bridge, opts) => opts,
      'bncr.deadLetter.inspect': (_bridge, opts) => opts,
      'bncr.deadLetter.prune': (_bridge, opts) => opts,
      'bncr.rpc.response': (_bridge, opts) => opts,
      'bncr.file.init': (_bridge, opts) => opts,
      'bncr.file.chunk': (_bridge, opts) => opts,
      'bncr.file.complete': (_bridge, opts) => opts,
      'bncr.file.abort': (_bridge, opts) => opts,
      'bncr.file.ack': (_bridge, opts) => opts,
    },
    getBridgeRegisterStateCarrier: (bridge) => bridge,
  });

  const createApi = (registryFingerprint) => {
    const api = {
      methods: [],
      meta: { methods: new Set(), registryFingerprint },
      registryFingerprint,
      registerGatewayMethod(name, handler) {
        this.methods.push({ name, handler });
      },
    };
    registry.ensureGatewayMethodRegistered(api, 'bncr.connect', () => {});
    return api;
  };

  const activeApi = createApi('active-registry');
  const shadowApi = createApi('shadow-registry');
  const retiredApi = createApi('retired-registry');

  assert.deepEqual(activeApi.methods[0].handler({ source: 'active' }), { source: 'active' });
  assert.deepEqual(shadowApi.methods[0].handler({ source: 'shadow' }), { source: 'shadow' });
  assert.throws(
    () => retiredApi.methods[0].handler({}),
    /lifecycle registry is inactive for bncr\.connect/,
  );
});

test('register runtime singleton manager rebuilds bridge when owner changes and hydrates state', () => {
  delete globalThis.__bncrBridge;
  const bridgeOwnerSymbol = Symbol.for('bncr.test.bridge.owner');
  const makeBridge = (label) => ({
    label,
    bindApi(api) {
      this.boundApi = api;
    },
    bindRuntimePaths(paths) {
      this.boundRuntimePaths = paths;
    },
    stopService() {
      this.stopped = true;
    },
    registerCount: 7,
    apiGeneration: 2,
    registerTraceRecent: [{ id: 1 }],
  });

  let seq = 0;
  const manager = createBncrBridgeSingletonManager({
    bridgeOwnerSymbol,
    pluginRoot: '/tmp/plugin',
    pluginFile: '/tmp/plugin/index.ts',
    loadBncrRuntimeSync: () => ({
      createBncrBridge: () => makeBridge(`bridge-${++seq}`),
    }),
    getBridgeOwner: (_api, _loaded) => ({
      moduleEpoch: 'epoch',
      bridgeFactoryId: seq === 0 ? 'factory-1' : `factory-${seq + 1}`,
      apiInstanceId: seq === 0 ? 'api-1' : `api-${seq + 1}`,
      registryFingerprint: seq === 0 ? 'svc:1' : `svc:${seq + 1}`,
    }),
  });

  const first = manager.getBridgeSingleton({});
  first.bridge.registerCount = 9;
  const second = manager.getBridgeSingleton({});

  assert.ok(first.bridge);
  assert.ok(second.bridge);
  assert.notEqual(first.bridge, second.bridge);
  assert.equal(second.rebuilt, true);
  assert.equal(second.bridge.registerCount, 9);
  assert.deepEqual(second.bridge.boundRuntimePaths, {
    pluginRoot: '/tmp/plugin',
    pluginFile: '/tmp/plugin/index.ts',
  });

  delete globalThis.__bncrBridge;
});

test('bridge adoption failure retires the committed lifecycle', () => {
  resetBncrRegisterGlobals();
  const runtime = createBncrRegisterRuntime();
  const api = createRegisterApiStub();

  try {
    const decision = runtime.planLifecycle(api);
    runtime.commitLifecycle(decision);
    globalThis.__bncrBridge = {
      bindApi() {
        throw new Error('bind failed');
      },
    };

    assert.throws(() => runtime.adoptLifecycleBridge(api, decision.owner, 'reuse'), /bind failed/);

    const gatewayRuntime = runtime.getGatewayRuntime();
    assert.equal(gatewayRuntime.lifecycle.active?.phase, 'failed');
    assert.equal(
      gatewayRuntime.registryDeclarations.get(decision.owner.key.registryFingerprint)?.state,
      'retired',
    );
  } finally {
    resetBncrRegisterGlobals();
  }
});

test('registration recovery retires declarations after the scope was completed', () => {
  resetBncrRegisterGlobals();
  const runtime = createBncrRegisterRuntime();
  const api = createRegisterApiStub();

  try {
    const decision = runtime.planLifecycle(api);
    runtime.commitLifecycle(decision);
    const registry = decision.owner.key.registryFingerprint;
    const bridgeGeneration = runtime.getBridgeGenerationKey(decision.owner.bridgeGeneration);
    const generation = decision.owner.key.generation;
    runtime.markRegistryServiceDeclared(registry, bridgeGeneration, generation);
    runtime.markRegistryChannelDeclared(registry, bridgeGeneration, generation);
    runtime.markRegistryRegistrationComplete(registry, bridgeGeneration, generation);

    assert.equal(
      runtime.recoverLifecycleRegistration(decision, new Error('late registration failure')),
      'stopped',
    );

    const declaration = runtime.getGatewayRuntime().registryDeclarations.get(registry);
    assert.equal(runtime.getGatewayRuntime().lifecycle.active?.phase, 'stopped');
    assert.equal(declaration?.registration, 'failed');
    assert.equal(declaration?.state, 'retired');
    assert.equal(declaration?.runtimeObservation?.phase, 'retired');
  } finally {
    resetBncrRegisterGlobals();
  }
});

test('concurrent starts for one pending generation share a single activation', async () => {
  resetBncrRegisterGlobals();
  const runtime = createBncrRegisterRuntime();
  const predecessorApi = createRegisterApiStub();
  const successorApi = createRegisterApiStub();

  try {
    const predecessor = runtime.planLifecycle(predecessorApi);
    runtime.commitLifecycle(predecessor);
    const predecessorRegistry = predecessor.owner.key.registryFingerprint;
    const predecessorGeneration = predecessor.owner.key.generation;
    assert.ok(runtime.beginRetirement(predecessorRegistry, predecessorGeneration));

    const successor = runtime.planLifecycle(successorApi);
    assert.equal(successor.kind, 'defer');
    runtime.commitLifecycle(successor);
    const successorRegistry = successor.owner.key.registryFingerprint;
    const successorGeneration = successor.owner.key.generation;

    const first = runtime.getLifecycleBridgeForStart(
      successorApi,
      successorRegistry,
      successorGeneration,
    );
    const second = runtime.getLifecycleBridgeForStart(
      successorApi,
      successorRegistry,
      successorGeneration,
    );
    runtime.settleRetirement(predecessorRegistry, { ok: true }, predecessorGeneration);

    const [firstBridge, secondBridge] = await Promise.all([first, second]);
    assert.ok(firstBridge);
    assert.equal(firstBridge, secondBridge);
    assert.equal(runtime.getGatewayRuntime().lifecycle.active?.key.generation, successorGeneration);
  } finally {
    resetBncrRegisterGlobals();
  }
});

test('concurrent starts for one stopped generation share a single reactivation', async () => {
  resetBncrRegisterGlobals();
  const runtime = createBncrRegisterRuntime();
  const api = createRegisterApiStub();

  try {
    const decision = runtime.planLifecycle(api);
    runtime.commitLifecycle(decision);
    const registry = decision.owner.key.registryFingerprint;
    const generation = decision.owner.key.generation;
    assert.ok(runtime.beginRetirement(registry, generation));
    runtime.settleRetirement(registry, { ok: true }, generation);

    const first = runtime.getLifecycleBridgeForStart(api, registry, generation);
    const second = runtime.getLifecycleBridgeForStart(api, registry, generation);

    const [firstBridge, secondBridge] = await Promise.all([first, second]);
    assert.ok(firstBridge);
    assert.equal(firstBridge, secondBridge);
    assert.equal(runtime.getGatewayRuntime().lifecycle.active?.phase, 'active');
  } finally {
    resetBncrRegisterGlobals();
  }
});

test('gateway method error emits summary always and detailed JSON only in debug path', async () => {
  const api = {
    methods: [],
    registerGatewayMethod(name, handler) {
      this.methods.push({ name, handler });
    },
  };
  const meta = { methods: new Set(), registryFingerprint: 'svc:chn:mth' };
  const gatewayRuntime = {
    currentBridge: { getBridgeId: () => 'bridge-1', gatewayPid: 123 },
    registeredMethodsByRegistry: new Map(),
  };
  const registry = createBncrGatewayMethodRegistry({
    getRegisterMeta: () => meta,
    getRegistryFingerprint: () => 'svc:chn:mth',
    getGatewayRuntime: () => gatewayRuntime,
    gatewayMethodDispatchers: {
      'bncr.connect': () => {
        throw new Error('boom-connect');
      },
      'bncr.inbound': (_bridge, opts) => opts,
      'bncr.activity': (_bridge, opts) => opts,
      'bncr.ack': (_bridge, opts) => opts,
      'bncr.diagnostics': (_bridge, opts) => opts,
      'bncr.deadLetter.inspect': (_bridge, opts) => opts,
      'bncr.deadLetter.prune': (_bridge, opts) => opts,
      'bncr.rpc.response': (_bridge, opts) => opts,
      'bncr.file.init': (_bridge, opts) => opts,
      'bncr.file.chunk': (_bridge, opts) => opts,
      'bncr.file.complete': (_bridge, opts) => opts,
      'bncr.file.abort': (_bridge, opts) => opts,
      'bncr.file.ack': (_bridge, opts) => opts,
    },
    getBridgeRegisterStateCarrier: (bridge) => bridge,
  });

  registry.ensureGatewayMethodRegistered(api, 'bncr.connect', () => {});

  const { error: errors } = await withConsoleCapture('error', async ({ error }) => {
    assert.throws(() => api.methods[0].handler({}), /boom-connect/);
    return { error };
  });

  assert.ok(
    errors.some(
      (line) =>
        line.includes('[bncr] gateway method error') &&
        line.includes('method=bncr.connect|bridgeId=bridge-1|gatewayPid=123|err=boom-connect'),
    ),
  );
  assert.equal(
    errors.some(
      (line) =>
        line.includes('[bncr] gateway method error') &&
        line.includes('{"method":"bncr.connect"') &&
        line.includes('"message":"boom-connect"'),
    ),
    false,
  );
});
