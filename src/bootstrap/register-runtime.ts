import { emitBncrLogLine } from '../core/logging.ts';
import {
  activatePendingLifecycle,
  beginLifecycleRetirement,
  commitLifecycleAdoption,
  createRegisterLifecycleState,
  failLifecycle,
  getBridgeGenerationKey,
  getPendingLifecycle,
  isLifecycleRegistryActive,
  isLifecycleRegistryStoppable,
  type LifecycleAdoptionDecision,
  type LifecycleOwner,
  type LifecyclePlanInput,
  type LifecycleRetirementOutcome,
  planLifecycleAdoption,
  reactivateStoppedLifecycle,
  settleLifecycleRetirement,
} from './register-lifecycle.ts';
import {
  type BncrGatewayMethodName,
  createBncrGatewayMethodRegistry,
} from './register-runtime-gateway.ts';
import type { BridgeOwner, BridgeRegisterStateCarrier } from './register-runtime-helpers.ts';
import {
  createRegistryRuntimeObservation,
  evaluateRegistryRuntimeObservation,
  normalizeRegistryRuntimeObservation,
  REGISTRY_RUNTIME_OBSERVATION_POLL_MS,
  type RegistryRuntimeObservation,
  type RegistryRuntimeProbe,
} from './register-runtime-observation.ts';
import { createBncrBridgeSingletonManager } from './register-runtime-singleton.ts';
import {
  type ChannelModule,
  type LoadedRuntime,
  loadBncrRuntimeSync,
  pluginFile,
  pluginRoot,
  pluginVersion,
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

type RegistryDeclarationSlot = 'missing' | 'declared';
type RegistryDeclarationRegistration = 'pending' | 'complete' | 'failed';

type RegistryDeclaration = {
  bridgeGenerationKey: string;
  lifecycleGeneration: number;
  service: RegistryDeclarationSlot;
  channel: RegistryDeclarationSlot;
  registration: RegistryDeclarationRegistration;
  state: 'shadow' | 'active' | 'retired';
  runtimeObservation?: RegistryRuntimeObservation;
};

type RegistryRuntimeObservationTimer = {
  timer: NodeJS.Timeout;
  bridgeGenerationKey: string;
  lifecycleGeneration: number;
};

type BncrGatewayRuntime = {
  currentBridge?: BridgeSingletonWithState;
  registeredMethodsByRegistry: Map<string, Set<BncrGatewayMethodName>>;
  gatewayMethodDispatchers?: Partial<
    Record<
      BncrGatewayMethodName,
      (
        bridge: BridgeSingletonWithState,
        opts: BridgeGatewayHandlerContext,
      ) => BridgeGatewayHandlerResult
    >
  >;
  registryDeclarations: Map<string, RegistryDeclaration>;
  runtimeObservationTimers: Map<string, RegistryRuntimeObservationTimer>;
  lifecycle: ReturnType<typeof createRegisterLifecycleState>;
};

type LegacyBncrGatewayRuntime = Partial<BncrGatewayRuntime> & {
  serviceRegistered?: boolean;
  channelRegistered?: boolean;
  serviceOwnerApiInstanceId?: string;
  channelOwnerApiInstanceId?: string;
};

const registerMetaSymbol = Symbol.for('bncr.register.meta');
const globalRegisterTraceSymbol = Symbol.for('bncr.global.register.trace');
const bridgeOwnerSymbol = Symbol.for('bncr.bridge.owner');
const gatewayRuntimeSymbol = Symbol.for('bncr.gateway.runtime');
const maxRegistryDeclarations = 6;
const maxRegisterTraceEntries = 64;
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

const rememberRegisterTraceValue = (values: Set<string>, value: string) => {
  // The trace is diagnostic only. Remember recency without retaining every
  // registration fingerprint for the lifetime of the Gateway process.
  values.delete(value);
  values.add(value);
  while (values.size > maxRegisterTraceEntries) {
    const oldest = values.values().next().value;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
};

const normalizeRegistryDeclaration = (value: unknown): RegistryDeclaration => {
  const legacy = (value || {}) as {
    bridgeGenerationKey?: unknown;
    lifecycleGeneration?: unknown;
    generation?: unknown;
    service?: unknown;
    channel?: unknown;
    registration?: unknown;
    state?: unknown;
    runtimeObservation?: unknown;
  };
  const service = legacy.service === 'declared' || legacy.service === true ? 'declared' : 'missing';
  const channel = legacy.channel === 'declared' || legacy.channel === true ? 'declared' : 'missing';
  const registration =
    legacy.registration === 'pending' ||
    legacy.registration === 'complete' ||
    legacy.registration === 'failed'
      ? legacy.registration
      : service === 'declared' && channel === 'declared'
        ? 'complete'
        : 'failed';
  const state = legacy.state === 'active' || legacy.state === 'retired' ? legacy.state : 'shadow';
  const lifecycleGeneration =
    typeof legacy.lifecycleGeneration === 'number'
      ? legacy.lifecycleGeneration
      : typeof legacy.generation === 'number'
        ? legacy.generation
        : 0;
  return {
    bridgeGenerationKey:
      typeof legacy.bridgeGenerationKey === 'string' ? legacy.bridgeGenerationKey : '',
    lifecycleGeneration,
    service,
    channel,
    registration,
    state,
    runtimeObservation: normalizeRegistryRuntimeObservation(legacy.runtimeObservation),
  };
};

const normalizeRegistryDeclarationInPlace = (value: unknown): RegistryDeclaration => {
  const normalized = normalizeRegistryDeclaration(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;

  const target = value as Record<string, unknown>;
  delete target.generation;
  Object.assign(target, normalized);
  return value as RegistryDeclaration;
};

const pruneRegistryLedgers = (runtime: BncrGatewayRuntime) => {
  const protectedRegistries = new Set(
    [
      runtime.lifecycle.active?.key.registryFingerprint,
      runtime.lifecycle.pending?.key.registryFingerprint,
    ].filter((value): value is string => Boolean(value)),
  );
  for (const ledger of [runtime.registryDeclarations, runtime.registeredMethodsByRegistry]) {
    for (const registryFingerprint of ledger.keys()) {
      if (ledger.size <= maxRegistryDeclarations) break;
      if (!protectedRegistries.has(registryFingerprint)) {
        const timer = runtime.runtimeObservationTimers.get(registryFingerprint);
        if (timer) {
          clearTimeout(timer.timer);
          runtime.runtimeObservationTimers.delete(registryFingerprint);
        }
        ledger.delete(registryFingerprint);
      }
    }
  }
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
    'bncr.rpc.response': (bridge, opts) => bridge.handleRpcResponse(opts),
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
        registryDeclarations: new Map<string, RegistryDeclaration>(),
        runtimeObservationTimers: new Map<string, RegistryRuntimeObservationTimer>(),
        lifecycle: createRegisterLifecycleState(),
      };
    }
    const runtime = p[gatewayRuntimeSymbol] as LegacyBncrGatewayRuntime;
    if (!(runtime.registeredMethodsByRegistry instanceof Map)) {
      runtime.registeredMethodsByRegistry = new Map<string, Set<BncrGatewayMethodName>>();
    }
    if (!(runtime.registryDeclarations instanceof Map)) {
      runtime.registryDeclarations = new Map<string, RegistryDeclaration>();
    } else {
      for (const [registryFingerprint, declaration] of runtime.registryDeclarations) {
        const normalized = normalizeRegistryDeclarationInPlace(declaration);
        if (normalized !== declaration) {
          runtime.registryDeclarations.set(registryFingerprint, normalized);
        }
      }
    }
    if (!(runtime.runtimeObservationTimers instanceof Map)) {
      runtime.runtimeObservationTimers = new Map<string, RegistryRuntimeObservationTimer>();
    }
    if (!runtime.lifecycle) {
      runtime.lifecycle = createRegisterLifecycleState();
    }
    return runtime as BncrGatewayRuntime;
  };

  const getBridgeRegisterStateCarrier = (bridge: BridgeSingleton): BridgeRegisterStateCarrier =>
    bridge as unknown as BridgeRegisterStateCarrier;

  const gatewayMethodRegistry = createBncrGatewayMethodRegistry({
    getRegisterMeta,
    getRegistryFingerprint,
    getGatewayRuntime,
    gatewayMethodDispatchers,
    getBridgeRegisterStateCarrier,
    getRegistryRuntimeObservation: (registryFingerprint) =>
      getRegistryRuntimeObservation(registryFingerprint),
  });

  const getBridgeOwner = (api: OpenClawPluginApi, loaded: LoadedRuntime): BridgeOwner => {
    const meta = getRegisterMeta(api);
    return {
      moduleEpoch,
      bridgeFactoryId: getIdentityId(loaded.createBncrBridge as object, 'bridgeFactory'),
      apiInstanceId: meta.apiInstanceId || 'unknown',
      registryFingerprint: meta.registryFingerprint || 'unknown',
      registrationMode: meta.registrationMode,
      pluginVersion,
      pluginRoot,
      pluginFile,
    };
  };

  const bridgeSingletonManager = createBncrBridgeSingletonManager({
    bridgeOwnerSymbol,
    pluginRoot,
    pluginFile,
    loadBncrRuntimeSync,
    getBridgeOwner,
  });

  const toBridgeOwner = (owner: LifecycleOwner): BridgeOwner => ({
    moduleEpoch: owner.bridgeGeneration.moduleEpoch,
    bridgeFactoryId: owner.bridgeGeneration.bridgeFactoryId,
    apiInstanceId: owner.key.apiInstanceId,
    registryFingerprint: owner.key.registryFingerprint,
    registrationMode: owner.bridgeGeneration.registrationMode,
    pluginVersion: owner.bridgeGeneration.pluginVersion,
    pluginRoot: owner.bridgeGeneration.pluginRoot,
    pluginFile: owner.bridgeGeneration.pluginFile,
  });

  const getCurrentBridge = (): BridgeSingletonWithState => {
    const bridge = getGatewayRuntime().currentBridge;
    if (!bridge) throw new Error('bncr current bridge unavailable');
    return bridge;
  };

  const clearRegistryRuntimeObservationTimer = (registryFingerprint: string) => {
    const runtime = getGatewayRuntime();
    const entry = runtime.runtimeObservationTimers.get(registryFingerprint);
    if (entry) {
      clearTimeout(entry.timer);
      runtime.runtimeObservationTimers.delete(registryFingerprint);
    }
  };

  const readRegistryRuntimeProbe = (): RegistryRuntimeProbe => {
    const bridge = getGatewayRuntime().currentBridge as
      | (BridgeSingletonWithState & {
          getRuntimeObservation?: () => RegistryRuntimeProbe | undefined;
        })
      | undefined;
    const probe = bridge?.getRuntimeObservation?.();
    return probe && typeof probe === 'object' ? probe : {};
  };

  const isRegistryRuntimeLifecycleActive = (
    registryFingerprint: string,
    lifecycleGeneration: number,
  ) => {
    const active = getGatewayRuntime().lifecycle.active;
    return Boolean(
      active &&
        active.key.registryFingerprint === registryFingerprint &&
        active.key.generation === lifecycleGeneration &&
        (active.phase === 'active' || active.phase === 'registering'),
    );
  };

  const probeRegistryRuntimeObservation = (
    registryFingerprint: string,
    bridgeGenerationKey: string,
    lifecycleGeneration: number,
    now = Date.now(),
  ): RegistryRuntimeObservation | null => {
    try {
      const runtime = getGatewayRuntime();
      const declaration = runtime.registryDeclarations.get(registryFingerprint);
      if (
        !declaration ||
        declaration.bridgeGenerationKey !== bridgeGenerationKey ||
        declaration.lifecycleGeneration !== lifecycleGeneration ||
        !declaration.runtimeObservation
      ) {
        return null;
      }

      const decision = evaluateRegistryRuntimeObservation({
        observation: declaration.runtimeObservation,
        now,
        lifecycleActive:
          declaration.registration === 'complete' &&
          declaration.state === 'active' &&
          isRegistryRuntimeLifecycleActive(registryFingerprint, lifecycleGeneration),
        probe: readRegistryRuntimeProbe(),
      });
      declaration.runtimeObservation = decision.observation;

      if (decision.transitionedToPolling) {
        emitBncrLogLine(
          'warn',
          `[bncr] runtime observation timeout registry=${registryFingerprint} generation=${lifecycleGeneration} service=${decision.observation.serviceObservedAt !== null} channel=${decision.observation.channelObservedAt !== null} action=poll intervalMs=${REGISTRY_RUNTIME_OBSERVATION_POLL_MS}`,
        );
      }
      if (decision.transitionedToReady) {
        emitBncrLogLine(
          'info',
          `[bncr] runtime observation ready registry=${registryFingerprint} generation=${lifecycleGeneration} probes=${decision.observation.probeCount}`,
        );
      }

      if (decision.action === 'wait' || decision.action === 'poll') {
        clearRegistryRuntimeObservationTimer(registryFingerprint);
        const delay =
          decision.action === 'poll'
            ? REGISTRY_RUNTIME_OBSERVATION_POLL_MS
            : Math.max(0, decision.observation.deadlineAt - now);
        const timer = setTimeout(() => {
          const current = runtime.runtimeObservationTimers.get(registryFingerprint);
          if (current?.timer !== timer) return;
          runtime.runtimeObservationTimers.delete(registryFingerprint);
          probeRegistryRuntimeObservation(
            registryFingerprint,
            bridgeGenerationKey,
            lifecycleGeneration,
            Date.now(),
          );
        }, delay);
        timer.unref?.();
        runtime.runtimeObservationTimers.set(registryFingerprint, {
          timer,
          bridgeGenerationKey,
          lifecycleGeneration,
        });
      } else {
        clearRegistryRuntimeObservationTimer(registryFingerprint);
      }

      return { ...decision.observation };
    } catch (error) {
      try {
        emitBncrLogLine(
          'warn',
          `[bncr] runtime observation probe failed registry=${registryFingerprint} generation=${lifecycleGeneration} error=${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // Runtime observation is diagnostic-only and must never affect startup.
      }
      try {
        const runtime = getGatewayRuntime();
        const declaration = runtime.registryDeclarations.get(registryFingerprint);
        if (
          declaration?.bridgeGenerationKey === bridgeGenerationKey &&
          declaration.lifecycleGeneration === lifecycleGeneration &&
          declaration.registration === 'complete' &&
          declaration.state === 'active'
        ) {
          clearRegistryRuntimeObservationTimer(registryFingerprint);
          const timer = setTimeout(() => {
            const current = runtime.runtimeObservationTimers.get(registryFingerprint);
            if (current?.timer !== timer) return;
            runtime.runtimeObservationTimers.delete(registryFingerprint);
            probeRegistryRuntimeObservation(
              registryFingerprint,
              bridgeGenerationKey,
              lifecycleGeneration,
              Date.now(),
            );
          }, REGISTRY_RUNTIME_OBSERVATION_POLL_MS);
          timer.unref?.();
          runtime.runtimeObservationTimers.set(registryFingerprint, {
            timer,
            bridgeGenerationKey,
            lifecycleGeneration,
          });
        }
      } catch {
        // A failed diagnostic probe must not affect service or channel startup.
      }
      return null;
    }
  };

  const startRegistryRuntimeObservation = (
    registryFingerprint: string,
    bridgeGenerationKey: string,
    lifecycleGeneration: number,
    now = Date.now(),
    reset = false,
  ) => {
    const runtime = getGatewayRuntime();
    const declaration = runtime.registryDeclarations.get(registryFingerprint);
    if (
      !declaration ||
      declaration.bridgeGenerationKey !== bridgeGenerationKey ||
      declaration.lifecycleGeneration !== lifecycleGeneration ||
      declaration.registration !== 'complete' ||
      declaration.state !== 'active'
    ) {
      return null;
    }
    if (!reset && declaration.runtimeObservation) {
      return { ...declaration.runtimeObservation };
    }

    clearRegistryRuntimeObservationTimer(registryFingerprint);
    declaration.runtimeObservation = createRegistryRuntimeObservation(now);
    return probeRegistryRuntimeObservation(
      registryFingerprint,
      bridgeGenerationKey,
      lifecycleGeneration,
      now,
    );
  };

  const retireRegistryRuntimeObservation = (registryFingerprint: string, now = Date.now()) => {
    clearRegistryRuntimeObservationTimer(registryFingerprint);
    const declaration = getGatewayRuntime().registryDeclarations.get(registryFingerprint);
    if (!declaration?.runtimeObservation) return;
    declaration.runtimeObservation = {
      ...declaration.runtimeObservation,
      phase: 'retired',
      retiredAt: declaration.runtimeObservation.retiredAt ?? now,
    };
  };

  const getRegistryRuntimeObservation = (registryFingerprint: string) => {
    const runtime = getGatewayRuntime();
    const declaration = runtime.registryDeclarations.get(registryFingerprint);
    if (declaration?.state === 'active' && declaration.runtimeObservation) {
      return { ...declaration.runtimeObservation };
    }

    const activeRegistry = runtime.lifecycle.active?.key.registryFingerprint;
    if (activeRegistry && activeRegistry !== registryFingerprint) {
      const activeObservation =
        runtime.registryDeclarations.get(activeRegistry)?.runtimeObservation;
      if (activeObservation) return { ...activeObservation };
    }

    return declaration?.runtimeObservation ? { ...declaration.runtimeObservation } : null;
  };

  const planLifecycle = (api: OpenClawPluginApi, now = Date.now()): LifecycleAdoptionDecision => {
    const loaded = loadBncrRuntimeSync();
    const owner = getBridgeOwner(api, loaded);
    const runtime = getGatewayRuntime();
    const input: LifecyclePlanInput = {
      apiInstanceId: owner.apiInstanceId,
      registryFingerprint: owner.registryFingerprint,
      bridgeGeneration: {
        moduleEpoch: owner.moduleEpoch,
        bridgeFactoryId: owner.bridgeFactoryId,
        pluginVersion: owner.pluginVersion || 'unknown',
        registrationMode: owner.registrationMode || 'unknown',
        pluginRoot: owner.pluginRoot || pluginRoot,
        pluginFile: owner.pluginFile || pluginFile,
      },
      now,
    };
    const decision = planLifecycleAdoption(runtime.lifecycle, input);
    const declaration = runtime.registryDeclarations.get(owner.registryFingerprint);
    if (!declaration) return decision;

    const bridgeGenerationKey = getBridgeGenerationKey(input.bridgeGeneration);
    if (!declaration.bridgeGenerationKey) {
      // Legacy runtimes did not persist the bridge identity in the ledger.
      declaration.bridgeGenerationKey = bridgeGenerationKey;
    } else if (declaration.bridgeGenerationKey !== bridgeGenerationKey) {
      return {
        kind: 'reject',
        owner: decision.owner,
        reason: 'registration-generation-conflict',
      };
    }
    if (declaration.registration === 'failed') {
      return {
        kind: 'reject',
        owner: decision.owner,
        reason: 'registration-failed',
      };
    }
    if (declaration.registration === 'pending') {
      return {
        kind: 'reject',
        owner: decision.owner,
        reason: 'registration-in-progress',
      };
    }
    return decision;
  };

  const commitLifecycle = (decision: LifecycleAdoptionDecision) => {
    const runtime = getGatewayRuntime();
    if (decision.kind === 'initialize' || decision.kind === 'takeover') {
      runtime.gatewayMethodDispatchers = gatewayMethodDispatchers;
    }
    const owner = commitLifecycleAdoption(runtime.lifecycle, decision);
    const requestedRegistry = decision.owner.key.registryFingerprint;
    const requestedGeneration = decision.owner.key.generation;
    const requestedBridgeGenerationKey = getBridgeGenerationKey(decision.owner.bridgeGeneration);

    if (decision.kind === 'initialize' || decision.kind === 'takeover') {
      for (const [registryFingerprint, declaration] of runtime.registryDeclarations) {
        if (registryFingerprint !== owner?.key.registryFingerprint) {
          declaration.state = 'retired';
          retireRegistryRuntimeObservation(registryFingerprint);
        }
      }
      const declaration = getRegistryDeclaration(
        requestedRegistry,
        requestedBridgeGenerationKey,
        requestedGeneration,
      );
      if (
        declaration.bridgeGenerationKey &&
        declaration.bridgeGenerationKey !== requestedBridgeGenerationKey
      ) {
        declaration.service = 'missing';
        declaration.channel = 'missing';
      }
      declaration.bridgeGenerationKey = requestedBridgeGenerationKey;
      declaration.lifecycleGeneration = requestedGeneration;
      declaration.registration = 'pending';
      declaration.state = 'active';
      declaration.runtimeObservation = undefined;
    } else if (decision.kind === 'defer') {
      const declaration = getRegistryDeclaration(
        requestedRegistry,
        requestedBridgeGenerationKey,
        requestedGeneration,
      );
      if (
        declaration.bridgeGenerationKey &&
        declaration.bridgeGenerationKey !== requestedBridgeGenerationKey
      ) {
        declaration.service = 'missing';
        declaration.channel = 'missing';
      }
      declaration.bridgeGenerationKey = requestedBridgeGenerationKey;
      declaration.lifecycleGeneration = requestedGeneration;
      declaration.registration = 'pending';
      declaration.state = 'shadow';
      declaration.runtimeObservation = undefined;
    } else if (decision.kind === 'duplicate') {
      const existing = runtime.registryDeclarations.get(requestedRegistry);
      if (!existing) {
        const declaration = getRegistryDeclaration(
          requestedRegistry,
          requestedBridgeGenerationKey,
          requestedGeneration,
        );
        declaration.registration = 'pending';
        declaration.state = 'shadow';
      } else if (
        !existing.bridgeGenerationKey ||
        existing.bridgeGenerationKey === requestedBridgeGenerationKey
      ) {
        existing.bridgeGenerationKey ||= requestedBridgeGenerationKey;
        const activeRegistry = runtime.lifecycle.active?.key.registryFingerprint;
        const pendingRegistry = runtime.lifecycle.pending?.key.registryFingerprint;
        if (requestedRegistry === activeRegistry && runtime.lifecycle.active?.phase !== 'stopped') {
          existing.state = 'active';
        } else if (requestedRegistry === pendingRegistry) {
          existing.state = 'shadow';
        }
      }
    }
    pruneRegistryLedgers(runtime);
    return owner;
  };

  const adoptLifecycleBridge = (
    api: OpenClawPluginApi,
    owner: LifecycleOwner,
    mode: 'reuse' | 'replace' | 'create',
  ) => {
    try {
      const adopted = bridgeSingletonManager.adoptBridgeSingleton(api, toBridgeOwner(owner), mode);
      getGatewayRuntime().currentBridge = adopted.bridge;
      return adopted;
    } catch (error) {
      const lifecycle = getGatewayRuntime().lifecycle;
      if (
        lifecycle.active?.key.generation === owner.key.generation &&
        lifecycle.active.key.registryFingerprint === owner.key.registryFingerprint
      ) {
        failLifecycle(lifecycle, owner.key.registryFingerprint, error, owner.key.generation);
        const declaration = getRegistryDeclaration(
          owner.key.registryFingerprint,
          getBridgeGenerationKey(owner.bridgeGeneration),
          owner.key.generation,
        );
        declaration.registration = 'failed';
        declaration.state = 'retired';
        retireRegistryRuntimeObservation(owner.key.registryFingerprint);
      }
      throw error;
    }
  };

  const beginRetirement = (
    registryFingerprint: string,
    expectedGeneration: number,
    now = Date.now(),
  ) => {
    const retirement = beginLifecycleRetirement(
      getGatewayRuntime().lifecycle,
      registryFingerprint,
      now,
      expectedGeneration,
    );
    if (retirement) {
      retireRegistryRuntimeObservation(registryFingerprint, now);
    }
    return retirement;
  };

  const settleRetirement = (
    registryFingerprint: string,
    outcome: LifecycleRetirementOutcome,
    expectedGeneration: number,
    now = Date.now(),
  ) => {
    const settled = settleLifecycleRetirement(
      getGatewayRuntime().lifecycle,
      registryFingerprint,
      outcome,
      now,
      expectedGeneration,
    );
    if (settled) {
      const lifecycle = getGatewayRuntime().lifecycle;
      const declaration = getRegistryDeclaration(registryFingerprint);
      if (!outcome.ok) {
        declaration.state = 'retired';
        retireRegistryRuntimeObservation(registryFingerprint, now);
        const pendingRegistry = lifecycle.pending?.key.registryFingerprint;
        if (pendingRegistry && pendingRegistry !== registryFingerprint) {
          getRegistryDeclaration(pendingRegistry).state = 'retired';
          retireRegistryRuntimeObservation(pendingRegistry, now);
        }
      } else {
        declaration.state =
          lifecycle.pending?.key.registryFingerprint === registryFingerprint ? 'shadow' : 'retired';
        retireRegistryRuntimeObservation(registryFingerprint, now);
      }
    }
    return settled;
  };

  const getLifecycleBridgeForStart = async (
    api: OpenClawPluginApi,
    registryFingerprint: string,
    expectedGeneration: number,
  ) => {
    const runtime = getGatewayRuntime();
    const state = runtime.lifecycle;
    if (runtime.registryDeclarations.get(registryFingerprint)?.registration === 'failed') {
      state.staleCallbackSuppressions += 1;
      return null;
    }

    if (isLifecycleRegistryActive(state, registryFingerprint, expectedGeneration)) {
      getRegistryDeclaration(registryFingerprint).state = 'active';
      startRegistryRuntimeObservation(
        registryFingerprint,
        getBridgeGenerationKey(state.active!.bridgeGeneration),
        expectedGeneration,
      );
      return runtime.currentBridge || null;
    }

    const pending = getPendingLifecycle(state);
    if (
      pending?.key.registryFingerprint === registryFingerprint &&
      pending.key.generation === expectedGeneration
    ) {
      const pendingMode = state.pendingMode || 'reuse';
      const retirement = state.retirement;
      const outcome = retirement ? await retirement : { ok: true as const };
      if (!outcome.ok) {
        throw new Error(`bncr lifecycle predecessor stop failed: ${outcome.error}`);
      }
      const activated = activatePendingLifecycle(
        state,
        registryFingerprint,
        Date.now(),
        expectedGeneration,
      );
      if (activated) {
        getRegistryDeclaration(registryFingerprint).state = 'active';
        const bridge = adoptLifecycleBridge(api, activated, pendingMode).bridge;
        runtime.gatewayMethodDispatchers = gatewayMethodDispatchers;
        startRegistryRuntimeObservation(
          registryFingerprint,
          getBridgeGenerationKey(activated.bridgeGeneration),
          expectedGeneration,
          Date.now(),
          true,
        );
        return bridge;
      }
      // Another concurrent start for this same pending generation may already
      // have won the activation race while this call awaited the barrier.
    }

    const reactivated = reactivateStoppedLifecycle(
      state,
      registryFingerprint,
      Date.now(),
      expectedGeneration,
    );
    if (reactivated) {
      getRegistryDeclaration(registryFingerprint).state = 'active';
      const bridge = adoptLifecycleBridge(api, reactivated, 'reuse').bridge;
      runtime.gatewayMethodDispatchers = gatewayMethodDispatchers;
      startRegistryRuntimeObservation(
        registryFingerprint,
        getBridgeGenerationKey(reactivated.bridgeGeneration),
        expectedGeneration,
        Date.now(),
        true,
      );
      return bridge;
    }

    // Re-read ownership after every await/activation attempt: a concurrent
    // start for the same generation can legitimately have activated it first.
    if (isLifecycleRegistryActive(state, registryFingerprint, expectedGeneration)) {
      getRegistryDeclaration(registryFingerprint).state = 'active';
      startRegistryRuntimeObservation(
        registryFingerprint,
        getBridgeGenerationKey(state.active!.bridgeGeneration),
        expectedGeneration,
      );
      return runtime.currentBridge || null;
    }

    state.staleCallbackSuppressions += 1;
    return null;
  };

  const failLifecycleStart = (
    registryFingerprint: string,
    error: unknown,
    expectedGeneration: number,
  ) => {
    const failed = failLifecycle(
      getGatewayRuntime().lifecycle,
      registryFingerprint,
      error,
      expectedGeneration,
    );
    if (failed) {
      getRegistryDeclaration(registryFingerprint).state = 'retired';
      retireRegistryRuntimeObservation(registryFingerprint);
    }
    return failed;
  };

  /*
   * Best-effort repair for a registration that committed its lifecycle but
   * failed before finishing its service/channel declarations. Nothing of this
   * generation has started yet, so returning to a normal state is safe and
   * lets the next registration recover instead of being suppressed forever.
   */
  const recoverLifecycleRegistration = (decision: LifecycleAdoptionDecision, error: unknown) => {
    const runtime = getGatewayRuntime();
    const state = runtime.lifecycle;
    const owner = decision.owner;
    const ownsActive = Boolean(
      state.active &&
        state.active.key.registryFingerprint === owner.key.registryFingerprint &&
        state.active.key.generation === owner.key.generation,
    );
    const ownsPending = Boolean(
      state.pending &&
        state.pending.key.registryFingerprint === owner.key.registryFingerprint &&
        state.pending.key.generation === owner.key.generation,
    );

    let outcome: 'stopped' | 'pending-dropped' | 'failed' | 'none' = 'none';
    if (ownsActive && (decision.kind === 'initialize' || decision.kind === 'takeover')) {
      // Keep the generation bound but inert. Clearing `active` outright would
      // re-open the "no declaration + no active lifecycle" dispatch fallback
      // for stale gateway method handlers; `stopped` is recoverable by the
      // next takeover and keeps dispatch gated.
      if (state.active) {
        state.active.phase = 'stopped';
        state.active.stopRequestedAt = null;
        state.active.stoppedAt = Date.now();
        state.active.failure = null;
      }
      state.pending = undefined;
      state.pendingMode = undefined;
      state.retirement = undefined;
      state.resolveRetirement = undefined;
      outcome = 'stopped';
    } else if (ownsPending && decision.kind === 'defer') {
      state.pending = undefined;
      state.pendingMode = undefined;
      outcome = 'pending-dropped';
    } else if (ownsActive) {
      failLifecycle(state, owner.key.registryFingerprint, error, owner.key.generation);
      outcome = 'failed';
    }

    const declaration = runtime.registryDeclarations.get(owner.key.registryFingerprint);
    const ownsDeclaration = Boolean(
      declaration &&
        declaration.bridgeGenerationKey === getBridgeGenerationKey(owner.bridgeGeneration) &&
        declaration.lifecycleGeneration === owner.key.generation,
    );
    if (ownsDeclaration && declaration) {
      // The registration call did not complete successfully, even if it had
      // already published all declarations. Keep the whole scope fail-closed;
      // otherwise a stopped lifecycle can leave an active gateway declaration.
      declaration.registration = 'failed';
      declaration.state = 'retired';
      retireRegistryRuntimeObservation(owner.key.registryFingerprint);
    }
    return outcome;
  };

  const canStopLifecycleRegistry = (registryFingerprint: string, expectedGeneration: number) => {
    const state = getGatewayRuntime().lifecycle;
    const allowed = isLifecycleRegistryStoppable(state, registryFingerprint, expectedGeneration);
    if (!allowed) {
      state.staleCallbackSuppressions += 1;
    }
    return allowed;
  };

  const canStartLifecycleRegistry = (registryFingerprint: string, expectedGeneration: number) => {
    const state = getGatewayRuntime().lifecycle;
    const allowed =
      getGatewayRuntime().registryDeclarations.get(registryFingerprint)?.registration !==
        'failed' && isLifecycleRegistryActive(state, registryFingerprint, expectedGeneration);
    if (!allowed) {
      state.staleCallbackSuppressions += 1;
    }
    return allowed;
  };

  const isLifecycleRegistryCurrent = (registryFingerprint: string, expectedGeneration: number) =>
    isLifecycleRegistryActive(
      getGatewayRuntime().lifecycle,
      registryFingerprint,
      expectedGeneration,
    );

  const getRegistryDeclaration = (
    registryFingerprint: string,
    bridgeGenerationKey = '',
    lifecycleGeneration = 0,
  ) => {
    const runtime = getGatewayRuntime();
    let declaration = runtime.registryDeclarations.get(registryFingerprint);
    if (!declaration) {
      declaration = {
        bridgeGenerationKey,
        lifecycleGeneration,
        service: 'missing',
        channel: 'missing',
        registration: 'pending',
        state: 'shadow',
      };
      runtime.registryDeclarations.set(registryFingerprint, declaration);
    } else {
      declaration = normalizeRegistryDeclarationInPlace(declaration);
      if (!declaration.bridgeGenerationKey) {
        declaration.bridgeGenerationKey = bridgeGenerationKey;
      }
      if (!declaration.lifecycleGeneration) {
        declaration.lifecycleGeneration = lifecycleGeneration;
      }
    }
    return declaration;
  };

  const markRegistryServiceDeclared = (
    registryFingerprint: string,
    bridgeGenerationKey: string,
    lifecycleGeneration: number,
  ) => {
    const declaration = getRegistryDeclaration(
      registryFingerprint,
      bridgeGenerationKey,
      lifecycleGeneration,
    );
    if (declaration.bridgeGenerationKey !== bridgeGenerationKey) {
      throw new Error(`bncr service declaration scope mismatch: ${registryFingerprint}`);
    }
    declaration.lifecycleGeneration = lifecycleGeneration;
    declaration.service = 'declared';
    return declaration;
  };

  const markRegistryChannelDeclared = (
    registryFingerprint: string,
    bridgeGenerationKey: string,
    lifecycleGeneration: number,
  ) => {
    const declaration = getRegistryDeclaration(
      registryFingerprint,
      bridgeGenerationKey,
      lifecycleGeneration,
    );
    if (declaration.bridgeGenerationKey !== bridgeGenerationKey) {
      throw new Error(`bncr channel declaration scope mismatch: ${registryFingerprint}`);
    }
    declaration.lifecycleGeneration = lifecycleGeneration;
    declaration.channel = 'declared';
    return declaration;
  };

  const markRegistryRegistrationComplete = (
    registryFingerprint: string,
    bridgeGenerationKey: string,
    lifecycleGeneration: number,
  ) => {
    const declaration = getRegistryDeclaration(
      registryFingerprint,
      bridgeGenerationKey,
      lifecycleGeneration,
    );
    if (declaration.bridgeGenerationKey !== bridgeGenerationKey) {
      throw new Error(`bncr register scope mismatch: ${registryFingerprint}`);
    }
    // Duplicate registrations do not redeclare callbacks. Keep the generation
    // that owns the existing service/channel callbacks instead of advancing the
    // declaration to a new planning generation.
    declaration.lifecycleGeneration ||= lifecycleGeneration;
    declaration.registration = 'complete';
    if (declaration.state === 'active') {
      startRegistryRuntimeObservation(
        registryFingerprint,
        bridgeGenerationKey,
        declaration.lifecycleGeneration,
      );
    }
    return declaration;
  };

  return {
    getRegisterMeta,
    getGlobalRegisterTrace,
    noteRegisterTraceValue: rememberRegisterTraceValue,
    getBridgeGenerationKey,
    getGatewayRuntime,
    planLifecycle,
    commitLifecycle,
    adoptLifecycleBridge,
    beginRetirement,
    settleRetirement,
    getLifecycleBridgeForStart,
    failLifecycleStart,
    recoverLifecycleRegistration,
    canStopLifecycleRegistry,
    canStartLifecycleRegistry,
    isLifecycleRegistryCurrent,
    getRegistryDeclaration,
    getRegistryRuntimeObservation,
    startRegistryRuntimeObservation,
    probeRegistryRuntimeObservation,
    retireRegistryRuntimeObservation,
    markRegistryServiceDeclared,
    markRegistryChannelDeclared,
    markRegistryRegistrationComplete,
    pruneRegistryLedgers: () => pruneRegistryLedgers(getGatewayRuntime()),
    ensureGatewayMethodRegistered: gatewayMethodRegistry.ensureGatewayMethodRegistered,
    getBridgeSingleton: bridgeSingletonManager.getBridgeSingleton,
    getBridgeOwnerFromBridge: bridgeSingletonManager.getBridgeOwnerFromBridge,
    getExistingBridgeSingleton: bridgeSingletonManager.getExistingBridgeSingleton,
    getCurrentBridge,
  };
}
