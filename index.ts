import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  emptyPluginConfigSchema,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk";
import { createBncrBridge, createBncrChannelPlugin } from "./src/channel.js";

const plugin = {
  id: "bncr",
  name: "Bncr",
  description: "Bncr channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const bridge = createBncrBridge(api);

    api.registerService({
      id: "bncr-bridge-service",
      start: bridge.startService,
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
