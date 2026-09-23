import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BNCR_GATEWAY_METHODS } from '../../src/plugin/gateway-methods.ts';
import {
  createRegisterApiStub,
  getRegisteredMethod,
  resetBncrRegisterGlobals,
} from '../helpers/register-api.mjs';

const GATEWAY_RUNTIME_SYMBOL = Symbol.for('bncr.gateway.runtime');
const GLOBAL_REGISTER_TRACE_SYMBOL = Symbol.for('bncr.global.register.trace');

function getGatewayRuntimeState() {
  const runtime = process[GATEWAY_RUNTIME_SYMBOL];
  assert.ok(runtime);
  return runtime;
}

function getBridgeOwnerRecord(bridge) {
  const ownerSymbol = Object.getOwnPropertySymbols(bridge).find((symbol) => {
    const value = bridge[symbol];
    return Boolean(
      value &&
        typeof value === 'object' &&
        'moduleEpoch' in value &&
        'bridgeFactoryId' in value &&
        'apiInstanceId' in value &&
        'registryFingerprint' in value,
    );
  });
  assert.ok(ownerSymbol);
  return bridge[ownerSymbol];
}

test('bncr manifest config schemas stay aligned with runtime schema keys', async () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../../openclaw.plugin.json', import.meta.url), 'utf8'),
  );
  const { BncrConfigSchema } = await import('../../src/core/config-schema.ts');

  const runtimeKeys = Object.keys(BncrConfigSchema.schema.properties).sort();
  const manifestTopKeys = Object.keys(manifest.configSchema.properties).sort();
  const manifestChannelKeys = Object.keys(manifest.channelConfigs.bncr.schema.properties).sort();

  assert.deepEqual(manifestTopKeys, runtimeKeys);
  assert.deepEqual(manifestChannelKeys, runtimeKeys);
});

test('bncr register is idempotent on the same api instance', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();

  mod.default.register(api);
  const methodCountAfterFirstRegister = api.methods.length;
  const channelCountAfterFirstRegister = api.channels.length;
  const serviceCountAfterFirstRegister = api.services.length;
  mod.default.register(api);

  assert.ok(methodCountAfterFirstRegister > 0);
  assert.ok(channelCountAfterFirstRegister > 0);
  assert.ok(serviceCountAfterFirstRegister > 0);
  assert.equal(api.methods.length, methodCountAfterFirstRegister);
  assert.equal(api.channels.length, channelCountAfterFirstRegister);
  assert.equal(api.services.length, serviceCountAfterFirstRegister);
  assert.equal(api.methods.length, new Set(api.methods.map((item) => item.name)).size);
});

test('bncr register observes service and channel activation without waiting for timeout', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-runtime-observation-'));
  const abortController = new AbortController();

  try {
    mod.default.register(api);
    const runtime = getGatewayRuntimeState();
    const registryFingerprint = runtime.lifecycle.active.key.registryFingerprint;
    const declaration = runtime.registryDeclarations.get(registryFingerprint);
    assert.equal(declaration.runtimeObservation.phase, 'awaiting');
    assert.equal(runtime.runtimeObservationTimers.has(registryFingerprint), true);

    await api.services[0].start({ stateDir });
    assert.equal(declaration.runtimeObservation.phase, 'awaiting');
    assert.equal(typeof declaration.runtimeObservation.serviceObservedAt, 'number');

    const startingChannel = api.channels[0].plugin.gateway.startAccount({
      accountId: 'Primary',
      getStatus: () => ({}),
      setStatus: () => {},
      abortSignal: abortController.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(declaration.runtimeObservation.phase, 'ready');
    assert.equal(typeof declaration.runtimeObservation.channelObservedAt, 'number');
    assert.equal(runtime.runtimeObservationTimers.has(registryFingerprint), false);

    abortController.abort();
    await startingChannel;
    await api.services[0].stop();
    assert.equal(declaration.runtimeObservation.phase, 'retired');
  } finally {
    abortController.abort();
    await api.services[0]?.stop?.().catch(() => {});
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr runtime observation probe failures do not fail startup', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-runtime-observation-error-'));
  const abortController = new AbortController();

  try {
    mod.default.register(api);
    const runtime = getGatewayRuntimeState();
    const registryFingerprint = runtime.lifecycle.active.key.registryFingerprint;
    const declaration = runtime.registryDeclarations.get(registryFingerprint);
    runtime.currentBridge.getRuntimeObservation = () => {
      throw new Error('probe boom');
    };

    await assert.doesNotReject(api.services[0].start({ stateDir }));
    assert.equal(runtime.lifecycle.active?.phase, 'active');
    assert.equal(declaration.runtimeObservation.phase, 'awaiting');
    assert.equal(runtime.runtimeObservationTimers.has(registryFingerprint), true);

    const startingChannel = api.channels[0].plugin.gateway.startAccount({
      accountId: 'Primary',
      getStatus: () => ({}),
      setStatus: () => {},
      abortSignal: abortController.signal,
    });
    abortController.abort();
    await assert.doesNotReject(startingChannel);
    await api.services[0].stop();
    assert.equal(declaration.runtimeObservation.phase, 'retired');
  } finally {
    abortController.abort();
    await api.services[0]?.stop?.().catch(() => {});
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr runtime observation probe failures keep polling scheduled', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-runtime-observation-retry-'));

  try {
    mod.default.register(api);
    const runtime = getGatewayRuntimeState();
    const registryFingerprint = runtime.lifecycle.active.key.registryFingerprint;
    const declaration = runtime.registryDeclarations.get(registryFingerprint);
    const pendingTimer = runtime.runtimeObservationTimers.get(registryFingerprint);
    clearTimeout(pendingTimer.timer);
    runtime.runtimeObservationTimers.delete(registryFingerprint);
    declaration.runtimeObservation.deadlineAt = Date.now() - 1;
    runtime.currentBridge.getRuntimeObservation = () => {
      throw new Error('transient probe boom');
    };

    await api.services[0].start({ stateDir });

    assert.equal(runtime.runtimeObservationTimers.has(registryFingerprint), true);
  } finally {
    resetBncrRegisterGlobals();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr register reactivates a stopped same-registration scope without redeclaring', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-same-scope-'));

  try {
    mod.default.register(api);
    const bridge = globalThis.__bncrBridge;
    assert.ok(bridge);
    await api.services[0].stop();

    mod.default.register(api);
    const runtime = getGatewayRuntimeState();
    const declaration = runtime.registryDeclarations.get(
      runtime.lifecycle.active.key.registryFingerprint,
    );
    assert.equal(api.services.length, 1);
    assert.equal(api.channels.length, 1);
    assert.equal(runtime.lifecycle.active?.phase, 'stopped');
    assert.equal(declaration.service, 'declared');
    assert.equal(declaration.channel, 'declared');
    assert.equal(declaration.registration, 'complete');
    assert.equal(declaration.lifecycleGeneration, runtime.lifecycle.active.key.generation);
    assert.equal(declaration.runtimeObservation.phase, 'retired');

    await api.services[0].start({ stateDir });
    assert.equal(bridge.stopped, false);
    assert.equal(runtime.lifecycle.active?.phase, 'active');
    assert.equal(declaration.runtimeObservation.phase, 'awaiting');
    assert.equal(typeof declaration.runtimeObservation.serviceObservedAt, 'number');
    assert.equal(
      runtime.runtimeObservationTimers.has(runtime.lifecycle.active.key.registryFingerprint),
      true,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr register exposes every declared gateway method', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();

  mod.default.register(api);

  const registered = new Set(api.methods.map((item) => item.name));
  for (const method of BNCR_GATEWAY_METHODS) {
    assert.ok(registered.has(method), `missing gateway method ${method}`);
  }
});

test('bncr register migrates a legacy process runtime without losing declarations', async () => {
  resetBncrRegisterGlobals();
  process[GATEWAY_RUNTIME_SYMBOL] = {
    registeredMethodsByRegistry: new Map(),
    serviceRegistered: true,
    channelRegistered: true,
    serviceOwnerApiInstanceId: 'legacy-api',
    channelOwnerApiInstanceId: 'legacy-api',
  };

  try {
    const mod = await import('../../index.ts');
    const api = createRegisterApiStub();

    assert.doesNotThrow(() => mod.default.register(api));

    const runtime = getGatewayRuntimeState();
    assert.ok(runtime.lifecycle);
    assert.ok(runtime.registryDeclarations instanceof Map);
    assert.equal(api.services.length, 1);
    assert.equal(api.channels.length, 1);
    assert.ok(api.methods.length > 0);
  } finally {
    resetBncrRegisterGlobals();
  }
});

test('bncr register freezes bridge and service lifecycle during startup fan-out', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();

  mod.default.register(api1);
  const bridge1 = globalThis.__bncrBridge;
  const api1MethodCount = api1.methods.length;
  const api1ChannelCount = api1.channels.length;
  const api1ServiceCount = api1.services.length;
  mod.default.register(api2);
  const bridge2 = globalThis.__bncrBridge;

  assert.ok(bridge1);
  assert.equal(bridge1, bridge2);
  assert.ok(api1MethodCount > 0);
  assert.ok(api1ChannelCount > 0);
  assert.ok(api1ServiceCount > 0);
  assert.ok(api2.methods.length > 0);
  assert.equal(api2.channels.length, 0);
  assert.equal(api2.services.length, 0);
});

test('bncr duplicate registration preserves the active gateway dispatcher generation', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();

  mod.default.register(api1);
  const runtime = getGatewayRuntimeState();
  const activeDispatchers = {};
  runtime.gatewayMethodDispatchers = activeDispatchers;

  mod.default.register(api2);

  assert.equal(runtime.gatewayMethodDispatchers, activeDispatchers);
});

test('bncr register takes over a stopped lifecycle and rebinds the existing bridge', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-successor-'));

  try {
    mod.default.register(api1);
    const bridge1 = globalThis.__bncrBridge;
    assert.ok(bridge1);
    assert.equal(api1.services.length, 1);
    assert.equal(api1.channels.length, 1);

    await api1.services[0].stop();
    assert.equal(bridge1.stopped, true);

    mod.default.register(api2);
    const bridge2 = globalThis.__bncrBridge;
    assert.equal(bridge2, bridge1);
    assert.equal(api2.services.length, 1);
    assert.equal(api2.channels.length, 1);
    assert.equal(bridge2.api, api2);

    await api2.services[0].start({ stateDir });
    assert.equal(bridge2.stopped, false);

    await api1.services[0].stop();
    assert.equal(bridge2.stopped, false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr register defers successor startup until predecessor stop settles', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-deferred-'));

  try {
    mod.default.register(api1);
    const bridge1 = globalThis.__bncrBridge;
    assert.ok(bridge1);
    const originalStartService = bridge1.startService;
    let startServiceCalls = 0;
    bridge1.startService = async (...args) => {
      startServiceCalls += 1;
      return originalStartService(...args);
    };

    const stopping = api1.services[0].stop();
    mod.default.register(api2);

    assert.equal(globalThis.__bncrBridge, bridge1);
    assert.equal(api2.services.length, 1);
    assert.equal(api2.channels.length, 1);

    await stopping;
    await api1.services[0].start({ stateDir });
    assert.equal(startServiceCalls, 0);
    await api2.services[0].start({ stateDir });

    assert.equal(startServiceCalls, 1);
    assert.equal(globalThis.__bncrBridge, bridge1);
    assert.equal(bridge1.api, api2);
    assert.equal(bridge1.stopped, false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr register takes over the same api with a new registry', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  // Defense-in-depth: the current host allocates a fresh api per generation.
  const api = createRegisterApiStub({ reuseRegistry: true });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-same-api-'));

  try {
    mod.default.register(api);
    const bridge1 = globalThis.__bncrBridge;
    assert.ok(bridge1);
    await api.services[0].stop();

    const nextRegistry = createRegisterApiStub({ reuseRegistry: true });
    api.registerService = nextRegistry.registerService;
    api.registerChannel = nextRegistry.registerChannel;
    api.registerGatewayMethod = nextRegistry.registerGatewayMethod;
    delete api[Symbol.for('bncr.register.meta')];
    mod.default.register(api);

    assert.equal(globalThis.__bncrBridge, bridge1);
    assert.equal(bridge1.api, api);
    assert.equal(api.services.length, 2);
    assert.equal(api.channels.length, 2);

    await api.services[1].start({ stateDir });
    assert.equal(bridge1.stopped, false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr register replaces the bridge after a runtime generation change', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-replaced-'));

  try {
    mod.default.register(api1);
    const bridge1 = globalThis.__bncrBridge;
    assert.ok(bridge1);

    getGatewayRuntimeState().lifecycle.active.bridgeGeneration.bridgeFactoryId = 'factory-next';
    getBridgeOwnerRecord(bridge1).bridgeFactoryId = 'factory-next';
    await api1.services[0].stop();

    mod.default.register(api2);
    const bridge2 = globalThis.__bncrBridge;
    assert.ok(bridge2);
    assert.notEqual(bridge2, bridge1);
    assert.equal(api2.services.length, 1);
    assert.equal(api2.channels.length, 1);
    assert.equal(api2.services[0].id, 'bncr-bridge-service');

    await api2.services[0].start({ stateDir });
    assert.equal(bridge2.stopped, false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr register rejects a bridge generation change for the same registration', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();

  try {
    mod.default.register(api);
    const bridge1 = globalThis.__bncrBridge;
    assert.ok(bridge1);

    getGatewayRuntimeState().lifecycle.active.bridgeGeneration.bridgeFactoryId = 'factory-next';
    getBridgeOwnerRecord(bridge1).bridgeFactoryId = 'factory-next';
    await api.services[0].stop();

    mod.default.register(api);
    const runtime = getGatewayRuntimeState();
    assert.equal(globalThis.__bncrBridge, bridge1);
    assert.equal(api.services.length, 1);
    assert.equal(api.channels.length, 1);
    assert.equal(runtime.lifecycle.active?.phase, 'stopped');
    assert.equal(runtime.lifecycle.pending, undefined);
  } finally {
    resetBncrRegisterGlobals();
  }
});

test('bncr register rejects a same-registration generation change while predecessor is stopping', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub({ reuseRegistry: true });
  let releaseStop;
  const stopGate = new Promise((resolve) => {
    releaseStop = resolve;
  });

  try {
    mod.default.register(api);
    const bridge1 = globalThis.__bncrBridge;
    assert.ok(bridge1);
    const runtime = getGatewayRuntimeState();
    runtime.lifecycle.active.bridgeGeneration.bridgeFactoryId = 'factory-next';
    getBridgeOwnerRecord(bridge1).bridgeFactoryId = 'factory-next';
    const predecessorDispatchers = {};
    runtime.gatewayMethodDispatchers = predecessorDispatchers;

    const originalStopService = bridge1.stopService;
    bridge1.stopService = async (...args) => {
      await stopGate;
      return originalStopService(...args);
    };

    const stopping = api.services[0].stop();
    mod.default.register(api);

    assert.equal(api.services.length, 1);
    assert.equal(api.channels.length, 1);
    assert.equal(runtime.lifecycle.pending, undefined);
    assert.equal(runtime.lifecycle.active?.phase, 'stopping');
    assert.equal(runtime.gatewayMethodDispatchers, predecessorDispatchers);

    releaseStop();
    await stopping;
    assert.equal(bridge1.stopped, true);
    assert.equal(runtime.lifecycle.active?.phase, 'stopped');
  } finally {
    releaseStop?.();
  }
});

test('bncr register rejects a pending same-registration code generation change', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub({ reuseRegistry: true });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-pending-replaced-'));
  let releaseStop;
  const stopGate = new Promise((resolve) => {
    releaseStop = resolve;
  });

  try {
    mod.default.register(api1);
    const bridge1 = globalThis.__bncrBridge;
    assert.ok(bridge1);
    const runtime = getGatewayRuntimeState();
    runtime.lifecycle.active.bridgeGeneration.bridgeFactoryId = 'factory-next';
    getBridgeOwnerRecord(bridge1).bridgeFactoryId = 'factory-next';
    const originalStopService = bridge1.stopService;
    bridge1.stopService = async (...args) => {
      await stopGate;
      return originalStopService(...args);
    };

    const stopping = api1.services[0].stop();
    mod.default.register(api2);
    assert.equal(runtime.lifecycle.pending?.key.generation, 2);
    const oldPendingStart = api2.services[0].start({ stateDir });
    await Promise.resolve();

    runtime.lifecycle.pending.bridgeGeneration.bridgeFactoryId = 'factory-next';
    mod.default.register(api2);

    assert.equal(api2.services.length, 1);
    assert.equal(api2.channels.length, 1);
    assert.equal(runtime.lifecycle.pending?.key.generation, 2);
    assert.equal(runtime.lifecycle.pending?.bridgeGeneration.bridgeFactoryId, 'factory-next');
    assert.equal(runtime.lifecycle.pendingMode, 'replace');

    releaseStop();
    await stopping;
    await oldPendingStart;
    const bridge2 = globalThis.__bncrBridge;
    assert.ok(bridge2);
    assert.notEqual(bridge2, bridge1);
    assert.equal(bridge2.api, api2);
    assert.equal(bridge2.stopped, false);
    assert.equal(runtime.lifecycle.active?.key.generation, 2);

    await api2.services[0].start({ stateDir });
    assert.equal(globalThis.__bncrBridge, bridge2);

    await api2.services[0].stop();
    assert.equal(bridge2.stopped, true);
  } finally {
    releaseStop?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr register rejects a successor after predecessor stop failure', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();

  mod.default.register(api1);
  const bridge1 = globalThis.__bncrBridge;
  assert.ok(bridge1);
  bridge1.stopService = async () => {
    throw new Error('stop failed');
  };

  await assert.rejects(api1.services[0].stop(), /stop failed/);
  mod.default.register(api2);

  assert.equal(globalThis.__bncrBridge, bridge1);
  assert.equal(api2.services.length, 0);
  assert.equal(api2.channels.length, 0);
  assert.equal(getGatewayRuntimeState().lifecycle.active.phase, 'failed');
});

test('bncr rejected registration gateway methods stay fail-closed', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();

  try {
    mod.default.register(api1);
    const runtime = getGatewayRuntimeState();
    const bridge = runtime.currentBridge;
    assert.ok(bridge);
    bridge.stopService = async () => {
      throw new Error('stop failed');
    };

    await assert.rejects(api1.services[0].stop(), /stop failed/);
    mod.default.register(api2);

    const meta = api2[Symbol.for('bncr.register.meta')];
    assert.ok(meta?.registryFingerprint);
    assert.equal(runtime.registryDeclarations.has(meta.registryFingerprint), false);
    bridge.handleConnect = () => ({ ok: true });
    assert.throws(
      () => getRegisteredMethod(api2, 'bncr.connect')({}),
      /lifecycle registry is inactive for bncr\.connect/,
    );
  } finally {
    resetBncrRegisterGlobals();
  }
});

test('bncr failed lifecycle blocks shadow registry gateway methods', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();

  try {
    mod.default.register(api1);
    mod.default.register(api2);
    const runtime = getGatewayRuntimeState();
    const bridge = runtime.currentBridge;
    assert.ok(bridge);
    bridge.handleConnect = () => ({ ok: true });
    assert.deepEqual(getRegisteredMethod(api2, 'bncr.connect')({}), { ok: true });

    bridge.stopService = async () => {
      throw new Error('stop failed');
    };
    await assert.rejects(api1.services[0].stop(), /stop failed/);

    assert.equal(runtime.lifecycle.active?.phase, 'failed');
    assert.throws(
      () => getRegisteredMethod(api2, 'bncr.connect')({}),
      /lifecycle registry is inactive for bncr\.connect/,
    );
  } finally {
    resetBncrRegisterGlobals();
  }
});

test('bncr late service start failure does not strand an in-flight stop', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-late-start-failure-'));
  let releaseStart;
  let releaseStop;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const stopGate = new Promise((resolve) => {
    releaseStop = resolve;
  });
  let notifyStartEntered;
  const startEntered = new Promise((resolve) => {
    notifyStartEntered = resolve;
  });

  try {
    mod.default.register(api);
    const bridge = globalThis.__bncrBridge;
    assert.ok(bridge);
    bridge.startService = async () => {
      notifyStartEntered();
      await startGate;
      throw new Error('late start failed');
    };
    bridge.stopService = async () => {
      await stopGate;
    };

    const starting = api.services[0].start({ stateDir });
    await startEntered;
    const stopping = api.services[0].stop();
    await Promise.resolve();
    releaseStart();

    await assert.rejects(starting, /late start failed/);
    assert.equal(getGatewayRuntimeState().lifecycle.active.phase, 'stopping');

    releaseStop();
    await stopping;
    assert.equal(getGatewayRuntimeState().lifecycle.active.phase, 'stopped');
  } finally {
    releaseStart?.();
    releaseStop?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr service start revalidates lifecycle ownership after async setup', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-start-revalidate-'));
  let triggerStop = false;

  try {
    mod.default.register(api);
    const bridge = globalThis.__bncrBridge;
    assert.ok(bridge);
    let startCalls = 0;
    bridge.startService = async () => {
      startCalls += 1;
    };
    bridge.stopService = async () => {};
    api.runtime.config.current = () => {
      if (!triggerStop) {
        triggerStop = true;
        void api.services[0].stop();
      }
      return api.currentConfig;
    };

    await api.services[0].start({ stateDir });

    assert.equal(startCalls, 0);
    assert.equal(getGatewayRuntimeState().lifecycle.active.phase, 'stopped');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr in-flight service start cannot resurrect a concurrently stopped lifecycle', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-start-stop-race-'));
  let releaseLoad;
  let notifyLoadEntered;
  const loadGate = new Promise((resolve) => {
    releaseLoad = resolve;
  });
  const loadEntered = new Promise((resolve) => {
    notifyLoadEntered = resolve;
  });

  try {
    mod.default.register(api);
    const bridge = globalThis.__bncrBridge;
    assert.ok(bridge);
    bridge.loadState = async () => {
      notifyLoadEntered();
      await loadGate;
    };

    const starting = api.services[0].start({ stateDir });
    await loadEntered;
    const stopping = api.services[0].stop();
    releaseLoad();
    await Promise.all([starting, stopping]);

    assert.equal(bridge.stopped, true);
    assert.equal(getGatewayRuntimeState().lifecycle.active?.phase, 'stopped');
  } finally {
    releaseLoad?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr service start cannot republish runtime state after a queued stop', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-start-stop-tail-'));
  let stopping;

  try {
    mod.default.register(api);
    const bridge = globalThis.__bncrBridge;
    assert.ok(bridge);
    bridge.stopService = async () => {
      bridge.stopped = true;
    };
    bridge.refreshDebugFlagFromConfig = () =>
      new Promise((resolve) => {
        queueMicrotask(() => {
          resolve(undefined);
          queueMicrotask(() => {
            stopping = api.services[0].stop();
          });
        });
      });

    const starting = api.services[0].start({ stateDir });
    await Promise.resolve();
    await stopping;
    await starting;

    assert.equal(bridge.stopped, true);
    assert.deepEqual(bridge.getRuntimeObservation(), {
      serviceRunning: false,
      channelRunning: false,
      activeChannelAccounts: 0,
    });
    assert.equal(getGatewayRuntimeState().lifecycle.active?.phase, 'stopped');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr register failure repairs lifecycle so the next registration can recover', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const brokenApi = createRegisterApiStub();
  const recoveryApi = createRegisterApiStub();

  try {
    brokenApi.registerChannel = () => {
      throw new Error('channel boom');
    };

    assert.throws(() => mod.default.register(brokenApi), /channel boom/);

    const runtime = getGatewayRuntimeState();
    // The failed generation stays bound but inert, which keeps the gateway
    // method fallback closed and lets the next registration take over.
    assert.equal(runtime.lifecycle.active?.phase, 'stopped');
    const failedDeclaration = [...runtime.registryDeclarations.values()].find(
      (entry) => entry.registration === 'failed',
    );
    assert.ok(failedDeclaration);
    assert.equal(failedDeclaration.service, 'declared');
    assert.equal(failedDeclaration.channel, 'missing');
    assert.equal(failedDeclaration.state, 'retired');

    // A failed scope is not silently re-declared. The host must create a new
    // registration scope; otherwise service first-wins would leave a stale
    // callback in place.
    assert.doesNotThrow(() => mod.default.register(brokenApi));
    assert.equal(brokenApi.services.length, 1);
    assert.equal(brokenApi.channels.length, 0);
    assert.equal(
      [...runtime.registryDeclarations.values()].find((entry) => entry.registration === 'failed')
        ?.registration,
      'failed',
    );

    mod.default.register(recoveryApi);
    assert.equal(recoveryApi.services.length, 1);
    assert.equal(recoveryApi.channels.length, 1);
    assert.equal(
      runtime.registryDeclarations.get(runtime.lifecycle.active.key.registryFingerprint)
        .registration,
      'complete',
    );
    assert.equal(runtime.lifecycle.active?.phase, 'active');
    assert.equal(runtime.lifecycle.pending, undefined);
  } finally {
    resetBncrRegisterGlobals();
  }
});

test('bncr failed registration callbacks cannot reactivate the recovered lifecycle', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-failed-callback-'));

  try {
    api.registerChannel = () => {
      throw new Error('channel boom');
    };

    assert.throws(() => mod.default.register(api), /channel boom/);
    const runtime = getGatewayRuntimeState();
    assert.equal(runtime.lifecycle.active?.phase, 'stopped');

    await api.services[0].start({ stateDir });

    assert.equal(runtime.lifecycle.active?.phase, 'stopped');
    assert.equal(runtime.currentBridge.getRuntimeObservation().serviceRunning, false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    resetBncrRegisterGlobals();
  }
});

test('bncr failed duplicate registration preserves the active observation', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();

  try {
    mod.default.register(api);
    const runtime = getGatewayRuntimeState();
    const registryFingerprint = runtime.lifecycle.active.key.registryFingerprint;
    const declaration = runtime.registryDeclarations.get(registryFingerprint);
    const phaseBeforeFailure = declaration.runtimeObservation.phase;
    runtime.currentBridge.noteRegister = () => {
      throw new Error('duplicate registration boom');
    };

    assert.throws(() => mod.default.register(api), /duplicate registration boom/);

    assert.equal(declaration.registration, 'complete');
    assert.equal(declaration.state, 'active');
    assert.equal(declaration.runtimeObservation.phase, phaseBeforeFailure);
    assert.equal(runtime.lifecycle.active?.phase, 'active');
  } finally {
    resetBncrRegisterGlobals();
  }
});

test('bncr register recovers when lifecycle commit fails after adoption', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const brokenApi = createRegisterApiStub();
  const recoveryApi = createRegisterApiStub();

  try {
    mod.default.register(api1);
    await api1.services[0].stop();

    const runtime = getGatewayRuntimeState();
    const registryDeclarations = runtime.registryDeclarations;
    const originalSet = registryDeclarations.set;
    let rejectNewDeclarations = false;
    registryDeclarations.set = function patchedSet(key, value) {
      if (rejectNewDeclarations && !this.has(key)) {
        throw new Error('commit boom');
      }
      return originalSet.call(this, key, value);
    };

    try {
      rejectNewDeclarations = true;
      assert.throws(() => mod.default.register(brokenApi), /commit boom/);
    } finally {
      rejectNewDeclarations = false;
      registryDeclarations.set = originalSet;
    }

    assert.equal(runtime.lifecycle.active?.phase, 'stopped');
    mod.default.register(recoveryApi);
    assert.equal(recoveryApi.services.length, 1);
    assert.equal(recoveryApi.channels.length, 1);
    assert.equal(runtime.lifecycle.active?.phase, 'active');
  } finally {
    resetBncrRegisterGlobals();
  }
});

test('bncr deferred successor fails visibly when predecessor stop fails', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-deferred-fail-'));

  try {
    mod.default.register(api1);
    const bridge1 = globalThis.__bncrBridge;
    assert.ok(bridge1);
    let releaseStop;
    const stopGate = new Promise((resolve) => {
      releaseStop = resolve;
    });
    bridge1.stopService = async () => {
      await stopGate;
      throw new Error('deferred stop failed');
    };

    const stopping = api1.services[0].stop();
    mod.default.register(api2);
    releaseStop();

    await assert.rejects(stopping, /deferred stop failed/);
    await assert.rejects(
      api2.services[0].start({ stateDir }),
      /predecessor stop failed: deferred stop failed/,
    );
    const runtime = getGatewayRuntimeState();
    const activeRegistry = runtime.lifecycle.active.key.registryFingerprint;
    const pendingRegistry = runtime.lifecycle.pending.key.registryFingerprint;
    assert.equal(pendingRegistry.length > 0, true);
    assert.equal(runtime.registryDeclarations.get(activeRegistry).state, 'retired');
    assert.equal(runtime.registryDeclarations.get(pendingRegistry).state, 'retired');

    runtime.lifecycle.pending.bridgeGeneration.bridgeFactoryId = 'factory-after-failure';
    mod.default.register(api2);
    assert.equal(api2.services.length, 1);
    assert.equal(api2.channels.length, 1);
    assert.equal(runtime.lifecycle.pending?.key.generation, 2);
    assert.equal(
      runtime.lifecycle.pending?.bridgeGeneration.bridgeFactoryId,
      'factory-after-failure',
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr successor service start failure marks lifecycle failed', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();

  mod.default.register(api1);
  const bridge1 = globalThis.__bncrBridge;
  assert.ok(bridge1);
  await api1.services[0].stop();
  mod.default.register(api2);
  bridge1.startService = async () => {
    throw new Error('successor start failed');
  };

  await assert.rejects(
    api2.services[0].start({ stateDir: '/tmp/bncr-unused-state' }),
    /successor start failed/,
  );
  assert.equal(getGatewayRuntimeState().lifecycle.active.phase, 'failed');
});

test('bncr stale service start cannot start a successor bridge', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-stale-start-'));

  try {
    mod.default.register(api1);
    const bridge1 = globalThis.__bncrBridge;
    assert.ok(bridge1);
    const originalStartService = bridge1.startService;
    let startServiceCalls = 0;
    bridge1.startService = async (...args) => {
      startServiceCalls += 1;
      return originalStartService(...args);
    };

    await api1.services[0].stop();
    mod.default.register(api2);
    await api2.services[0].start({ stateDir });
    assert.equal(startServiceCalls, 1);
    assert.equal(bridge1.api, api2);

    await api1.services[0].start({ stateDir });
    assert.equal(startServiceCalls, 1);
    assert.equal(bridge1.api, api2);
    assert.equal(bridge1.stopped, false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr stale channel stop cannot stop a successor bridge', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-stale-stop-'));

  try {
    mod.default.register(api1);
    const bridge1 = globalThis.__bncrBridge;
    assert.ok(bridge1);
    let channelStopCalls = 0;
    bridge1.channelStopAccount = async () => {
      channelStopCalls += 1;
    };

    await api1.services[0].stop();
    mod.default.register(api2);
    await api2.services[0].start({ stateDir });

    await api1.channels[0].plugin.gateway.stopAccount({ accountId: 'Primary' });
    assert.equal(channelStopCalls, 0);

    await api2.channels[0].plugin.gateway.stopAccount({ accountId: 'Primary' });
    assert.equal(channelStopCalls, 1);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr register supports consecutive lifecycle successors', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();
  const api3 = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-consecutive-'));

  try {
    mod.default.register(api1);
    const bridge1 = globalThis.__bncrBridge;
    assert.ok(bridge1);

    await api1.services[0].stop();
    mod.default.register(api2);
    await api2.services[0].start({ stateDir });
    assert.equal(bridge1.api, api2);

    await api2.services[0].stop();
    mod.default.register(api3);
    await api3.services[0].start({ stateDir });

    assert.equal(globalThis.__bncrBridge, bridge1);
    assert.equal(bridge1.api, api3);
    assert.equal(api3.services.length, 1);
    assert.equal(api3.channels.length, 1);
    assert.equal(bridge1.stopped, false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr successor service start resumes a pending outbox drain', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-register-outbox-resume-'));

  try {
    mod.default.register(api1);
    const bridge1 = globalThis.__bncrBridge;
    assert.ok(bridge1);
    await api1.services[0].stop();
    mod.default.register(api2);

    bridge1.loadState = async () => {};
    bridge1.outbox.set('pending-1', {
      messageId: 'pending-1',
      accountId: 'Primary',
      attempts: 0,
    });
    bridge1.connections.set('connection-1', { accountId: 'Primary' });
    const scheduledDelays = [];
    bridge1.schedulePushDrain = (delayMs) => {
      scheduledDelays.push(delayMs);
    };

    await api2.services[0].start({ stateDir });

    assert.deepEqual(scheduledDelays, [0]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('bncr register keeps registry lifecycle state bounded', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const firstApi = createRegisterApiStub();
  mod.default.register(firstApi);

  for (let index = 0; index < 80; index += 1) {
    mod.default.register(createRegisterApiStub());
  }

  const runtime = getGatewayRuntimeState();
  const registerTrace = process[GLOBAL_REGISTER_TRACE_SYMBOL];
  assert.ok(runtime.registryDeclarations.size <= 6);
  assert.ok(runtime.registeredMethodsByRegistry.size <= 6);
  assert.ok(registerTrace.seenApiInstanceIds.size <= 64);
  assert.ok(registerTrace.seenRegistryFingerprints.size <= 64);
  assert.equal(
    runtime.registryDeclarations.get(runtime.lifecycle.active.key.registryFingerprint).state,
    'active',
  );
});

test('bncr miniconfig uses transactional mutateConfigFile', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub({ currentConfig: {} });
  mod.default.register(api);

  let commandAction;
  const program = {
    command(name) {
      assert.equal(name, 'bncr');
      return {
        description() {
          return this;
        },
        command(subcommandName) {
          assert.equal(subcommandName, 'miniconfig');
          return {
            description() {
              return this;
            },
            action(fn) {
              commandAction = fn;
              return this;
            },
          };
        },
      };
    },
  };

  api.cli.register({ program });
  assert.equal(typeof commandAction, 'function');
  await commandAction();

  assert.equal(api.writeCalls.length, 0);
  assert.equal(api.mutateCalls.length, 1);
  assert.deepEqual(api.mutateCalls[0].afterWrite, { mode: 'auto' });
  assert.deepEqual(api.currentConfig.channels.bncr, { enabled: true, allowTool: false });
});

test('bncr registers channel.message as the channel-owned handoff adapter without durableFinal', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);
  const channel = api.channels[0]?.plugin;

  assert.ok(channel);
  assert.equal(channel.message?.receive?.defaultAckPolicy, 'manual');
  assert.deepEqual(channel.message?.receive?.supportedAckPolicies, ['manual']);
  assert.equal(typeof channel.message?.send?.text, 'function');
  assert.equal(typeof channel.message?.send?.media, 'function');
  assert.equal(typeof channel.message?.send?.payload, 'function');
  assert.equal(typeof channel.actions?.supportsAction, 'function');
  assert.equal(typeof channel.actions?.handleAction, 'function');
  assert.equal(channel.message?.durableFinal, undefined);
  assert.equal(channel.durableFinal, undefined);
  assert.equal(channel.capabilities?.durableFinal, undefined);
});

test('bncr messaging exposes parse/display/session target helpers on the owning api channel plugin', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const channel = api.channels[0]?.plugin;
  assert.ok(channel);
  assert.equal(typeof channel.messaging?.parseExplicitTarget, 'function');
  assert.equal(typeof channel.messaging?.formatTargetDisplay, 'function');
  assert.equal(typeof channel.messaging?.resolveSessionTarget, 'function');
  assert.equal(typeof channel.message?.send?.text, 'function');
  assert.equal(typeof channel.actions?.supportsAction, 'function');
  assert.equal(typeof channel.actions?.handleAction, 'function');
  assert.equal(channel.message?.durableFinal, undefined);
  assert.equal(channel.durableFinal, undefined);
  assert.equal(channel.capabilities?.durableFinal, undefined);

  const direct = channel.messaging.parseExplicitTarget({ raw: 'Bncr:tgBot:0:10001' });
  assert.ok(direct);
  assert.equal(direct.displayScope, 'Bncr:tgBot:0:10001');
  const directLegacy = channel.messaging.parseExplicitTarget({ raw: 'Bncr:tgBot:10001' });
  assert.ok(directLegacy);
  assert.equal(directLegacy.displayScope, 'Bncr:tgBot:0:10001');
  const directAlias = channel.messaging.parseExplicitTarget({ raw: 'Bncr:tgBot:User:10001' });
  assert.ok(directAlias);
  assert.equal(directAlias.displayScope, 'Bncr:tgBot:0:10001');

  const group = channel.messaging.parseExplicitTarget({
    raw: 'Bncr:tgBot:Group:-1001',
  });
  assert.ok(group);
  assert.equal(group.displayScope, 'Bncr:tgBot:-1001:0');
  assert.equal(channel.messaging.formatTargetDisplay({ target: group }), 'Bncr:tgBot:Group:-1001');
  assert.equal(
    channel.messaging.resolveSessionTarget({ id: 'Bncr:tgBot:0:10001' }),
    'Bncr:tgBot:0:10001',
  );
  assert.equal(
    channel.messaging.resolveSessionTarget({ id: 'Bncr:tgBot:10001' }),
    'Bncr:tgBot:0:10001',
  );
  assert.equal(
    channel.messaging.formatTargetDisplay({ target: 'Bncr:tgBot:Group:-1001' }),
    'Bncr:tgBot:Group:-1001',
  );

  const outboundSessionRoute = channel.messaging.resolveOutboundSessionRoute({
    cfg: {},
    agentId: 'orion',
    accountId: 'Primary',
    target: 'Bncr:tgBot:0:10001',
    threadId: 123,
  });
  assert.ok(outboundSessionRoute);
  assert.equal(outboundSessionRoute.channel, 'bncr');
  assert.deepEqual(outboundSessionRoute.thread, { id: '123' });

  const resolvedTarget = await channel.messaging.targetResolver.resolveTarget({
    cfg: {},
    accountId: null,
    input: 'Bncr:tgBot:0:10001',
    normalized: 'Bncr:tgBot:0:10001',
  });
  assert.deepEqual(resolvedTarget, {
    to: 'Bncr:tgBot:0:10001',
    kind: 'user',
    display: 'Bncr:tgBot:User:10001',
    source: 'normalized',
  });

  const resolvedLegacyDirectTarget = await channel.messaging.targetResolver.resolveTarget({
    cfg: {},
    accountId: null,
    input: 'Bncr:tgBot:10001',
    normalized: 'Bncr:tgBot:10001',
  });
  assert.deepEqual(resolvedLegacyDirectTarget, {
    to: 'Bncr:tgBot:0:10001',
    kind: 'user',
    display: 'Bncr:tgBot:User:10001',
    source: 'normalized',
  });

  const resolvedGroupTarget = await channel.messaging.targetResolver.resolveTarget({
    cfg: {},
    accountId: null,
    input: 'Bncr:tgBot:Group:-1001',
    normalized: 'Bncr:tgBot:Group:-1001',
  });
  assert.deepEqual(resolvedGroupTarget, {
    to: 'Bncr:tgBot:-1001:0',
    kind: 'group',
    display: 'Bncr:tgBot:Group:-1001',
    source: 'normalized',
  });
});
