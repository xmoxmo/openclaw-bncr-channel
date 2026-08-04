import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrGatewayMethodRegistry } from '../../src/bootstrap/register-runtime-gateway.ts';
import { createBncrBridgeSingletonManager } from '../../src/bootstrap/register-runtime-singleton.ts';
import { withConsoleCapture } from '../helpers/console-capture.mjs';

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
