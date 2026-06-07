import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const BNCR_GATEWAY_RUNTIME = Symbol.for('bncr.gateway.runtime');
const REQUIRED_OPENCLAW_RANGE = '>=2026.5.27';
const CHANNEL_SDK_HELPER_IMPORTS = [
  'openclaw/plugin-sdk/boolean-param',
  'openclaw/plugin-sdk/json-store',
  'openclaw/plugin-sdk/param-readers',
  'openclaw/plugin-sdk/status-helpers',
  'openclaw/plugin-sdk/tool-send',
];
const INGRESS_RUNTIME_IMPORT = 'openclaw/plugin-sdk/channel-ingress-runtime';

function resetBncrGlobals() {
  delete globalThis.__bncrBridge;
  delete process[BNCR_GATEWAY_RUNTIME];
}

function createApi(overrides = {}) {
  const currentConfig = overrides.currentConfig ?? {
    channels: { bncr: { debug: { verbose: false } } },
  };
  const mutateCalls = [];
  const writeCalls = [];
  return {
    runtime: {
      config: {
        current() {
          return currentConfig;
        },
        async loadConfig() {
          return currentConfig;
        },
        async mutateConfigFile(params) {
          mutateCalls.push(params);
          return {
            changed: true,
            result: await params.mutate(currentConfig, { snapshot: {}, previousHash: null }),
          };
        },
        async writeConfigFile(...args) {
          writeCalls.push(args);
          throw new Error('deprecated writeConfigFile should not be used');
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
    registerCli(register, options) {
      this.cli = { register, options };
    },
    mutateCalls,
    writeCalls,
    currentConfig,
  };
}

test('bncr package and README require the OpenClaw 2026.5.27 runtime baseline', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  assert.equal(pkg.peerDependencies?.openclaw, REQUIRED_OPENCLAW_RANGE);
  assert.equal(pkg.devDependencies?.openclaw, REQUIRED_OPENCLAW_RANGE);
  assert.match(readme, /兼容范围：`openclaw >= 2026\.5\.27`/);
  assert.equal(readme.includes('openclaw >= 2026.5.3-1'), false);
});

test('bncr README documents the package dry-run check', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  assert.match(readme, /npm run check-pack/);
  assert.match(readme, /npm pack --dry-run --json/);
});

test('bncr README documents channel handoff rather than final platform delivery semantics', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  assert.match(readme, /进入 bncr 自管 outbox，即表示频道 handoff 完成/);
  assert.match(readme, /不等价于客户端 ACK 或目标平台最终送达/);
  assert.match(readme, /后续可靠投递由 bncr 自身负责/);
  assert.match(readme, /已注册生产 `channel\.message` 作为 bncr 的频道专用 handoff adapter/);
  assert.match(readme, /`text` \/ `media` \/ `payload` 会转换为 bncr outbox entry/);
  assert.match(readme, /原有通用 `message\.send` \/ `channel\.actions\.send` 发送能力继续保留/);
  assert.match(readme, /`channel\.message` 是频道专用入口，不替代通用发送入口/);
  assert.match(readme, /仍不启用 `durableFinal`/);
});

test('bncr manifest config schemas stay aligned with runtime schema keys', async () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'),
  );
  const { BncrConfigSchema } = await import('../src/core/config-schema.ts');

  const runtimeKeys = Object.keys(BncrConfigSchema.schema.properties).sort();
  const manifestTopKeys = Object.keys(manifest.configSchema.properties).sort();
  const manifestChannelKeys = Object.keys(manifest.channelConfigs.bncr.schema.properties).sort();

  assert.deepEqual(manifestTopKeys, runtimeKeys);
  assert.deepEqual(manifestChannelKeys, runtimeKeys);
});

test('bncr channel routes OpenClaw SDK helper imports through the local adapter', () => {
  const channelSource = fs.readFileSync(new URL('../src/channel.ts', import.meta.url), 'utf8');
  const adapterSource = fs.readFileSync(
    new URL('../src/openclaw/sdk-helpers.ts', import.meta.url),
    'utf8',
  );

  for (const specifier of CHANNEL_SDK_HELPER_IMPORTS) {
    assert.equal(channelSource.includes(specifier), false, specifier);
    assert.equal(adapterSource.includes(specifier), true, specifier);
  }
});

test('bncr gate routes OpenClaw ingress runtime through the local adapter', () => {
  const gateSource = fs.readFileSync(
    new URL('../src/messaging/inbound/gate.ts', import.meta.url),
    'utf8',
  );
  const adapterSource = fs.readFileSync(
    new URL('../src/openclaw/ingress-runtime.ts', import.meta.url),
    'utf8',
  );

  assert.equal(gateSource.includes(INGRESS_RUNTIME_IMPORT), false);
  assert.equal(adapterSource.includes(INGRESS_RUNTIME_IMPORT), true);
});

test('bncr selfcheck covers every OpenClaw SDK import used by source and entrypoint', () => {
  const sourceRoot = new URL('../src/', import.meta.url);
  const importedSpecifiers = new Set();
  const scanFile = (fileUrl) => {
    const source = fs.readFileSync(fileUrl, 'utf8');
    for (const match of source.matchAll(/openclaw\/plugin-sdk(?:\/[A-Za-z0-9_-]+)?/g)) {
      importedSpecifiers.add(match[0]);
    }
  };
  const visitSourceDir = (dirUrl) => {
    for (const entry of fs.readdirSync(dirUrl, { withFileTypes: true })) {
      const entryUrl = new URL(entry.name, dirUrl);
      if (entry.isDirectory()) {
        visitSourceDir(new URL(`${entry.name}/`, dirUrl));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      scanFile(entryUrl);
    }
  };
  scanFile(new URL('../index.ts', import.meta.url));
  visitSourceDir(sourceRoot);

  const selfcheckSource = fs.readFileSync(
    new URL('../scripts/selfcheck.mjs', import.meta.url),
    'utf8',
  );

  for (const specifier of importedSpecifiers) {
    assert.equal(selfcheckSource.includes(`'${specifier}'`), true, specifier);
  }
});

test('bncr package guard scripts list every source file', () => {
  const sourceRoot = new URL('../src/', import.meta.url);
  const actualSourceFiles = [];
  const visit = (dirUrl, relDir = 'src') => {
    for (const entry of fs.readdirSync(dirUrl, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        visit(new URL(`${entry.name}/`, dirUrl), `${relDir}/${entry.name}`);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      actualSourceFiles.push(`${relDir}/${entry.name}`);
    }
  };
  visit(sourceRoot);
  actualSourceFiles.sort();

  for (const script of ['selfcheck.mjs', 'check-pack.mjs']) {
    const source = fs.readFileSync(new URL(`../scripts/${script}`, import.meta.url), 'utf8');
    const listed = Array.from(
      new Set(
        Array.from(source.matchAll(/'([^']+\.ts)'/g), (match) => match[1])
          .filter((file) => file.startsWith('src/'))
          .sort(),
      ),
    );
    assert.deepEqual(listed, actualSourceFiles, script);
  }
});

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
      'bncr.deadLetter.inspect',
      'bncr.deadLetter.prune',
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
  assert.equal(api1.methods.length, 12);

  assert.equal(api2.services.length, 0);
  assert.equal(api2.channels.length, 0);
  assert.equal(api2.methods.length, 12);
});

test('bncr miniconfig uses transactional mutateConfigFile', async () => {
  resetBncrGlobals();
  const mod = await import('../index.ts');
  const api = createApi({ currentConfig: {} });
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
  resetBncrGlobals();
  const mod = await import('../index.ts');
  const api = createApi();
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
  resetBncrGlobals();
  const mod = await import('../index.ts');
  const api = createApi();
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

  const direct = channel.messaging.parseExplicitTarget({ raw: 'Bncr:tgBot:10001' });
  assert.ok(direct);
  assert.equal(direct.displayScope, 'Bncr:tgBot:10001');

  const group = channel.messaging.parseExplicitTarget({
    raw: 'Bncr:tgBot:-1001:10001',
  });
  assert.ok(group);
  assert.equal(group.displayScope, 'Bncr:tgBot:-1001:10001');
  assert.equal(channel.messaging.formatTargetDisplay({ target: group }), group.displayScope);
  assert.equal(
    channel.messaging.resolveSessionTarget({ id: 'Bncr:tgBot:10001' }),
    'Bncr:tgBot:10001',
  );
});
