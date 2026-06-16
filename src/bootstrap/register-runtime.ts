import {
  type BncrGatewayMethodName,
  createBncrGatewayMethodRegistry,
} from './register-runtime-gateway.ts';
import {
  type BridgeOwner,
  type BridgeRegisterStateCarrier,
  shouldAdoptProcessOwner,
} from './register-runtime-helpers.ts';
import { createBncrBridgeSingletonManager } from './register-runtime-singleton.ts';
import {
  type ChannelModule,
  type LoadedRuntime,
  loadBncrRuntimeSync,
  pluginFile,
  pluginRoot,
} from './runtime-loader.ts';

type OpenClawPluginApi = Parameters<ChannelModule['createBncrBridge']>[0];
type BridgeSingleton = ReturnType<ChannelModule['createBncrBridge']>;
type BridgeGatewayHandlerContext = Parameters<BridgeSingleton['handleConnect']>[0];
type BridgeGatewayHandlerResult = Awaited<ReturnType<BridgeSingleton['handleConnect']>>;
type BridgeSingletonWithState = BridgeSingleton;

type RegisterMeta = {
  service?: boolean;
  channel?: boolean;
  methods?: Set<string>;
  apiInstanceId?: string;
  registryFingerprint?: string;
  registrationMode?: string;
};

type GlobalRegisterTrace = {
  lastApiInstanceId?: string;
  lastRegistryFingerprint?: string;
  seenRegistryFingerprints: Set<string>;
  seenApiInstanceIds: Set<string>;
};

type OpenClawPluginApiWithMeta = OpenClawPluginApi & {
  [registerMetaSymbol]?: RegisterMeta;
};

type BncrGatewayRuntime = {
  currentBridge?: BridgeSingletonWithState;
  registeredMethodsByRegistry: Map<string, Set<BncrGatewayMethodName>>;
  serviceRegistered?: boolean;
  channelRegistered?: boolean;
  serviceOwnerApiInstanceId?: string;
  channelOwnerApiInstanceId?: string;
};

const registerMetaSymbol = Symbol.for('bncr.register.meta');
const globalRegisterTraceSymbol = Symbol.for('bncr.global.register.trace');
const bridgeOwnerSymbol = Symbol.for('bncr.bridge.owner');
const gatewayRuntimeSymbol = Symbol.for('bncr.gateway.runtime');
const moduleEpoch = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const identityIds = new WeakMap<object, string>();
let identitySeq = 0;

const getIdentityId = (obj: object, prefix: string) => {
  const existing = identityIds.get(obj);
  if (existing) return existing;
  const next = `${prefix}_${moduleEpoch}_${++identitySeq}`;
  identityIds.set(obj, next);
  return next;
};

const getRegistryFingerprint = (api: OpenClawPluginApi) => {
  const serviceId = getIdentityId(api.registerService as object, 'svc');
  const channelId = getIdentityId(api.registerChannel as object, 'chn');
  const methodId = getIdentityId(api.registerGatewayMethod as object, 'mth');
  return `${serviceId}:${channelId}:${methodId}`;
};

const getProcessStore = () => {
  const p = process as NodeJS.Process & {
    [globalRegisterTraceSymbol]?: GlobalRegisterTrace;
    [gatewayRuntimeSymbol]?: BncrGatewayRuntime;
  };
  return p;
};

export function createBncrRegisterRuntime() {
  const gatewayMethodDispatchers: Record<
    BncrGatewayMethodName,
    (
      bridge: BridgeSingletonWithState,
      opts: BridgeGatewayHandlerContext,
    ) => BridgeGatewayHandlerResult
  > = {
    'bncr.connect': (bridge, opts) => bridge.handleConnect(opts),
    'bncr.inbound': (bridge, opts) => bridge.handleInbound(opts),
    'bncr.activity': (bridge, opts) => bridge.handleActivity(opts),
    'bncr.ack': (bridge, opts) => bridge.handleAck(opts),
    'bncr.diagnostics': (bridge, opts) => bridge.handleDiagnostics(opts),
    'bncr.deadLetter.inspect': (bridge, opts) => bridge.handleDeadLetterInspect(opts),
    'bncr.deadLetter.prune': (bridge, opts) => bridge.handleDeadLetterPrune(opts),
    'bncr.file.init': (bridge, opts) => bridge.handleFileInit(opts),
    'bncr.file.chunk': (bridge, opts) => bridge.handleFileChunk(opts),
    'bncr.file.complete': (bridge, opts) => bridge.handleFileComplete(opts),
    'bncr.file.abort': (bridge, opts) => bridge.handleFileAbort(opts),
    'bncr.file.ack': (bridge, opts) => bridge.handleFileAck(opts),
  };

  const getRegisterMeta = (api: OpenClawPluginApi): RegisterMeta => {
    const host = api as OpenClawPluginApiWithMeta;
    if (!host[registerMetaSymbol]) {
      host[registerMetaSymbol] = { methods: new Set<string>() };
    }
    if (!host[registerMetaSymbol]!.methods) {
      host[registerMetaSymbol]!.methods = new Set<string>();
    }
    if (!host[registerMetaSymbol]!.apiInstanceId) {
      host[registerMetaSymbol]!.apiInstanceId = getIdentityId(api as object, 'api');
    }
    if (!host[registerMetaSymbol]!.registryFingerprint) {
      host[registerMetaSymbol]!.registryFingerprint = getRegistryFingerprint(api);
    }
    return host[registerMetaSymbol]!;
  };

  const getGlobalRegisterTrace = () => {
    const p = getProcessStore();
    if (!p[globalRegisterTraceSymbol]) {
      p[globalRegisterTraceSymbol] = {
        seenRegistryFingerprints: new Set<string>(),
        seenApiInstanceIds: new Set<string>(),
      };
    }
    return p[globalRegisterTraceSymbol]!;
  };

  const getGatewayRuntime = (): BncrGatewayRuntime => {
    const p = getProcessStore();
    if (!p[gatewayRuntimeSymbol]) {
      p[gatewayRuntimeSymbol] = {
        registeredMethodsByRegistry: new Map<string, Set<BncrGatewayMethodName>>(),
        serviceRegistered: false,
        channelRegistered: false,
      };
    }
    return p[gatewayRuntimeSymbol]!;
  };

  const getBridgeRegisterStateCarrier = (bridge: BridgeSingleton): BridgeRegisterStateCarrier =>
    bridge as unknown as BridgeRegisterStateCarrier;

  const gatewayMethodRegistry = createBncrGatewayMethodRegistry({
    getRegisterMeta,
    getRegistryFingerprint,
    getGatewayRuntime,
    gatewayMethodDispatchers,
    getBridgeRegisterStateCarrier,
  });

  const getBridgeOwner = (api: OpenClawPluginApi, loaded: LoadedRuntime): BridgeOwner => {
    const meta = getRegisterMeta(api);
    return {
      moduleEpoch,
      bridgeFactoryId: getIdentityId(loaded.createBncrBridge as object, 'bridgeFactory'),
      apiInstanceId: meta.apiInstanceId || 'unknown',
      registryFingerprint: meta.registryFingerprint || 'unknown',
      registrationMode: meta.registrationMode,
    };
  };

  const bridgeSingletonManager = createBncrBridgeSingletonManager({
    bridgeOwnerSymbol,
    pluginRoot,
    pluginFile,
    loadBncrRuntimeSync,
    getBridgeOwner,
  });

  const getCurrentBridge = (): BridgeSingletonWithState => {
    const bridge = getGatewayRuntime().currentBridge;
    if (!bridge) throw new Error('bncr current bridge unavailable');
    return bridge;
  };

  return {
    getRegisterMeta,
    getGlobalRegisterTrace,
    getGatewayRuntime,
    shouldAdoptProcessOwner: (apiInstanceId: string, gatewayRuntime: BncrGatewayRuntime) =>
      shouldAdoptProcessOwner({
        apiInstanceId,
        serviceRegistered: gatewayRuntime.serviceRegistered,
        channelRegistered: gatewayRuntime.channelRegistered,
        serviceOwnerApiInstanceId: gatewayRuntime.serviceOwnerApiInstanceId,
        channelOwnerApiInstanceId: gatewayRuntime.channelOwnerApiInstanceId,
      }),
    ensureGatewayMethodRegistered: gatewayMethodRegistry.ensureGatewayMethodRegistered,
    getBridgeSingleton: bridgeSingletonManager.getBridgeSingleton,
    getBridgeOwnerFromBridge: bridgeSingletonManager.getBridgeOwnerFromBridge,
    getExistingBridgeSingleton: bridgeSingletonManager.getExistingBridgeSingleton,
    getCurrentBridge,
  };
}
