const BNCR_GATEWAY_RUNTIME = Symbol.for('bncr.gateway.runtime');

export function resetBncrRegisterGlobals() {
  delete globalThis.__bncrBridge;
  delete process[BNCR_GATEWAY_RUNTIME];
}

export function createRegisterApiStub(overrides = {}) {
  // `reuseRegistry` models a single registry object surviving across code
  // generations. The current OpenClaw host allocates a fresh api per register
  // pass, so it is off by default and only enabled by defense-in-depth tests.
  const { reuseRegistry = false, ...rest } = overrides;
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
      // Host contract: service ids are unique per registry and the first
      // registration wins; a same-plugin re-registration is silently ignored.
      const id = typeof def?.id === 'string' ? def.id.trim() : '';
      if (!reuseRegistry && id && this.services.some((entry) => entry?.id?.trim() === id)) {
        return;
      }
      this.services.push(def);
    },
    registerChannel(def) {
      // Host contract: channel ids are unique per registry; a same-plugin
      // re-registration replaces the previous channel plugin object.
      const id = def?.plugin?.id;
      if (!reuseRegistry && id) {
        const existing = this.channels.findIndex((entry) => entry?.plugin?.id === id);
        if (existing >= 0) {
          this.channels[existing] = def;
          return;
        }
      }
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
    ...rest,
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
