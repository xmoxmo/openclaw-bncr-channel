const BNCR_GATEWAY_RUNTIME = Symbol.for('bncr.gateway.runtime');

export function resetBncrRegisterGlobals() {
  delete globalThis.__bncrBridge;
  delete process[BNCR_GATEWAY_RUNTIME];
}

export function createRegisterApiStub(overrides = {}) {
  const currentConfig = overrides.currentConfig ?? {
    channels: { bncr: { debug: { verbose: false } } },
  };
  const logs = [];
  const mutateCalls = [];
  const writeCalls = [];

  return {
    runtime: {
      config: {
        current() {
          return currentConfig;
        },
        get() {
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
      media: {
        async loadWebMedia(mediaUrl) {
          return { buffer: Buffer.from(mediaUrl), contentType: 'application/octet-stream' };
        },
      },
      channel: {
        inbound: {
          buildContext() {
            return {};
          },
          async run() {
            return undefined;
          },
        },
        media: {
          async readRemoteMediaBuffer(options) {
            return {
              buffer: Buffer.from(options.url),
              contentType: 'application/octet-stream',
              maxBytes: options.maxBytes,
            };
          },
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
        reply: {
          resolveEnvelopeFormatOptions() {
            return {};
          },
          formatAgentEnvelope(params) {
            return params.body;
          },
          async dispatchReplyWithBufferedBlockDispatcher() {
            return undefined;
          },
        },
        routing: {
          resolveAgentRoute() {
            return { sessionKey: 'agent:main:bncr:direct:66616b65' };
          },
        },
        session: {
          readSessionUpdatedAt() {
            return undefined;
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
      debug(...args) {
        logs.push(['debug', ...args]);
      },
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
    logs,
    mutateCalls,
    writeCalls,
    currentConfig,
    ...overrides,
  };
}

export function createGatewayRespondCapture() {
  const calls = [];
  const respond = (...args) => calls.push(args);
  return { respond, calls };
}

export function getRegisteredMethod(api, name) {
  const item = api.methods.find((method) => method.name === name);
  if (!item) throw new Error(`expected method ${name}`);
  return item.handler;
}
