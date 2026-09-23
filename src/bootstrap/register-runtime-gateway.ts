import { emitBncrLogLine } from '../core/logging.ts';
import type { RegisterLifecycleState } from './register-lifecycle.ts';
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
    gatewayMethodDispatchers?: Partial<
      Record<
        BncrGatewayMethodName,
        (bridge: BridgeSingleton, opts: BridgeGatewayHandlerContext) => BridgeGatewayHandlerResult
      >
    >;
    registryDeclarations?: Map<
      string,
      {
        state: 'shadow' | 'active' | 'retired';
        registration?: 'pending' | 'complete' | 'failed';
      }
    >;
    lifecycle?: RegisterLifecycleState;
  };
  gatewayMethodDispatchers: Record<
    BncrGatewayMethodName,
    (bridge: BridgeSingleton, opts: BridgeGatewayHandlerContext) => BridgeGatewayHandlerResult
  >;
  getBridgeRegisterStateCarrier: (bridge: BridgeSingleton) => BridgeRegisterStateCarrier;
  getRegistryRuntimeObservation?: (registryFingerprint: string) => unknown;
}) {
  const dispatchGatewayMethod = (
    name: BncrGatewayMethodName,
    opts: BridgeGatewayHandlerContext,
    registryFingerprint?: string,
  ) => {
    const gatewayRuntime = runtime.getGatewayRuntime();
    const declaration = registryFingerprint
      ? gatewayRuntime.registryDeclarations?.get(registryFingerprint)
      : undefined;
    const lifecycleFailed = gatewayRuntime.lifecycle?.active?.phase === 'failed';
    const declarationFailed = declaration?.registration === 'failed';
    const dispatchAllowed = declaration
      ? declaration.state !== 'retired' && !declarationFailed && !lifecycleFailed
      : !gatewayRuntime.lifecycle?.active;
    if (registryFingerprint && !dispatchAllowed) {
      throw new Error(`bncr lifecycle registry is inactive for ${name}`);
    }
    const bridge = gatewayRuntime.currentBridge;
    if (!bridge) {
      throw new Error(`bncr gateway runtime unavailable for ${name}`);
    }
    const dispatcherOpts =
      name === 'bncr.diagnostics' &&
      registryFingerprint &&
      runtime.getRegistryRuntimeObservation &&
      typeof opts.respond === 'function'
        ? {
            ...opts,
            respond: (...response: Parameters<typeof opts.respond>) => {
              const [ok, payload, error, meta] = response;
              let observation: unknown = null;
              try {
                observation = runtime.getRegistryRuntimeObservation?.(registryFingerprint) ?? null;
              } catch {
                observation = null;
              }
              const nextPayload =
                ok && payload && typeof payload === 'object' && !Array.isArray(payload)
                  ? { ...payload, lifecycleObservation: observation }
                  : payload;
              opts.respond(ok, nextPayload, error, meta);
            },
          }
        : opts;
    try {
      const dispatcher =
        gatewayRuntime.gatewayMethodDispatchers?.[name] || runtime.gatewayMethodDispatchers[name];
      return dispatcher(bridge, dispatcherOpts);
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
    api.methods.push({
      name,
      handler: (opts) =>
        dispatchGatewayMethod(
          name,
          opts,
          runtime.getRegisterMeta(api).registryFingerprint || runtime.getRegistryFingerprint(api),
        ),
    });
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
      dispatchGatewayMethod(name, opts, registryFingerprint),
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
