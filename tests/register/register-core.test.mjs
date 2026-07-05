import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRegisterApiStub, resetBncrRegisterGlobals } from '../helpers/register-api.mjs';

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

test('bncr register reuses bridge but only registers methods on a new api instance', async () => {
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

test('bncr register re-registers service and channel after in-process rebuild', async () => {
  resetBncrRegisterGlobals();
  const mod = await import('../../index.ts');
  const api = createRegisterApiStub();

  mod.default.register(api);

  assert.equal(api.services.length, 1);
  assert.equal(api.channels.length, 1);

  const gatewayRuntime = process[Symbol.for('bncr.gateway.runtime')];
  assert.ok(gatewayRuntime);
  assert.equal(gatewayRuntime.serviceRegistered, true);
  assert.equal(gatewayRuntime.channelRegistered, true);

  const firstBridge = globalThis.__bncrBridge;
  assert.ok(firstBridge);

  const ownerSymbol = Object.getOwnPropertySymbols(firstBridge).find((symbol) => {
    const value = firstBridge[symbol];
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
  firstBridge[ownerSymbol] = {
    ...firstBridge[ownerSymbol],
    moduleEpoch: `${firstBridge[ownerSymbol].moduleEpoch}-stale`,
  };

  mod.default.register(api);

  const secondBridge = globalThis.__bncrBridge;
  assert.ok(secondBridge);
  assert.notEqual(secondBridge, firstBridge);
  assert.equal(api.services.length, 2);
  assert.equal(api.channels.length, 2);
  assert.ok(api.methods.length > 0);
  assert.equal(gatewayRuntime.serviceRegistered, true);
  assert.equal(gatewayRuntime.channelRegistered, true);
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
