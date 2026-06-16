import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  createGatewayRespondCapture,
  createRegisterApiStub,
  getRegisteredMethod,
  resetBncrRegisterGlobals,
} from '../helpers/register-api.mjs';

afterEach(() => {
  const bridge = globalThis.__bncrBridge;
  if (bridge && typeof bridge.shutdown === 'function') {
    bridge.shutdown();
  }
  resetBncrRegisterGlobals();
});

test('stale ack from last pushed owner should still ack message without rewriting active conn', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const connect = getRegisteredMethod(api, 'bncr.connect');
  const ack = getRegisteredMethod(api, 'bncr.ack');

  const c1 = createGatewayRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c1.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });
  const lease1 = c1.calls[0][1].leaseId;
  const epoch1 = c1.calls[0][1].connectionEpoch;

  const bridge = globalThis.__bncrBridge;

  const c2 = createGatewayRespondCapture();
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

  const staleAck = createGatewayRespondCapture();
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
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const connect = getRegisteredMethod(api, 'bncr.connect');
  const ack = getRegisteredMethod(api, 'bncr.ack');

  const c1 = createGatewayRespondCapture();
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

  const c2 = createGatewayRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c2.respond,
    client: { connId: 'conn-new' },
    context: { broadcastToConnIds() {} },
  });

  const staleAck = createGatewayRespondCapture();
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
