import type {
  OpenClawPluginApi,
  GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/core";
import { BncrConfigSchema } from "./src/core/config-schema.ts";
import { createBncrBridge, createBncrChannelPlugin } from "./src/channel.ts";

type BridgeSingleton = ReturnType<typeof createBncrBridge>;

const getBridgeSingleton = (api: OpenClawPluginApi) => {
  const g = globalThis as typeof globalThis & { __bncrBridge?: BridgeSingleton };
  if (!g.__bncrBridge) g.__bncrBridge = createBncrBridge(api);
  return g.__bncrBridge;
};

const plugin = {
  id: "bncr",
  name: "Bncr",
  description: "Bncr channel plugin",
  configSchema: BncrConfigSchema,
  register(api: OpenClawPluginApi) {
    const bridge = getBridgeSingleton(api);
    const debugLog = (...args: any[]) => {
      if (!bridge.isDebugEnabled?.()) return;
      api.logger.info?.(...args);
    };

    debugLog(`bncr plugin register bridge=${(bridge as any)?.bridgeId || 'unknown'}`);

    const resolveDebug = async () => {
      try {
        const cfg = await api.runtime.config.loadConfig();
        return Boolean((cfg as any)?.channels?.bncr?.debug?.verbose);
      } catch {
        return false;
      }
    };

    api.registerService({
      id: "bncr-bridge-service",
      start: async (ctx) => {
        const debug = await resolveDebug();
        await bridge.startService(ctx, debug);
      },
      stop: bridge.stopService,
    });

    api.registerChannel({ plugin: createBncrChannelPlugin(bridge) });

    api.registerGatewayMethod(
      "bncr.connect",
      (opts: GatewayRequestHandlerOptions) => bridge.handleConnect(opts),
    );
    api.registerGatewayMethod(
      "bncr.inbound",
      (opts: GatewayRequestHandlerOptions) => bridge.handleInbound(opts),
    );
    api.registerGatewayMethod(
      "bncr.activity",
      (opts: GatewayRequestHandlerOptions) => bridge.handleActivity(opts),
    );
    api.registerGatewayMethod(
      "bncr.ack",
      (opts: GatewayRequestHandlerOptions) => bridge.handleAck(opts),
    );
    api.registerGatewayMethod(
      "bncr.diagnostics",
      (opts: GatewayRequestHandlerOptions) => bridge.handleDiagnostics(opts),
    );
    api.registerGatewayMethod(
      "bncr.file.init",
      (opts: GatewayRequestHandlerOptions) => bridge.handleFileInit(opts),
    );
    api.registerGatewayMethod(
      "bncr.file.chunk",
      (opts: GatewayRequestHandlerOptions) => bridge.handleFileChunk(opts),
    );
    api.registerGatewayMethod(
      "bncr.file.complete",
      (opts: GatewayRequestHandlerOptions) => bridge.handleFileComplete(opts),
    );
    api.registerGatewayMethod(
      "bncr.file.abort",
      (opts: GatewayRequestHandlerOptions) => bridge.handleFileAbort(opts),
    );
    api.registerGatewayMethod(
      "bncr.file.ack",
      (opts: GatewayRequestHandlerOptions) => bridge.handleFileAck(opts),
    );
  },
};

export default plugin;
