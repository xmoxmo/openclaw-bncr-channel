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

test('stale file chunk and complete from owner should continue transfer without rewriting active conn', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const connect = getRegisteredMethod(api, 'bncr.connect');
  const fileInit = getRegisteredMethod(api, 'bncr.file.init');
  const fileChunk = getRegisteredMethod(api, 'bncr.file.chunk');
  const fileComplete = getRegisteredMethod(api, 'bncr.file.complete');

  const c1 = createGatewayRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c1.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });
  const lease1 = c1.calls[0][1].leaseId;
  const epoch1 = c1.calls[0][1].connectionEpoch;

  const sessionKey1 = `agent:main:bncr:direct:${Buffer.from('tgBot:0:u-file').toString('hex')}`;
  const init = createGatewayRespondCapture();
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

  const c2 = createGatewayRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c2.respond,
    client: { connId: 'conn-new' },
    context: { broadcastToConnIds() {} },
  });

  const bridge = globalThis.__bncrBridge;
  assert.equal(bridge.connections.get('Primary::client-a').connId, 'conn-new');

  const chunk = createGatewayRespondCapture();
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

  const complete = createGatewayRespondCapture();
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

test('file complete aborts transfer when inbound media save fails', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  api.runtime.channel.media.saveMediaBuffer = async () => {
    throw new Error('save failed from test');
  };
  mod.default.register(api);

  const connect = getRegisteredMethod(api, 'bncr.connect');
  const fileInit = getRegisteredMethod(api, 'bncr.file.init');
  const fileChunk = getRegisteredMethod(api, 'bncr.file.chunk');
  const fileComplete = getRegisteredMethod(api, 'bncr.file.complete');

  const c1 = createGatewayRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c1.respond,
    client: { connId: 'conn-a' },
    context: { broadcastToConnIds() {} },
  });
  const leaseId = c1.calls[0][1].leaseId;
  const connectionEpoch = c1.calls[0][1].connectionEpoch;

  const payload = Buffer.from('fail!');
  const sessionKey = `agent:main:bncr:direct:${Buffer.from('tgBot:0:u-save-fail').toString('hex')}`;
  const init = createGatewayRespondCapture();
  await fileInit({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      leaseId,
      connectionEpoch,
      transferId: 'tf-save-fail',
      sessionKey,
      platform: 'tgBot',
      groupId: '0',
      userId: 'u-save-fail',
      fileName: 'save-fail.txt',
      mimeType: 'text/plain',
      fileSize: payload.length,
      chunkSize: payload.length,
      totalChunks: 1,
      fileSha256: 'a661ff22e7a196c46cd4abf296895273a46e0df8c9cf0665ba83cb28e540bc9b',
    },
    respond: init.respond,
    client: { connId: 'conn-a' },
    context: { broadcastToConnIds() {} },
  });
  assert.equal(init.calls[0][0], true);

  const chunk = createGatewayRespondCapture();
  await fileChunk({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      leaseId,
      connectionEpoch,
      transferId: 'tf-save-fail',
      chunkIndex: 0,
      offset: 0,
      size: payload.length,
      chunkSha256: 'a661ff22e7a196c46cd4abf296895273a46e0df8c9cf0665ba83cb28e540bc9b',
      base64: payload.toString('base64'),
    },
    respond: chunk.respond,
    client: { connId: 'conn-a' },
    context: { broadcastToConnIds() {} },
  });
  assert.equal(chunk.calls[0][0], true);

  const complete = createGatewayRespondCapture();
  await fileComplete({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      leaseId,
      connectionEpoch,
      transferId: 'tf-save-fail',
    },
    respond: complete.respond,
    client: { connId: 'conn-a' },
    context: { broadcastToConnIds() {} },
  });

  assert.equal(complete.calls[0][0], false);
  assert.match(complete.calls[0][1].error, /save failed from test/);
  const st = globalThis.__bncrBridge.fileRecvTransfers.get('tf-save-fail');
  assert.equal(st.status, 'aborted');
  assert.match(st.error, /save failed from test/);
  assert.equal(typeof st.terminalAt, 'number');
});

test('stale file chunk from non-owner should stay ignored', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const connect = getRegisteredMethod(api, 'bncr.connect');
  const fileInit = getRegisteredMethod(api, 'bncr.file.init');
  const fileChunk = getRegisteredMethod(api, 'bncr.file.chunk');

  const c1 = createGatewayRespondCapture();
  await connect({
    params: { accountId: 'Primary', clientId: 'client-a' },
    respond: c1.respond,
    client: { connId: 'conn-old' },
    context: { broadcastToConnIds() {} },
  });
  const lease1 = c1.calls[0][1].leaseId;
  const epoch1 = c1.calls[0][1].connectionEpoch;

  const sessionKey2 = `agent:main:bncr:direct:${Buffer.from('tgBot:0:u-file2').toString('hex')}`;
  const init = createGatewayRespondCapture();
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

  const c2 = createGatewayRespondCapture();
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

  const chunk = createGatewayRespondCapture();
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
