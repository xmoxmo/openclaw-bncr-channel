import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegisterApiStub, resetBncrRegisterGlobals } from '../helpers/register-api.mjs';

test('bncr channel actions handleAction sends text through the generic send path', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const channel = api.channels[0]?.plugin;
  assert.ok(channel);

  try {
    const result = await channel.actions.handleAction({
      action: 'send',
      accountId: 'Primary',
      mediaLocalRoots: ['/tmp'],
      params: {
        to: 'Bncr:tgBot:-1001:10001',
        message: 'hello through generic send',
      },
    });

    const bridge = globalThis.__bncrBridge;
    assert.ok(bridge);
    assert.equal(bridge.outbox.size, 1);
    const [entry] = bridge.outbox.values();
    assert.equal(entry.payload.type, 'message.outbound');
    assert.equal(entry.payload.message.msg, 'hello through generic send');
    assert.match(JSON.stringify(result), /"ok":true/);
  } finally {
    globalThis.__bncrBridge?.stopService?.();
    resetBncrRegisterGlobals();
  }
});

test('bncr channel actions handleAction sends media through the generic send path', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();
  mod.default.register(api);

  const channel = api.channels[0]?.plugin;
  assert.ok(channel);

  try {
    const result = await channel.actions.handleAction({
      action: 'send',
      accountId: 'Primary',
      mediaLocalRoots: ['/tmp'],
      params: {
        to: 'Bncr:tgBot:-1001:10001',
        message: 'generic media caption',
        mediaUrl: '/tmp/generic-send.png',
        type: 'image',
      },
    });

    const bridge = globalThis.__bncrBridge;
    assert.ok(bridge);
    assert.equal(bridge.outbox.size, 1);
    const [entry] = bridge.outbox.values();
    assert.equal(entry.payload.type, 'message.outbound');
    assert.equal(entry.payload._meta?.kind, 'file-transfer');
    assert.equal(entry.payload._meta?.mediaUrl, '/tmp/generic-send.png');
    assert.equal(entry.payload._meta?.text, 'generic media caption');
    assert.match(JSON.stringify(result), /"ok":true/);
  } finally {
    globalThis.__bncrBridge?.stopService?.();
    resetBncrRegisterGlobals();
  }
});
