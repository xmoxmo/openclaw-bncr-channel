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
        to: 'Bncr:tgBot:-1001:0',
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
        to: 'Bncr:tgBot:-1001:0',
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

test('bncr channel actions handleAction sends mediaUrls through the generic media path', async () => {
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
        to: 'Bncr:tgBot:-1001:0',
        message: 'generic album caption',
        mediaUrls: ['/tmp/generic-send-1.png', '/tmp/generic-send-2.png'],
        type: 'image',
      },
    });

    const bridge = globalThis.__bncrBridge;
    assert.ok(bridge);
    assert.equal(bridge.outbox.size, 3);
    const entries = Array.from(bridge.outbox.values());

    assert.equal(entries[0].payload.type, 'message.outbound');
    assert.equal(entries[0].payload.message.msg, 'generic album caption');

    assert.equal(entries[1].payload.type, 'message.outbound');
    assert.equal(entries[1].payload._meta?.kind, 'file-transfer');
    assert.equal(entries[1].payload._meta?.mediaUrl, '/tmp/generic-send-1.png');

    assert.equal(entries[2].payload.type, 'message.outbound');
    assert.equal(entries[2].payload._meta?.kind, 'file-transfer');
    assert.equal(entries[2].payload._meta?.mediaUrl, '/tmp/generic-send-2.png');
    assert.match(JSON.stringify(result), /"ok":true/);
  } finally {
    globalThis.__bncrBridge?.stopService?.();
    resetBncrRegisterGlobals();
  }
});
