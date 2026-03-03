import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  emptyPluginConfigSchema,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk";
import { createBncrBridge, createBncrChannelPlugin } from "./src/channel.js";

const plugin = {
  id: "Bncr",
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
      "bncr.pull",
      (opts: GatewayRequestHandlerOptions) => bridge.handlePull(opts),
    );
    api.registerGatewayMethod(
      "bncr.ack",
      (opts: GatewayRequestHandlerOptions) => bridge.handleAck(opts),
    );
  },
};

export default plugin;
