import assert from 'node:assert/strict';
import test from 'node:test';

function createApi() {
  return {
    runtime: {
      config: {
        async loadConfig() {
          return { channels: { bncr: { debug: { verbose: false } } } };
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

test('bncr register reuses bridge but registers on a new api instance', async () => {
  const mod = await import('../index.ts');
  const api1 = createApi();
  const api2 = createApi();

  mod.default.register(api1);
  mod.default.register(api2);

  assert.equal(api1.services.length, 1);
  assert.equal(api1.channels.length, 1);
  assert.equal(api1.methods.length, 10);

  assert.equal(api2.services.length, 1);
  assert.equal(api2.channels.length, 1);
  assert.equal(api2.methods.length, 10);
});
