import test from 'node:test';
import assert from 'node:assert/strict';

function createApi() {
  const logs = [];
  return {
    runtime: {
      config: {
        async loadConfig() {
          return { channels: { bncr: { debug: { verbose: false } } } };
        },
        get() {
          return { channels: { bncr: { debug: { verbose: false } } } };
        },
      },
      channel: {
        media: {
          async saveMediaBuffer(buffer, mimeType, direction, maxBytes, fileName) {
            return { path: `/tmp/${fileName || 'file.bin'}`, size: buffer.length, mimeType, direction, maxBytes };
          },
        },
        routing: {
          resolveAgentRoute() {
            return { sessionKey: 'agent:main:bncr:direct:66616b65' };
          },
        },
      },
    },
    logger: {
      info(...args) { logs.push(['info', ...args]); },
      warn(...args) { logs.push(['warn', ...args]); },
      error(...args) { logs.push(['error', ...args]); },
    },
    logs,
    services: [],
    channels: [],
    methods: [],
    registerService(def) {
      this.services.push(def);
    },
    registerChannel(def) {
      this.channels.push(def);
    },
    registerGatewayMethod(name, handler) {
      this.methods.push({ name, handler });
    },
  };
}

function createRespondCapture() {
  const calls = [];
  const respond = (...args) => calls.push(args);
  return { respond, calls };
}

function getMethod(api, name) {
  const item = api.methods.find((m) => m.name === name);
  assert.ok(item, `expected method ${name}`);
  return item.handler;
}

test('bncr.connect exposes lease/epoch and diagnostics include hardening fields', async () => {
  const mod = await import('../index.ts');
  const api = createApi();
  mod.default.register(api);

  const connect = getMethod(api, 'bncr.connect');
  const { respond, calls } = createRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond,
    client: { connId: 'conn-a' },
    context: { broadcastToConnIds() {} },
  });

  assert.equal(calls.length, 1);
  const [ok, payload] = calls[0];
  assert.equal(ok, true);
  assert.ok(payload.leaseId);
  assert.equal(typeof payload.connectionEpoch, 'number');
  assert.equal(payload.protocolVersion, 2);
  assert.ok(payload.bridgeId);
  assert.ok(payload.diagnostics.register);
  assert.ok(payload.diagnostics.connection);
  assert.ok(payload.diagnostics.protocol);
  assert.ok(payload.diagnostics.stale);
});

test('bncr diagnostics register info updates after api rebind', async () => {
  delete globalThis.__bncrBridge;
  const mod = await import('../index.ts');
  const api1 = createApi();
  const api2 = createApi();
  const originalNow = Date.now;
  let fakeNow = originalNow() + 60_000;
  Date.now = () => {
    fakeNow += 31_000;
    return fakeNow;
  };

  try {
    mod.default.register(api1);
    mod.default.register(api2);
  } finally {
    Date.now = originalNow;
  }

  const diagnostics = getMethod(api2, 'bncr.diagnostics');
  const { respond, calls } = createRespondCapture();
  await diagnostics({ params: { accountId: 'Primary' }, respond });

  const [ok, payload] = calls[0];
  assert.equal(ok, true);
  assert.ok(payload.diagnostics.register.registerCount >= 2);
  assert.ok(payload.diagnostics.register.apiGeneration >= 1);
  assert.equal(typeof payload.diagnostics.register.apiInstanceId, 'string');
  assert.equal(typeof payload.diagnostics.register.registryFingerprint, 'string');
  assert.ok(Array.isArray(payload.diagnostics.register.traceRecent));
  assert.ok(payload.diagnostics.register.traceRecent.length >= 1);
  assert.equal(typeof payload.diagnostics.register.traceRecent[0].stackBucket, 'string');
  assert.equal(typeof payload.diagnostics.register.traceRecent[0].apiInstanceId, 'string');
  assert.equal(typeof payload.diagnostics.register.traceRecent[0].registryFingerprint, 'string');
  assert.ok(payload.diagnostics.register.traceSummary);
  assert.equal(payload.diagnostics.register.traceSummary.traceWindowSize, payload.diagnostics.register.traceRecent.length);
  assert.equal(typeof payload.diagnostics.register.traceSummary.startupWindowMs, 'number');
  assert.equal(typeof payload.diagnostics.register.traceSummary.unexpectedRegisterAfterWarmup, 'boolean');
  assert.ok(payload.diagnostics.register.traceSummary.sourceBuckets);
  assert.equal(typeof payload.diagnostics.register.traceSummary.dominantBucket, 'string');
  assert.equal(typeof payload.diagnostics.register.traceSummary.likelyRuntimeRegistryDrift, 'boolean');
  assert.equal(typeof payload.diagnostics.register.traceSummary.likelyStartupFanoutOnly, 'boolean');
  assert.equal(payload.diagnostics.register.traceSummary.likelyRuntimeRegistryDrift, true);
  assert.ok(payload.diagnostics.register.lastDriftSnapshot);
  assert.equal(typeof payload.diagnostics.register.lastDriftSnapshot.dominantBucket, 'string');
  assert.ok(Array.isArray(payload.diagnostics.register.lastDriftSnapshot.traceRecent));
  assert.notEqual(payload.diagnostics.register.traceRecent[0].apiInstanceId, payload.diagnostics.register.traceRecent[payload.diagnostics.register.traceRecent.length - 1].apiInstanceId);
  assert.notEqual(payload.diagnostics.register.traceRecent[0].registryFingerprint, payload.diagnostics.register.traceRecent[payload.diagnostics.register.traceRecent.length - 1].registryFingerprint);
  assert.ok(api2.logs.some((entry) => entry.some((part) => String(part).includes('[bncr-register-trace]'))));
});

test('stale lease observation increments counters without hard failure', async () => {
  const mod = await import('../index.ts');
  const api = createApi();
  mod.default.register(api);

  const connect = getMethod(api, 'bncr.connect');
  const activity = getMethod(api, 'bncr.activity');
  const diagnostics = getMethod(api, 'bncr.diagnostics');

  const c1 = createRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c1.respond,
    client: { connId: 'conn-a' },
    context: { broadcastToConnIds() {} },
  });
  const lease1 = c1.calls[0][1].leaseId;
  const epoch1 = c1.calls[0][1].connectionEpoch;

  const c2 = createRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-b' },
    respond: c2.respond,
    client: { connId: 'conn-b' },
    context: { broadcastToConnIds() {} },
  });

  const act = createRespondCapture();
  await activity({
    params: { accountId: 'Primary', clientId: 'client-a', leaseId: lease1, connectionEpoch: epoch1 },
    respond: act.respond,
    client: { connId: 'conn-a' },
    context: { broadcastToConnIds() {} },
  });
  assert.equal(act.calls[0][0], true);

  const diag = createRespondCapture();
  await diagnostics({ params: { accountId: 'Primary' }, respond: diag.respond });
  const stale = diag.calls[0][1].diagnostics.stale;
  assert.equal(stale.staleActivity, 1);
});
