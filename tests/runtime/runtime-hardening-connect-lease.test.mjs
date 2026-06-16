import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  createGatewayRespondCapture,
  createRegisterApiStub,
  getRegisteredMethod,
  resetBncrRegisterGlobals,
} from '../helpers/register-api.mjs';
import { withFakeNow } from '../helpers/time-control.mjs';

afterEach(() => {
  const bridge = globalThis.__bncrBridge;
  if (bridge && typeof bridge.shutdown === 'function') {
    bridge.shutdown();
  }
  resetBncrRegisterGlobals();
});

test('bncr.connect exposes lease/epoch and diagnostics include hardening fields', async () => {
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const connect = getRegisteredMethod(api, 'bncr.connect');
  const { respond, calls } = createGatewayRespondCapture();
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
  assert.deepEqual(payload.diagnostics.runtimeSurface.runtime, {
    config: true,
    media: true,
  });
  assert.deepEqual(payload.diagnostics.runtimeSurface.channel, {
    inbound: true,
    media: true,
    reply: true,
    routing: true,
    session: true,
  });
  assert.deepEqual(payload.diagnostics.runtimeSurface.channelMedia, {
    readRemoteMediaBuffer: true,
    saveMediaBuffer: true,
  });
  assert.equal(payload.diagnostics.runtimeSurface.contract['runtime.config.current|get'], true);
  assert.equal(
    payload.diagnostics.runtimeSurface.contract[
      'runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher'
    ],
    true,
  );
  assert.deepEqual(payload.diagnostics.runtimeSurface.missing, []);
  assert.equal(payload.runtimeFlags.outboundRequireAck, true);
  assert.equal(payload.runtimeFlags.ackPolicySource, 'default');
  assert.equal(typeof payload.waiters.messageAck, 'number');
  assert.equal(typeof payload.waiters.fileAck, 'number');
});

test('bncr diagnostics register info updates after api rebind', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api1 = createRegisterApiStub();
  const api2 = createRegisterApiStub();
  await withFakeNow(
    (() => {
      let fakeNow = Date.now() + 60_000;
      return () => {
        fakeNow += 31_000;
        return fakeNow;
      };
    })(),
    async () => {
      mod.default.register(api1);
      mod.default.register(api2);
    },
  );

  const diagnostics = getRegisteredMethod(api2, 'bncr.diagnostics');
  const { respond, calls } = createGatewayRespondCapture();
  await diagnostics({ params: { accountId: 'Primary' }, respond });

  const [ok, payload] = calls[0];
  assert.equal(ok, true);
  assert.deepEqual(payload.diagnostics.runtimeSurface.runtime, {
    config: true,
    media: true,
  });
  assert.deepEqual(payload.diagnostics.runtimeSurface.channel, {
    inbound: true,
    media: true,
    reply: true,
    routing: true,
    session: true,
  });
  assert.deepEqual(payload.diagnostics.runtimeSurface.channelMedia, {
    readRemoteMediaBuffer: true,
    saveMediaBuffer: true,
  });
  assert.equal(payload.diagnostics.runtimeSurface.contract['runtime.config.current|get'], true);
  assert.deepEqual(payload.diagnostics.runtimeSurface.missing, []);
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
  assert.equal(
    payload.diagnostics.register.traceSummary.traceWindowSize,
    payload.diagnostics.register.traceRecent.length,
  );
  assert.equal(typeof payload.diagnostics.register.traceSummary.startupWindowMs, 'number');
  assert.equal(
    typeof payload.diagnostics.register.traceSummary.unexpectedRegisterAfterWarmup,
    'boolean',
  );
  assert.ok(payload.diagnostics.register.traceSummary.sourceBuckets);
  assert.equal(typeof payload.diagnostics.register.traceSummary.dominantBucket, 'string');
  assert.equal(
    typeof payload.diagnostics.register.traceSummary.likelyRuntimeRegistryDrift,
    'boolean',
  );
  assert.equal(typeof payload.diagnostics.register.traceSummary.likelyStartupFanoutOnly, 'boolean');
  assert.equal(payload.diagnostics.register.traceSummary.likelyRuntimeRegistryDrift, true);
  assert.ok(payload.diagnostics.register.lastDriftSnapshot);
  assert.equal(typeof payload.diagnostics.register.lastDriftSnapshot.dominantBucket, 'string');
  assert.ok(Array.isArray(payload.diagnostics.register.lastDriftSnapshot.traceRecent));
  assert.notEqual(
    payload.diagnostics.register.traceRecent[0].apiInstanceId,
    payload.diagnostics.register.traceRecent[payload.diagnostics.register.traceRecent.length - 1]
      .apiInstanceId,
  );
  assert.notEqual(
    payload.diagnostics.register.traceRecent[0].registryFingerprint,
    payload.diagnostics.register.traceRecent[payload.diagnostics.register.traceRecent.length - 1]
      .registryFingerprint,
  );
  assert.equal(
    api2.logs.some((entry) => entry.some((part) => String(part).includes('[bncr-register-trace]'))),
    false,
  );
  assert.equal(payload.runtimeFlags.outboundRequireAck, true);
  assert.equal(payload.runtimeFlags.ackPolicySource, 'default');
  assert.equal(typeof payload.waiters.messageAck, 'number');
  assert.equal(typeof payload.waiters.fileAck, 'number');
});

test('stale lease observation increments counters without hard failure', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const connect = getRegisteredMethod(api, 'bncr.connect');
  const activity = getRegisteredMethod(api, 'bncr.activity');
  const diagnostics = getRegisteredMethod(api, 'bncr.diagnostics');

  const c1 = createGatewayRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c1.respond,
    client: { connId: 'conn-a' },
    context: { broadcastToConnIds() {} },
  });
  const lease1 = c1.calls[0][1].leaseId;
  const epoch1 = c1.calls[0][1].connectionEpoch;

  const c2 = createGatewayRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-b' },
    respond: c2.respond,
    client: { connId: 'conn-b' },
    context: { broadcastToConnIds() {} },
  });

  const act = createGatewayRespondCapture();
  await activity({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      leaseId: lease1,
      connectionEpoch: epoch1,
    },
    respond: act.respond,
    client: { connId: 'conn-a' },
    context: { broadcastToConnIds() {} },
  });
  assert.equal(act.calls[0][0], true);
  assert.equal(act.calls[0][1].stale, true);
  assert.equal(act.calls[0][1].ignored, true);

  const diag = createGatewayRespondCapture();
  await diagnostics({ params: { accountId: 'Primary' }, respond: diag.respond });
  const stale = diag.calls[0][1].diagnostics.stale;
  assert.equal(stale.staleActivity, 1);
});

test('stale activity from an older lease must not rewrite active connId for the same clientId', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const connect = getRegisteredMethod(api, 'bncr.connect');
  const activity = getRegisteredMethod(api, 'bncr.activity');

  const c1 = createGatewayRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c1.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });
  const lease1 = c1.calls[0][1].leaseId;
  const epoch1 = c1.calls[0][1].connectionEpoch;

  const c2 = createGatewayRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c2.respond,
    client: { connId: 'conn-new' },
    context: { broadcastToConnIds() {} },
  });

  const bridge = globalThis.__bncrBridge;
  assert.equal(bridge.activeConnectionByAccount.get('Primary'), 'Primary::client-a');
  assert.equal(bridge.connections.get('Primary::client-a').connId, 'conn-new');

  const staleAct = createGatewayRespondCapture();
  await activity({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      leaseId: lease1,
      connectionEpoch: epoch1,
    },
    respond: staleAct.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });

  assert.equal(staleAct.calls[0][0], true);
  assert.equal(staleAct.calls[0][1].stale, true);
  assert.equal(staleAct.calls[0][1].ignored, true);
  assert.equal(bridge.activeConnectionByAccount.get('Primary'), 'Primary::client-a');
  assert.equal(bridge.connections.get('Primary::client-a').connId, 'conn-new');
});
