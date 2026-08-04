import { emitBncrLogLine } from '../core/logging.ts';
import type { BridgeRegisterStateCarrier } from './register-runtime-helpers.ts';
import type { ChannelModule } from './runtime-loader.ts';

type OpenClawPluginApi = Parameters<ChannelModule['createBncrBridge']>[0];
type BridgeSingleton = ReturnType<ChannelModule['createBncrBridge']>;
type BridgeGatewayHandlerContext = Parameters<BridgeSingleton['handleConnect']>[0];
type BridgeGatewayHandlerResult = Awaited<ReturnType<BridgeSingleton['handleConnect']>>;
type BridgeStateReader = { gatewayPid?: number; getBridgeId?: () => string };
type OpenClawGatewayMethodMirror = {
  name?: string;
  handler?: (opts: BridgeGatewayHandlerContext) => unknown;
};
type OpenClawPluginApiWithGatewayMirror = OpenClawPluginApi & {
  methods?: OpenClawGatewayMethodMirror[];
};

export type BncrGatewayMethodName =
  | 'bncr.connect'
  | 'bncr.inbound'
  | 'bncr.activity'
  | 'bncr.ack'
  | 'bncr.diagnostics'
  | 'bncr.deadLetter.inspect'
  | 'bncr.deadLetter.prune'
  | 'bncr.rpc.response'
  | 'bncr.file.init'
  | 'bncr.file.chunk'
  | 'bncr.file.complete'
  | 'bncr.file.abort'
  | 'bncr.file.ack';

export function createBncrGatewayMethodRegistry(runtime: {
  getRegisterMeta: (api: OpenClawPluginApi) => {
    methods?: Set<string>;
    registryFingerprint?: string;
  };
  getRegistryFingerprint: (api: OpenClawPluginApi) => string;
  getGatewayRuntime: () => {
    currentBridge?: BridgeSingleton;
    registeredMethodsByRegistry: Map<string, Set<BncrGatewayMethodName>>;
  };
  gatewayMethodDispatchers: Record<
    BncrGatewayMethodName,
    (bridge: BridgeSingleton, opts: BridgeGatewayHandlerContext) => BridgeGatewayHandlerResult
  >;
  getBridgeRegisterStateCarrier: (bridge: BridgeSingleton) => BridgeRegisterStateCarrier;
}) {
  const dispatchGatewayMethod = (
    name: BncrGatewayMethodName,
    opts: BridgeGatewayHandlerContext,
  ) => {
    const gatewayRuntime = runtime.getGatewayRuntime();
    const bridge = gatewayRuntime.currentBridge;
    if (!bridge) {
      throw new Error(`bncr gateway runtime unavailable for ${name}`);
    }
    try {
      return runtime.gatewayMethodDispatchers[name](bridge, opts);
    } catch (error) {
      const state = runtime.getBridgeRegisterStateCarrier(bridge) as BridgeStateReader;
      const detail =
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack || null }
          : { name: 'NonError', message: String(error), stack: null };
      emitBncrLogLine(
        'error',
        `[bncr] gateway method error method=${name}|bridgeId=${state.getBridgeId?.() || '-'}|gatewayPid=${state.gatewayPid ?? '-'}|err=${detail.message}`,
      );
      emitBncrLogLine(
        'error',
        `[bncr] gateway method error ${JSON.stringify({
          method: name,
          bridgeId: state.getBridgeId?.() || null,
          gatewayPid: state.gatewayPid ?? null,
          detail,
        })}`,
        { debugOnly: true },
        () => false,
      );
      throw error;
    }
  };

  const mirrorGatewayMethodForMockApi = (
    api: OpenClawPluginApiWithGatewayMirror,
    name: BncrGatewayMethodName,
  ) => {
    if (!Array.isArray(api?.methods)) return;
    if (api.methods.some((item) => item?.name === name)) return;
    api.methods.push({ name, handler: (opts) => dispatchGatewayMethod(name, opts) });
  };

  const ensureGatewayMethodRegistered = (
    api: OpenClawPluginApiWithGatewayMirror,
    name: BncrGatewayMethodName,
    debugLog: (...args: unknown[]) => void,
  ) => {
    const meta = runtime.getRegisterMeta(api);
    const gatewayRuntime = runtime.getGatewayRuntime();
    const registryFingerprint = meta.registryFingerprint || runtime.getRegistryFingerprint(api);
    let registryMethods = gatewayRuntime.registeredMethodsByRegistry.get(registryFingerprint);
    if (!registryMethods) {
      registryMethods = new Set<BncrGatewayMethodName>();
      gatewayRuntime.registeredMethodsByRegistry.set(registryFingerprint, registryMethods);
    }
    if (meta.methods?.has(name)) {
      debugLog(`register method skip ${name} (already registered on this api)`);
      return;
    }
    if (registryMethods.has(name)) {
      mirrorGatewayMethodForMockApi(api, name);
      meta.methods?.add(name);
      debugLog(`register method reuse ${name} (already registered in registry)`);
      return;
    }
    api.registerGatewayMethod(name, (opts: BridgeGatewayHandlerContext) =>
      dispatchGatewayMethod(name, opts),
    );
    mirrorGatewayMethodForMockApi(api, name);
    registryMethods.add(name);
    meta.methods?.add(name);
    debugLog(`register method ok ${name}`);
  };

  return {
    dispatchGatewayMethod,
    ensureGatewayMethodRegistered,
  };
}
