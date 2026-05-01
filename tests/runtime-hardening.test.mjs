import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

afterEach(() => {
  const bridge = globalThis.__bncrBridge;
  if (bridge && typeof bridge.shutdown === 'function') {
    bridge.shutdown();
  }
});

function createApi() {
  const logs = [];
  const currentConfig = { channels: { bncr: { debug: { verbose: false } } } };
  return {
    runtime: {
      config: {
        current() {
          return currentConfig;
        },
        async loadConfig() {
          return currentConfig;
        },
        get() {
          return currentConfig;
        },
      },
      channel: {
        media: {
          async saveMediaBuffer(buffer, mimeType, direction, maxBytes, fileName) {
            return {
              path: `/tmp/${fileName || 'file.bin'}`,
              size: buffer.length,
              mimeType,
              direction,
              maxBytes,
            };
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
      info(...args) {
        logs.push(['info', ...args]);
      },
      warn(...args) {
        logs.push(['warn', ...args]);
      },
      error(...args) {
        logs.push(['error', ...args]);
      },
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
  assert.equal(payload.runtimeFlags.outboundRequireAck, true);
  assert.equal(payload.runtimeFlags.ackPolicySource, 'default');
  assert.equal(typeof payload.waiters.messageAck, 'number');
  assert.equal(typeof payload.waiters.fileAck, 'number');
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
  delete globalThis.__bncrBridge;
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

  const diag = createRespondCapture();
  await diagnostics({ params: { accountId: 'Primary' }, respond: diag.respond });
  const stale = diag.calls[0][1].diagnostics.stale;
  assert.equal(stale.staleActivity, 1);
});

test('stale activity from an older lease must not rewrite active connId for the same clientId', async () => {
  delete globalThis.__bncrBridge;
  const mod = await import('../index.ts');
  const api = createApi();
  mod.default.register(api);

  const connect = getMethod(api, 'bncr.connect');
  const activity = getMethod(api, 'bncr.activity');

  const c1 = createRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c1.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });
  const lease1 = c1.calls[0][1].leaseId;
  const epoch1 = c1.calls[0][1].connectionEpoch;

  const c2 = createRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c2.respond,
    client: { connId: 'conn-new' },
    context: { broadcastToConnIds() {} },
  });

  const bridge = globalThis.__bncrBridge;
  assert.equal(bridge.activeConnectionByAccount.get('Primary'), 'Primary::client-a');
  assert.equal(bridge.connections.get('Primary::client-a').connId, 'conn-new');

  const staleAct = createRespondCapture();
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

test('stale ack from last pushed owner should still ack message without rewriting active conn', async () => {
  delete globalThis.__bncrBridge;
  const mod = await import('../index.ts');
  const api = createApi();
  mod.default.register(api);

  const connect = getMethod(api, 'bncr.connect');
  const ack = getMethod(api, 'bncr.ack');

  const c1 = createRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c1.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });
  const lease1 = c1.calls[0][1].leaseId;
  const epoch1 = c1.calls[0][1].connectionEpoch;

  const bridge = globalThis.__bncrBridge;

  const c2 = createRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c2.respond,
    client: { connId: 'conn-new' },
    context: { broadcastToConnIds() {} },
  });

  bridge.outbox.set('msg-1', {
    messageId: 'msg-1',
    accountId: 'Primary',
    sessionKey: 'agent:main:bncr:direct:66616b65',
    route: { platform: 'tgBot', groupId: '0', userId: 'u1' },
    payload: { type: 'message.outbound', message: { msg: 'hello' } },
    createdAt: Date.now(),
    retryCount: 0,
    nextAttemptAt: Date.now(),
    lastPushConnId: 'conn-old',
    lastPushClientId: 'client-a',
  });

  assert.equal(bridge.connections.get('Primary::client-a').connId, 'conn-new');

  const staleAck = createRespondCapture();
  await ack({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      messageId: 'msg-1',
      ok: true,
      leaseId: lease1,
      connectionEpoch: epoch1,
    },
    respond: staleAck.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });

  assert.equal(staleAck.calls[0][0], true);
  assert.equal(staleAck.calls[0][1].ok, true);
  assert.equal(staleAck.calls[0][1].stale, true);
  assert.equal(staleAck.calls[0][1].staleAccepted, true);
  assert.equal(bridge.outbox.has('msg-1'), false);
  assert.equal(bridge.connections.get('Primary::client-a').connId, 'conn-new');
});

test('stale ack from non-owner should stay ignored', async () => {
  delete globalThis.__bncrBridge;
  const mod = await import('../index.ts');
  const api = createApi();
  mod.default.register(api);

  const connect = getMethod(api, 'bncr.connect');
  const ack = getMethod(api, 'bncr.ack');

  const c1 = createRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c1.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });
  const lease1 = c1.calls[0][1].leaseId;
  const epoch1 = c1.calls[0][1].connectionEpoch;

  const bridge = globalThis.__bncrBridge;
  bridge.outbox.set('msg-2', {
    messageId: 'msg-2',
    accountId: 'Primary',
    sessionKey: 'agent:main:bncr:direct:66616b65',
    route: { platform: 'tgBot', groupId: '0', userId: 'u2' },
    payload: { type: 'message.outbound', message: { msg: 'world' } },
    createdAt: Date.now(),
    retryCount: 0,
    nextAttemptAt: Date.now(),
    lastPushConnId: 'conn-someone-else',
    lastPushClientId: 'client-b',
  });

  const c2 = createRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c2.respond,
    client: { connId: 'conn-new' },
    context: { broadcastToConnIds() {} },
  });

  const staleAck = createRespondCapture();
  await ack({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      messageId: 'msg-2',
      ok: true,
      leaseId: lease1,
      connectionEpoch: epoch1,
    },
    respond: staleAck.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });

  assert.equal(staleAck.calls[0][0], true);
  assert.equal(staleAck.calls[0][1].stale, true);
  assert.equal(staleAck.calls[0][1].ignored, true);
  assert.equal(bridge.outbox.has('msg-2'), true);
});

test('stale file chunk and complete from owner should continue transfer without rewriting active conn', async () => {
  delete globalThis.__bncrBridge;
  const mod = await import('../index.ts');
  const api = createApi();
  mod.default.register(api);

  const connect = getMethod(api, 'bncr.connect');
  const fileInit = getMethod(api, 'bncr.file.init');
  const fileChunk = getMethod(api, 'bncr.file.chunk');
  const fileComplete = getMethod(api, 'bncr.file.complete');

  const c1 = createRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c1.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });
  const lease1 = c1.calls[0][1].leaseId;
  const epoch1 = c1.calls[0][1].connectionEpoch;

  const sessionKey1 = `agent:main:bncr:direct:${Buffer.from('tgBot:0:u-file').toString('hex')}`;
  const init = createRespondCapture();
  await fileInit({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      leaseId: lease1,
      connectionEpoch: epoch1,
      transferId: 'tf-1',
      sessionKey: sessionKey1,
      platform: 'tgBot',
      groupId: '0',
      userId: 'u-file',
      fileName: 'demo.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
      fileSha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    },
    respond: init.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });
  assert.equal(init.calls[0][0], true);

  const c2 = createRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c2.respond,
    client: { connId: 'conn-new' },
    context: { broadcastToConnIds() {} },
  });

  const bridge = globalThis.__bncrBridge;
  assert.equal(bridge.connections.get('Primary::client-a').connId, 'conn-new');

  const chunk = createRespondCapture();
  await fileChunk({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      leaseId: lease1,
      connectionEpoch: epoch1,
      transferId: 'tf-1',
      chunkIndex: 0,
      offset: 0,
      size: 5,
      chunkSha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      base64: Buffer.from('hello').toString('base64'),
    },
    respond: chunk.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });
  assert.equal(chunk.calls[0][0], true);
  assert.equal(chunk.calls[0][1].stale, true);
  assert.equal(chunk.calls[0][1].staleAccepted, true);

  const complete = createRespondCapture();
  await fileComplete({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      leaseId: lease1,
      connectionEpoch: epoch1,
      transferId: 'tf-1',
    },
    respond: complete.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });
  assert.equal(complete.calls[0][0], true);
  assert.equal(complete.calls[0][1].ok, true);
  assert.equal(complete.calls[0][1].stale, true);
  assert.equal(complete.calls[0][1].staleAccepted, true);
  assert.equal(bridge.fileRecvTransfers.get('tf-1').status, 'completed');
  assert.equal(bridge.connections.get('Primary::client-a').connId, 'conn-new');
});

test('stale file chunk from non-owner should stay ignored', async () => {
  delete globalThis.__bncrBridge;
  const mod = await import('../index.ts');
  const api = createApi();
  mod.default.register(api);

  const connect = getMethod(api, 'bncr.connect');
  const fileInit = getMethod(api, 'bncr.file.init');
  const fileChunk = getMethod(api, 'bncr.file.chunk');

  const c1 = createRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c1.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });
  const lease1 = c1.calls[0][1].leaseId;
  const epoch1 = c1.calls[0][1].connectionEpoch;

  const sessionKey2 = `agent:main:bncr:direct:${Buffer.from('tgBot:0:u-file2').toString('hex')}`;
  const init = createRespondCapture();
  await fileInit({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      leaseId: lease1,
      connectionEpoch: epoch1,
      transferId: 'tf-2',
      sessionKey: sessionKey2,
      platform: 'tgBot',
      groupId: '0',
      userId: 'u-file2',
      fileName: 'demo2.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
      fileSha256: '486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7',
    },
    respond: init.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });

  const c2 = createRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c2.respond,
    client: { connId: 'conn-new' },
    context: { broadcastToConnIds() {} },
  });

  const bridge = globalThis.__bncrBridge;
  const st = bridge.fileRecvTransfers.get('tf-2');
  st.ownerConnId = 'conn-someone-else';
  st.ownerClientId = 'client-b';
  bridge.fileRecvTransfers.set('tf-2', st);

  const chunk = createRespondCapture();
  await fileChunk({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      leaseId: lease1,
      connectionEpoch: epoch1,
      transferId: 'tf-2',
      chunkIndex: 0,
      offset: 0,
      size: 5,
      chunkSha256: '486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7',
      base64: Buffer.from('world').toString('base64'),
    },
    respond: chunk.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });

  assert.equal(chunk.calls[0][0], true);
  assert.equal(chunk.calls[0][1].stale, true);
  assert.equal(chunk.calls[0][1].ignored, true);
  assert.equal(bridge.fileRecvTransfers.get('tf-2').receivedChunks.size, 0);
});
