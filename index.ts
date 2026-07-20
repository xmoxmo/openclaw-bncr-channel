import { createDynamicChannelPlugin } from './src/bootstrap/channel-plugin-runtime.ts';
import {
  type BncrRegistrationApi,
  registerBncrCli,
  shouldSkipNonRuntimeRegister,
} from './src/bootstrap/cli.ts';
import { createBncrRegisterRuntime } from './src/bootstrap/register-runtime.ts';
import {
  type ChannelModule,
  type LoadedRuntime,
  loadBncrRuntimeSync,
  pluginVersion as runtimePluginVersion,
} from './src/bootstrap/runtime-loader.ts';
import { BncrConfigSchema } from './src/core/config-schema.ts';
import { emitBncrLogLine } from './src/core/logging.ts';
import { getOpenClawRuntimeConfig } from './src/openclaw/config-runtime.ts';

type ChannelPlugin = ReturnType<ChannelModule['createBncrChannelPlugin']>;

const pluginVersion = runtimePluginVersion;

const registerRuntime = createBncrRegisterRuntime();

type BridgeSingletonWithOwner = NonNullable<
  ReturnType<typeof registerRuntime.getExistingBridgeSingleton>
>;
type BridgeOwner = ReturnType<typeof registerRuntime.getBridgeOwnerFromBridge>;
const {
  ensureGatewayMethodRegistered,
  getBridgeSingleton,
  getBridgeOwnerFromBridge,
  getCurrentBridge,
  getExistingBridgeSingleton,
  getGatewayRuntime,
  getGlobalRegisterTrace,
  getRegisterMeta,
  shouldAdoptProcessOwner,
} = registerRuntime;

type BncrDebugConfigRoot = {
  channels?: {
    bncr?: {
      enabled?: boolean;
      allowTool?: boolean;
      debug?: {
        verbose?: unknown;
      };
    };
  };
};

const plugin = {
  id: 'bncr',
  name: 'Bncr',
  description: 'Bncr channel plugin',
  configSchema: BncrConfigSchema,
  register(api: BncrRegistrationApi) {
    registerBncrCli(api);
    if (shouldSkipNonRuntimeRegister(api.registrationMode)) return;

    // 注意：OpenClaw 要求 plugin register 必须是同步函数；
    // 不要在这里 await 停旧 service / 清理旧 runtime，否则 loader 会直接拒绝加载。
    // 旧实例清理由 service stop / runtime 自愈逻辑兜底，这里只做同步声明式注册。

    const meta = getRegisterMeta(api);
    meta.registrationMode = api.registrationMode;
    const globalTrace = getGlobalRegisterTrace();
    const previousApiInstanceId = globalTrace.lastApiInstanceId;
    const previousRegistryFingerprint = globalTrace.lastRegistryFingerprint;
    const apiInstanceId = meta.apiInstanceId || 'unknown';
    const registryFingerprint = meta.registryFingerprint || 'unknown';
    const sameApiAsPrevious = previousApiInstanceId === apiInstanceId;
    const sameRegistryAsPrevious = previousRegistryFingerprint === registryFingerprint;
    const firstSeenApi = !globalTrace.seenApiInstanceIds.has(apiInstanceId);
    const firstSeenRegistry = !globalTrace.seenRegistryFingerprints.has(registryFingerprint);

    const gatewayRuntime = getGatewayRuntime();
    const ownerDecision = shouldAdoptProcessOwner(apiInstanceId, gatewayRuntime);

    let bridge: BridgeSingletonWithOwner | undefined;
    let runtime: LoadedRuntime;
    let created = false;
    let rebuilt = false;
    let owner: BridgeOwner | undefined;
    let previousOwner: BridgeOwner | undefined;

    if (ownerDecision.adoptOwner) {
      const adopted = getBridgeSingleton(api);
      bridge = adopted.bridge;
      runtime = adopted.runtime;
      created = adopted.created;
      rebuilt = adopted.rebuilt;
      owner = adopted.owner;
      previousOwner = adopted.previousOwner;
      gatewayRuntime.currentBridge = bridge;
      if (rebuilt) {
        gatewayRuntime.serviceRegistered = false;
        gatewayRuntime.channelRegistered = false;
        gatewayRuntime.serviceOwnerApiInstanceId = undefined;
        gatewayRuntime.channelOwnerApiInstanceId = undefined;
      }
    } else {
      runtime = loadBncrRuntimeSync();
      bridge = gatewayRuntime.currentBridge || getExistingBridgeSingleton();
      previousOwner = getBridgeOwnerFromBridge(bridge);
      owner = previousOwner;
      if (bridge && !gatewayRuntime.currentBridge) {
        gatewayRuntime.currentBridge = bridge;
      }
    }

    globalTrace.seenApiInstanceIds.add(apiInstanceId);
    globalTrace.seenRegistryFingerprints.add(registryFingerprint);
    globalTrace.lastApiInstanceId = apiInstanceId;
    globalTrace.lastRegistryFingerprint = registryFingerprint;
    bridge?.noteRegister?.({
      source: '@xmoxmo/bncr',
      pluginVersion,
      apiRebound: ownerDecision.adoptOwner ? !created && !rebuilt : false,
      apiInstanceId: meta.apiInstanceId,
      registryFingerprint: meta.registryFingerprint,
    });
    const debugLog = (...args: unknown[]) => {
      const rendered = args
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join(' ')
        .trim();
      if (!rendered) return;
      emitBncrLogLine('info', `[bncr] debug ${rendered}`, { debugOnly: true }, () =>
        Boolean(bridge?.isDebugEnabled?.()),
      );
    };

    debugLog(
      `register begin bridge=${bridge?.getBridgeId?.() || 'unknown'} created=${created} rebuilt=${rebuilt} ` +
        `ownerApi=${owner?.apiInstanceId || 'none'} ownerRegistry=${owner?.registryFingerprint || 'none'} ` +
        `previousOwnerApi=${previousOwner?.apiInstanceId || 'none'} previousOwnerRegistry=${previousOwner?.registryFingerprint || 'none'}`,
    );
    debugLog(
      `register classify mode=${meta.registrationMode || 'unknown'} api=${apiInstanceId} registry=${registryFingerprint} ` +
        `sameApiAsPrevious=${sameApiAsPrevious} sameRegistryAsPrevious=${sameRegistryAsPrevious} ` +
        `firstSeenApi=${firstSeenApi} firstSeenRegistry=${firstSeenRegistry}`,
    );
    debugLog(
      `register owner adopt=${ownerDecision.adoptOwner} reason=${ownerDecision.reason} ` +
        `existingOwnerApi=${ownerDecision.existingOwnerApiInstanceId || 'none'}`,
    );
    if (!ownerDecision.adoptOwner) {
      debugLog(
        `bridge rebuild suppressed due to existing singleton owner api ${ownerDecision.existingOwnerApiInstanceId || 'unknown'}`,
      );
    } else {
      if (!created && !rebuilt) debugLog('bridge api rebound');
      if (rebuilt) debugLog('bridge rebuilt due to owner/runtime change');
    }

    const resolveDebug = async () => {
      try {
        const cfg = getOpenClawRuntimeConfig(api) as BncrDebugConfigRoot | null | undefined;
        return Boolean(cfg?.channels?.bncr?.debug?.verbose);
      } catch {
        return false;
      }
    };

    if (!gatewayRuntime.serviceRegistered) {
      const serviceStopHandler = async () => {
        await getCurrentBridge().stopService?.();
      };
      api.registerService({
        id: 'bncr-bridge-service',
        start: async (ctx) => {
          const debug = await resolveDebug();
          await getCurrentBridge().startService(ctx, debug);
        },
        stop: serviceStopHandler,
      });
      gatewayRuntime.serviceRegistered = true;
      gatewayRuntime.serviceOwnerApiInstanceId = apiInstanceId;
      meta.service = true;
      debugLog(`register service ok ownerApi=${apiInstanceId}`);
    } else {
      meta.service = true;
      debugLog(
        `register service skip (process singleton already registered by api ${gatewayRuntime.serviceOwnerApiInstanceId || 'unknown'})`,
      );
    }

    if (!gatewayRuntime.channelRegistered) {
      api.registerChannel({
        plugin: createDynamicChannelPlugin({ loaded: runtime, getCurrentBridge }) as ChannelPlugin,
      });
      gatewayRuntime.channelRegistered = true;
      gatewayRuntime.channelOwnerApiInstanceId = apiInstanceId;
      meta.channel = true;
      debugLog(`register channel ok ownerApi=${apiInstanceId}`);
    } else {
      meta.channel = true;
      debugLog(
        `register channel skip (process singleton already registered by api ${gatewayRuntime.channelOwnerApiInstanceId || 'unknown'})`,
      );
    }

    ensureGatewayMethodRegistered(api, 'bncr.connect', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.inbound', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.activity', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.ack', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.diagnostics', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.deadLetter.inspect', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.deadLetter.prune', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.file.init', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.file.chunk', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.file.complete', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.file.abort', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.file.ack', debugLog);
    debugLog('register done');
  },
};

export default plugin;
