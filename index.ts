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
  adoptLifecycleBridge,
  beginRetirement,
  canStartLifecycleRegistry,
  canStopLifecycleRegistry,
  commitLifecycle,
  ensureGatewayMethodRegistered,
  getBridgeOwnerFromBridge,
  getBridgeGenerationKey,
  getCurrentBridge,
  getExistingBridgeSingleton,
  getGatewayRuntime,
  getGlobalRegisterTrace,
  getLifecycleBridgeForStart,
  getRegisterMeta,
  getRegistryDeclaration,
  isLifecycleRegistryCurrent,
  markRegistryChannelDeclared,
  markRegistryRegistrationComplete,
  markRegistryServiceDeclared,
  noteRegisterTraceValue,
  planLifecycle,
  probeRegistryRuntimeObservation,
  pruneRegistryLedgers,
  recoverLifecycleRegistration,
  settleRetirement,
  failLifecycleStart,
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
    const apiSeenRecently = globalTrace.seenApiInstanceIds.has(apiInstanceId);
    const registrySeenRecently = globalTrace.seenRegistryFingerprints.has(registryFingerprint);

    let ownerDecision: ReturnType<typeof planLifecycle> | undefined;

    try {
      const gatewayRuntime = getGatewayRuntime();
      ownerDecision = planLifecycle(api);
      const lifecycleOwner = commitLifecycle(ownerDecision);
      let bridge: BridgeSingletonWithOwner | undefined;
      const runtime: LoadedRuntime = loadBncrRuntimeSync();
      let created = false;
      let rebuilt = false;
      let owner: BridgeOwner | undefined;
      let previousOwner: BridgeOwner | undefined;
      const shouldDeclareLifecycle =
        ownerDecision.kind === 'initialize' ||
        ownerDecision.kind === 'takeover' ||
        ownerDecision.kind === 'defer';

      if (ownerDecision.kind === 'initialize') {
        if (lifecycleOwner) {
          const adopted = adoptLifecycleBridge(api, lifecycleOwner, 'create');
          bridge = adopted.bridge;
          created = adopted.created;
          rebuilt = adopted.rebuilt;
          owner = adopted.owner;
          previousOwner = adopted.previousOwner;
        }
      } else if (ownerDecision.kind === 'takeover') {
        if (lifecycleOwner) {
          const adopted = adoptLifecycleBridge(api, lifecycleOwner, ownerDecision.mode);
          bridge = adopted.bridge;
          created = adopted.created;
          rebuilt = adopted.rebuilt;
          owner = adopted.owner;
          previousOwner = adopted.previousOwner;
        }
      } else if (ownerDecision.kind === 'defer') {
        bridge = gatewayRuntime.currentBridge || getExistingBridgeSingleton();
        previousOwner = getBridgeOwnerFromBridge(bridge);
        owner = previousOwner;
      } else {
        bridge = gatewayRuntime.currentBridge || getExistingBridgeSingleton();
        previousOwner = getBridgeOwnerFromBridge(bridge);
        owner = previousOwner;
        if (bridge && !gatewayRuntime.currentBridge) {
          gatewayRuntime.currentBridge = bridge;
        }
      }

      /*
       * A duplicate or rejected registration must never adopt or rebuild the
       * process bridge. It still registers methods for its own registry.
       */
      if (bridge && !gatewayRuntime.currentBridge) {
        gatewayRuntime.currentBridge = bridge;
      }

      noteRegisterTraceValue(globalTrace.seenApiInstanceIds, apiInstanceId);
      noteRegisterTraceValue(globalTrace.seenRegistryFingerprints, registryFingerprint);
      globalTrace.lastApiInstanceId = apiInstanceId;
      globalTrace.lastRegistryFingerprint = registryFingerprint;
      bridge?.noteRegister?.({
        source: '@xmoxmo/bncr',
        pluginVersion,
        apiRebound: ownerDecision.kind === 'takeover' && !created && !rebuilt,
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
          `apiSeenRecently=${apiSeenRecently} registrySeenRecently=${registrySeenRecently}`,
      );
      debugLog(
        `register lifecycle decision=${ownerDecision.kind} reason=${ownerDecision.reason} ` +
          `generation=${ownerDecision.owner.key.generation} ` +
          `existingOwnerApi=${previousOwner?.apiInstanceId || 'none'}`,
      );
      if (!shouldDeclareLifecycle) {
        debugLog(
          `service/channel declaration suppressed for ${ownerDecision.kind} registry=${registryFingerprint}`,
        );
      }

      const resolveDebug = async () => {
        try {
          const cfg = getOpenClawRuntimeConfig(api) as BncrDebugConfigRoot | null | undefined;
          return Boolean(cfg?.channels?.bncr?.debug?.verbose);
        } catch {
          return false;
        }
      };

      const registryGeneration = ownerDecision.owner.key.generation;
      const registryBridgeGenerationKey = getBridgeGenerationKey(
        ownerDecision.owner.bridgeGeneration,
      );
      /*
       * A rejected registration must remain fail-closed. Creating a shadow
       * declaration here would make its gateway methods dispatch to the
       * current bridge even though the registration never owned a lifecycle.
       */
      const registryDeclaration =
        ownerDecision.kind === 'reject'
          ? gatewayRuntime.registryDeclarations.get(registryFingerprint)
          : getRegistryDeclaration(
              registryFingerprint,
              registryBridgeGenerationKey,
              registryGeneration,
            );
      const serviceDeclaredForGeneration = registryDeclaration?.service === 'declared';
      const channelDeclaredForGeneration = registryDeclaration?.channel === 'declared';

      if (shouldDeclareLifecycle && !serviceDeclaredForGeneration) {
        const serviceStopHandler = async () => {
          const retirement = beginRetirement(registryFingerprint, registryGeneration);
          if (!retirement) {
            debugLog(`service stop suppressed for stale registry=${registryFingerprint}`);
            return;
          }

          try {
            await getCurrentBridge().stopService?.();
            settleRetirement(registryFingerprint, { ok: true }, registryGeneration);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            settleRetirement(registryFingerprint, { ok: false, error: detail }, registryGeneration);
            throw error;
          }
        };
        api.registerService({
          id: 'bncr-bridge-service',
          start: async (ctx) => {
            const lifecycleBridge = await getLifecycleBridgeForStart(
              api,
              registryFingerprint,
              registryGeneration,
            );
            if (!lifecycleBridge) {
              debugLog(`service start suppressed for stale registry=${registryFingerprint}`);
              return;
            }
            const debug = await resolveDebug();
            if (!canStartLifecycleRegistry(registryFingerprint, registryGeneration)) {
              debugLog(
                `service start suppressed after await for stale registry=${registryFingerprint}`,
              );
              return;
            }
            try {
              const started = await lifecycleBridge.startService(ctx, debug, () =>
                isLifecycleRegistryCurrent(registryFingerprint, registryGeneration),
              );
              if (
                started === false ||
                !canStartLifecycleRegistry(registryFingerprint, registryGeneration)
              ) {
                debugLog(
                  `service start suppressed after await for stale registry=${registryFingerprint}`,
                );
                return;
              }
              probeRegistryRuntimeObservation(
                registryFingerprint,
                registryBridgeGenerationKey,
                registryGeneration,
              );
            } catch (error) {
              failLifecycleStart(registryFingerprint, error, registryGeneration);
              throw error;
            }
          },
          stop: serviceStopHandler,
        });
        markRegistryServiceDeclared(
          registryFingerprint,
          registryBridgeGenerationKey,
          registryGeneration,
        );
        meta.service = true;
        debugLog(`register service ok ownerApi=${apiInstanceId}`);
      } else {
        meta.service = registryDeclaration?.service === 'declared';
        debugLog(
          `register service skip registry=${registryFingerprint} declared=${registryDeclaration?.service || 'missing'}`,
        );
      }

      if (shouldDeclareLifecycle && !channelDeclaredForGeneration) {
        api.registerChannel({
          plugin: createDynamicChannelPlugin({
            loaded: runtime,
            getCurrentBridge,
            resolveBridgeForStart: async () => {
              const lifecycleBridge = await getLifecycleBridgeForStart(
                api,
                registryFingerprint,
                registryGeneration,
              );
              if (!lifecycleBridge) {
                throw new Error(`bncr lifecycle registry is inactive: ${registryFingerprint}`);
              }
              return lifecycleBridge;
            },
            isBridgeForStartCurrent: () =>
              canStartLifecycleRegistry(registryFingerprint, registryGeneration),
            onBridgeStartObserved: () =>
              probeRegistryRuntimeObservation(
                registryFingerprint,
                registryBridgeGenerationKey,
                registryGeneration,
              ),
            resolveBridgeForStop: () => {
              if (!canStopLifecycleRegistry(registryFingerprint, registryGeneration)) {
                debugLog(`channel stop suppressed for stale registry=${registryFingerprint}`);
                return null;
              }
              return getCurrentBridge();
            },
            isBridgeForStopCurrent: () =>
              canStopLifecycleRegistry(registryFingerprint, registryGeneration),
          }) as ChannelPlugin,
        });
        markRegistryChannelDeclared(
          registryFingerprint,
          registryBridgeGenerationKey,
          registryGeneration,
        );
        meta.channel = true;
        debugLog(`register channel ok ownerApi=${apiInstanceId}`);
      } else {
        meta.channel = registryDeclaration?.channel === 'declared';
        debugLog(
          `register channel skip registry=${registryFingerprint} declared=${registryDeclaration?.channel || 'missing'}`,
        );
      }

      ensureGatewayMethodRegistered(api, 'bncr.connect', debugLog);
      ensureGatewayMethodRegistered(api, 'bncr.inbound', debugLog);
      ensureGatewayMethodRegistered(api, 'bncr.activity', debugLog);
      ensureGatewayMethodRegistered(api, 'bncr.ack', debugLog);
      ensureGatewayMethodRegistered(api, 'bncr.diagnostics', debugLog);
      ensureGatewayMethodRegistered(api, 'bncr.deadLetter.inspect', debugLog);
      ensureGatewayMethodRegistered(api, 'bncr.deadLetter.prune', debugLog);
      ensureGatewayMethodRegistered(api, 'bncr.rpc.response', debugLog);
      ensureGatewayMethodRegistered(api, 'bncr.file.init', debugLog);
      ensureGatewayMethodRegistered(api, 'bncr.file.chunk', debugLog);
      ensureGatewayMethodRegistered(api, 'bncr.file.complete', debugLog);
      ensureGatewayMethodRegistered(api, 'bncr.file.abort', debugLog);
      ensureGatewayMethodRegistered(api, 'bncr.file.ack', debugLog);
      if (ownerDecision.kind !== 'reject') {
        markRegistryRegistrationComplete(
          registryFingerprint,
          registryBridgeGenerationKey,
          registryGeneration,
        );
      }
      pruneRegistryLedgers();
      debugLog('register done');
    } catch (error) {
      const recovered = ownerDecision
        ? recoverLifecycleRegistration(ownerDecision, error)
        : 'plan-not-committed';
      emitBncrLogLine(
        'error',
        `[bncr] register failed recovered=${recovered} error=${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  },
};

export default plugin;
