import assert from 'node:assert/strict';
import test from 'node:test';

const BNCR_GATEWAY_RUNTIME = Symbol.for('bncr.gateway.runtime');

function resetBncrGlobals() {
  delete globalThis.__bncrBridge;
  delete process[BNCR_GATEWAY_RUNTIME];
}

function createApi() {
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
      },
    },
    logger: {
      info() {},
    },
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

test('bncr register is idempotent on the same api instance', async () => {
  const mod = await import('../index.ts');
  const api = createApi();

  mod.default.register(api);
  mod.default.register(api);

  assert.equal(api.services.length, 1);
  assert.equal(api.channels.length, 1);
  assert.deepEqual(
    api.methods.map((item) => item.name),
    [
      'bncr.connect',
      'bncr.inbound',
      'bncr.activity',
      'bncr.ack',
      'bncr.diagnostics',
      'bncr.file.init',
      'bncr.file.chunk',
      'bncr.file.complete',
      'bncr.file.abort',
      'bncr.file.ack',
    ],
  );
});

test('bncr register reuses bridge but only registers methods on a new api instance', async () => {
  resetBncrGlobals();
  const mod = await import('../index.ts');
  const api1 = createApi();
  const api2 = createApi();

  mod.default.register(api1);
  mod.default.register(api2);

  assert.equal(api1.services.length, 1);
  assert.equal(api1.channels.length, 1);
  assert.equal(api1.methods.length, 10);

  assert.equal(api2.services.length, 0);
  assert.equal(api2.channels.length, 0);
  assert.equal(api2.methods.length, 10);
});

test('bncr messaging exposes parse/display/session target helpers on the owning api channel plugin', async () => {
  resetBncrGlobals();
  const mod = await import('../index.ts');
  const api = createApi();
  mod.default.register(api);

  const channel = api.channels[0]?.plugin;
  assert.ok(channel);
  assert.equal(typeof channel.messaging?.parseExplicitTarget, 'function');
  assert.equal(typeof channel.messaging?.formatTargetDisplay, 'function');
  assert.equal(typeof channel.messaging?.resolveSessionTarget, 'function');

  const direct = channel.messaging.parseExplicitTarget({ raw: 'Bncr:tgBot:6278285192' });
  assert.ok(direct);
  assert.equal(direct.displayScope, 'Bncr:tgBot:6278285192');

  const group = channel.messaging.parseExplicitTarget({
    raw: 'Bncr:tgBot:-1003776014601:6278285192',
  });
  assert.ok(group);
  assert.equal(group.displayScope, 'Bncr:tgBot:-1003776014601:6278285192');
  assert.equal(channel.messaging.formatTargetDisplay({ target: group }), group.displayScope);
  assert.equal(
    channel.messaging.resolveSessionTarget({ id: 'Bncr:tgBot:6278285192' }),
    'Bncr:tgBot:6278285192',
  );
});
