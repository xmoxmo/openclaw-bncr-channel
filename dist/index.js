// src/bootstrap/channel-plugin-runtime.ts
function createDynamicChannelPlugin(args) {
  const { loaded, getCurrentBridge: getCurrentBridge2 } = args;
  const resolveBridgeForStart = args.resolveBridgeForStart || getCurrentBridge2;
  const isBridgeForStartCurrent = args.isBridgeForStartCurrent || (() => true);
  const resolveBridgeForStop = args.resolveBridgeForStop || getCurrentBridge2;
  const isBridgeForStopCurrent = args.isBridgeForStopCurrent || (() => true);
  const base = loaded.createBncrChannelPlugin(() => getCurrentBridge2());
  const plugin2 = { ...base };
  const outbound = base.outbound;
  const baseStatus = base.status;
  const baseGateway = base.gateway;
  plugin2.outbound = {
    ...outbound,
    sendText: (async (ctx) => await getCurrentBridge2().channelSendText(ctx)),
    sendMedia: (async (ctx) => await getCurrentBridge2().channelSendMedia(ctx))
  };
  plugin2.status = {
    ...baseStatus,
    buildChannelSummary: async ({ defaultAccountId }) => getCurrentBridge2().getChannelSummary(defaultAccountId || "Primary"),
    buildAccountSnapshot: async ({ account, runtime: runtime2 }) => {
      const bridgeNow = getCurrentBridge2();
      return baseStatus.buildAccountSnapshot({
        account,
        runtime: runtime2 || bridgeNow.getAccountRuntimeSnapshot(account?.accountId || "Primary")
      });
    },
    resolveAccountState: ({
      enabled,
      configured,
      account,
      cfg,
      runtime: runtime2
    }) => {
      const bridgeNow = getCurrentBridge2();
      return baseStatus.resolveAccountState({
        enabled,
        configured,
        account,
        cfg,
        runtime: runtime2 || bridgeNow.getAccountRuntimeSnapshot(account?.accountId || "Primary")
      });
    }
  };
  plugin2.gateway = {
    ...baseGateway,
    startAccount: async (ctx) => {
      const bridge = await resolveBridgeForStart();
      if (!isBridgeForStartCurrent()) return;
      const task = bridge.channelStartAccount(
        ctx
      );
      if (isBridgeForStartCurrent()) {
        try {
          args.onBridgeStartObserved?.();
        } catch {
        }
      }
      return task;
    },
    stopAccount: async (ctx) => {
      const bridge = await resolveBridgeForStop();
      if (!bridge || !isBridgeForStopCurrent()) return;
      return bridge.channelStopAccount(ctx);
    }
  };
  return plugin2;
}

// src/openclaw/config-runtime.ts
function resolveConfigApi(api) {
  const config = api?.runtime?.config;
  if (!config || typeof config !== "object") {
    throw new Error("OpenClaw runtime config API is unavailable");
  }
  return config;
}
function getOpenClawRuntimeConfig(api) {
  const config = resolveConfigApi(api);
  if (typeof config.current === "function") return config.current();
  if (typeof config.get === "function") return config.get();
  throw new Error("OpenClaw runtime config read API is unavailable");
}
async function mutateOpenClawRuntimeConfigFile(api, params) {
  const config = resolveConfigApi(api);
  if (typeof config.mutateConfigFile !== "function") {
    throw new Error("OpenClaw runtime config mutate API is unavailable");
  }
  return config.mutateConfigFile(params);
}

// src/bootstrap/cli.ts
var isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function registerBncrCli(api) {
  if (typeof api.registerCli !== "function") return;
  api.registerCli(
    ({ program }) => {
      const bncr = program.command("bncr").description("Bncr channel utilities");
      bncr.command("miniconfig").description(
        "Seed minimal channels.bncr config (adds enabled=true and allowTool=false only when missing)"
      ).action(async () => {
        const cfg = getOpenClawRuntimeConfig(api) || {};
        const channels = isPlainObject(cfg.channels) ? cfg.channels : {};
        const existing = isPlainObject(channels.bncr) ? channels.bncr : {};
        const added = [];
        if (existing.enabled === void 0) {
          added.push("enabled=true");
        }
        if (existing.allowTool === void 0) {
          added.push("allowTool=false");
        }
        if (added.length === 0) {
          console.log("Minimal bncr config already present. No changes made.");
          return;
        }
        await mutateOpenClawRuntimeConfigFile(api, {
          afterWrite: { mode: "auto" },
          mutate(draft) {
            if (!isPlainObject(draft.channels)) draft.channels = {};
            const draftChannels = draft.channels;
            const draftExisting = isPlainObject(draftChannels.bncr) ? draftChannels.bncr : {};
            const draftBncrCfg = { ...draftExisting };
            if (draftBncrCfg.enabled === void 0) {
              draftBncrCfg.enabled = true;
            }
            if (draftBncrCfg.allowTool === void 0) {
              draftBncrCfg.allowTool = false;
            }
            draftChannels.bncr = draftBncrCfg;
          }
        });
        console.log("Seeded minimal bncr config at channels.bncr.");
        console.log(`Added missing fields: ${added.join(", ")}`);
        console.log("Gateway will apply the config using the host afterWrite policy.");
      });
    },
    { commands: ["bncr"] }
  );
}
var shouldSkipNonRuntimeRegister = (mode) => mode === "cli-metadata" || mode === "discovery";

// src/core/logging.ts
var BNCR_PREFIX = "[bncr]";
function resolveConsoleMethod(level) {
  switch (level) {
    case "warn":
      return "warn";
    case "error":
      return "error";
    default:
      return "log";
  }
}
function emitConsole(method, line) {
  if (method === "warn") {
    console.warn(line);
    return;
  }
  if (method === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}
function normalizeBncrLogLine(raw) {
  const text = String(raw || "").trim();
  if (!text) return BNCR_PREFIX;
  return text.startsWith(BNCR_PREFIX) ? text : `${BNCR_PREFIX} ${text}`;
}
function emitBncrLogLine(level, line, options, isDebugEnabled) {
  if (options?.debugOnly && !(isDebugEnabled?.() ?? false)) return;
  emitConsole(resolveConsoleMethod(level), normalizeBncrLogLine(line));
}

// src/bootstrap/register-lifecycle.ts
function normalizeString(value, fallback = "unknown") {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}
function createRegisterLifecycleState() {
  return {
    nextGeneration: 1,
    staleCallbackSuppressions: 0
  };
}
function sameLifecycleRegistration(left, right) {
  if (!left || !right) return false;
  return left.apiInstanceId === right.apiInstanceId && left.registryFingerprint === right.registryFingerprint;
}
function sameBridgeGeneration(left, right) {
  if (!left || !right) return false;
  return left.moduleEpoch === right.moduleEpoch && left.bridgeFactoryId === right.bridgeFactoryId && left.pluginVersion === right.pluginVersion && left.registrationMode === right.registrationMode && left.pluginRoot === right.pluginRoot && left.pluginFile === right.pluginFile;
}
function getBridgeGenerationKey(generation) {
  return [
    generation.moduleEpoch,
    generation.bridgeFactoryId,
    generation.pluginVersion,
    generation.registrationMode,
    generation.pluginRoot,
    generation.pluginFile
  ].join("\0");
}
function createLifecycleOwner(input, generation, phase) {
  return {
    key: {
      generation,
      apiInstanceId: normalizeString(input.apiInstanceId, "unknown-api"),
      registryFingerprint: normalizeString(input.registryFingerprint, "unknown-registry")
    },
    bridgeGeneration: {
      moduleEpoch: normalizeString(input.bridgeGeneration.moduleEpoch),
      bridgeFactoryId: normalizeString(input.bridgeGeneration.bridgeFactoryId),
      pluginVersion: normalizeString(input.bridgeGeneration.pluginVersion),
      registrationMode: normalizeString(input.bridgeGeneration.registrationMode),
      pluginRoot: normalizeString(input.bridgeGeneration.pluginRoot),
      pluginFile: normalizeString(input.bridgeGeneration.pluginFile)
    },
    phase,
    startedAt: phase === "active" ? input.now : null,
    stopRequestedAt: null,
    stoppedAt: null,
    failure: null
  };
}
function planLifecycleAdoption(state, input) {
  const owner = createLifecycleOwner(input, state.nextGeneration, "active");
  const active = state.active;
  if (!active) {
    return {
      kind: "initialize",
      owner,
      reason: "no-active-lifecycle"
    };
  }
  if (active.phase === "failed") {
    return {
      kind: "reject",
      owner,
      reason: "predecessor-failed"
    };
  }
  if (state.pending) {
    const sameRegistration = sameLifecycleRegistration(state.pending.key, owner.key);
    const sameGeneration = sameBridgeGeneration(
      state.pending.bridgeGeneration,
      owner.bridgeGeneration
    );
    if (sameRegistration && sameGeneration) {
      return {
        kind: "duplicate",
        owner,
        reason: "pending-successor"
      };
    }
    if (sameRegistration) {
      return {
        kind: "reject",
        owner,
        reason: "registration-generation-conflict"
      };
    }
    return {
      kind: "reject",
      owner,
      reason: "pending-successor-conflict"
    };
  }
  if (active.phase === "active" || active.phase === "registering") {
    if (sameLifecycleRegistration(active.key, owner.key) && !sameBridgeGeneration(active.bridgeGeneration, owner.bridgeGeneration)) {
      return {
        kind: "reject",
        owner,
        reason: "registration-generation-conflict"
      };
    }
    return {
      kind: "duplicate",
      owner,
      reason: "active-owner"
    };
  }
  if (active.phase === "stopping") {
    const sameRegistration = sameLifecycleRegistration(active.key, owner.key);
    const sameGeneration = sameBridgeGeneration(active.bridgeGeneration, owner.bridgeGeneration);
    if (sameRegistration && sameGeneration) {
      return {
        kind: "duplicate",
        owner,
        reason: "lifecycle-stopping"
      };
    }
    if (sameRegistration) {
      return {
        kind: "reject",
        owner,
        reason: "registration-generation-conflict"
      };
    }
    return {
      kind: "defer",
      owner,
      predecessorGeneration: active.key.generation,
      mode: sameBridgeGeneration(active.bridgeGeneration, owner.bridgeGeneration) ? "reuse" : "replace",
      reason: "predecessor-stopping"
    };
  }
  if (sameLifecycleRegistration(active.key, owner.key)) {
    if (!sameBridgeGeneration(active.bridgeGeneration, owner.bridgeGeneration)) {
      return {
        kind: "reject",
        owner,
        reason: "registration-generation-conflict"
      };
    }
    return {
      kind: "duplicate",
      owner,
      reason: "same-lifecycle-stopped"
    };
  }
  if (sameBridgeGeneration(active.bridgeGeneration, owner.bridgeGeneration)) {
    return {
      kind: "takeover",
      owner,
      mode: "reuse",
      reason: "bridge-generation-reused"
    };
  }
  return {
    kind: "takeover",
    owner,
    mode: "replace",
    reason: "bridge-generation-changed"
  };
}
function commitLifecycleAdoption(state, decision) {
  if (decision.kind === "duplicate" || decision.kind === "reject") {
    return state.active;
  }
  state.nextGeneration = Math.max(state.nextGeneration + 1, decision.owner.key.generation + 1);
  if (decision.kind === "defer") {
    state.pending = decision.owner;
    state.pendingMode = decision.mode;
    return state.active;
  }
  state.active = decision.owner;
  state.pending = void 0;
  state.pendingMode = void 0;
  state.retirement = void 0;
  state.resolveRetirement = void 0;
  return state.active;
}
function beginLifecycleRetirement(state, registryFingerprint, now, expectedGeneration) {
  const active = state.active;
  if (!active || active.key.registryFingerprint !== registryFingerprint || expectedGeneration !== void 0 && active.key.generation !== expectedGeneration || active.phase !== "active" && active.phase !== "registering") {
    state.staleCallbackSuppressions += 1;
    return null;
  }
  let resolveRetirement;
  state.retirement = new Promise((resolve) => {
    resolveRetirement = resolve;
  });
  state.resolveRetirement = resolveRetirement;
  active.phase = "stopping";
  active.stopRequestedAt = now;
  return state.retirement;
}
function settleLifecycleRetirement(state, registryFingerprint, outcome, now, expectedGeneration) {
  const active = state.active;
  if (!active || active.key.registryFingerprint !== registryFingerprint || expectedGeneration !== void 0 && active.key.generation !== expectedGeneration || active.phase !== "stopping") {
    state.staleCallbackSuppressions += 1;
    return false;
  }
  const resolveRetirement = state.resolveRetirement;
  state.resolveRetirement = void 0;
  active.phase = outcome.ok ? "stopped" : "failed";
  active.stoppedAt = outcome.ok ? now : null;
  active.failure = outcome.ok ? null : outcome.error;
  resolveRetirement?.(outcome);
  return true;
}
function activatePendingLifecycle(state, registryFingerprint, now, expectedGeneration) {
  const pending = state.pending;
  if (!pending || pending.key.registryFingerprint !== registryFingerprint || expectedGeneration !== void 0 && pending.key.generation !== expectedGeneration) {
    return null;
  }
  if (state.active?.phase !== "stopped") {
    return null;
  }
  pending.phase = "active";
  pending.startedAt = now;
  state.active = pending;
  state.pending = void 0;
  state.pendingMode = void 0;
  state.retirement = void 0;
  state.resolveRetirement = void 0;
  return state.active;
}
function reactivateStoppedLifecycle(state, registryFingerprint, now, expectedGeneration) {
  const active = state.active;
  if (state.pending || !active || active.key.registryFingerprint !== registryFingerprint || expectedGeneration !== void 0 && active.key.generation !== expectedGeneration || active.phase !== "stopped") {
    return null;
  }
  active.phase = "active";
  active.startedAt = now;
  active.stopRequestedAt = null;
  active.stoppedAt = null;
  active.failure = null;
  return active;
}
function failLifecycle(state, registryFingerprint, error, expectedGeneration) {
  const active = state.active;
  if (!active || active.key.registryFingerprint !== registryFingerprint || expectedGeneration !== void 0 && active.key.generation !== expectedGeneration) {
    state.staleCallbackSuppressions += 1;
    return false;
  }
  if (active.phase !== "active" && active.phase !== "registering") {
    state.staleCallbackSuppressions += 1;
    return false;
  }
  active.phase = "failed";
  active.stoppedAt = null;
  active.failure = error instanceof Error ? error.message : String(error);
  return true;
}
function getPendingLifecycle(state) {
  return state.pending;
}
function isLifecycleRegistryActive(state, registryFingerprint, expectedGeneration) {
  return Boolean(
    state.active?.key.registryFingerprint === registryFingerprint && (expectedGeneration === void 0 || state.active.key.generation === expectedGeneration) && (state.active.phase === "active" || state.active.phase === "registering")
  );
}
function isLifecycleRegistryStoppable(state, registryFingerprint, expectedGeneration) {
  const active = state.active;
  return Boolean(
    active?.key.registryFingerprint === registryFingerprint && (expectedGeneration === void 0 || active.key.generation === expectedGeneration) && (active.phase === "registering" || active.phase === "active" || active.phase === "stopping")
  );
}

// src/bootstrap/register-runtime-gateway.ts
function createBncrGatewayMethodRegistry(runtime2) {
  const dispatchGatewayMethod = (name, opts, registryFingerprint) => {
    const gatewayRuntime = runtime2.getGatewayRuntime();
    const declaration = registryFingerprint ? gatewayRuntime.registryDeclarations?.get(registryFingerprint) : void 0;
    const lifecycleFailed = gatewayRuntime.lifecycle?.active?.phase === "failed";
    const declarationFailed = declaration?.registration === "failed";
    const dispatchAllowed = declaration ? declaration.state !== "retired" && !declarationFailed && !lifecycleFailed : !gatewayRuntime.lifecycle?.active;
    if (registryFingerprint && !dispatchAllowed) {
      throw new Error(`bncr lifecycle registry is inactive for ${name}`);
    }
    const bridge = gatewayRuntime.currentBridge;
    if (!bridge) {
      throw new Error(`bncr gateway runtime unavailable for ${name}`);
    }
    const dispatcherOpts = name === "bncr.diagnostics" && registryFingerprint && runtime2.getRegistryRuntimeObservation && typeof opts.respond === "function" ? {
      ...opts,
      respond: (...response) => {
        const [ok, payload, error, meta] = response;
        let observation = null;
        try {
          observation = runtime2.getRegistryRuntimeObservation?.(registryFingerprint) ?? null;
        } catch {
          observation = null;
        }
        const nextPayload = ok && payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload, lifecycleObservation: observation } : payload;
        opts.respond(ok, nextPayload, error, meta);
      }
    } : opts;
    try {
      const dispatcher = gatewayRuntime.gatewayMethodDispatchers?.[name] || runtime2.gatewayMethodDispatchers[name];
      return dispatcher(bridge, dispatcherOpts);
    } catch (error) {
      const state = runtime2.getBridgeRegisterStateCarrier(bridge);
      const detail = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack || null } : { name: "NonError", message: String(error), stack: null };
      emitBncrLogLine(
        "error",
        `[bncr] gateway method error method=${name}|bridgeId=${state.getBridgeId?.() || "-"}|gatewayPid=${state.gatewayPid ?? "-"}|err=${detail.message}`
      );
      emitBncrLogLine(
        "error",
        `[bncr] gateway method error ${JSON.stringify({
          method: name,
          bridgeId: state.getBridgeId?.() || null,
          gatewayPid: state.gatewayPid ?? null,
          detail
        })}`,
        { debugOnly: true },
        () => false
      );
      throw error;
    }
  };
  const mirrorGatewayMethodForMockApi = (api, name) => {
    if (!Array.isArray(api?.methods)) return;
    if (api.methods.some((item) => item?.name === name)) return;
    api.methods.push({
      name,
      handler: (opts) => dispatchGatewayMethod(
        name,
        opts,
        runtime2.getRegisterMeta(api).registryFingerprint || runtime2.getRegistryFingerprint(api)
      )
    });
  };
  const ensureGatewayMethodRegistered2 = (api, name, debugLog) => {
    const meta = runtime2.getRegisterMeta(api);
    const gatewayRuntime = runtime2.getGatewayRuntime();
    const registryFingerprint = meta.registryFingerprint || runtime2.getRegistryFingerprint(api);
    let registryMethods = gatewayRuntime.registeredMethodsByRegistry.get(registryFingerprint);
    if (!registryMethods) {
      registryMethods = /* @__PURE__ */ new Set();
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
    api.registerGatewayMethod(
      name,
      (opts) => dispatchGatewayMethod(name, opts, registryFingerprint)
    );
    mirrorGatewayMethodForMockApi(api, name);
    registryMethods.add(name);
    meta.methods?.add(name);
    debugLog(`register method ok ${name}`);
  };
  return {
    dispatchGatewayMethod,
    ensureGatewayMethodRegistered: ensureGatewayMethodRegistered2
  };
}

// src/bootstrap/register-runtime-observation.ts
var REGISTRY_RUNTIME_OBSERVATION_TIMEOUT_MS = 3e4;
var REGISTRY_RUNTIME_OBSERVATION_POLL_MS = 5e3;
function finiteTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
function createRegistryRuntimeObservation(now) {
  return {
    phase: "awaiting",
    startedAt: now,
    deadlineAt: now + REGISTRY_RUNTIME_OBSERVATION_TIMEOUT_MS,
    pollingStartedAt: null,
    readyAt: null,
    retiredAt: null,
    lastProbeAt: null,
    probeCount: 0,
    serviceObservedAt: null,
    channelObservedAt: null
  };
}
function normalizeRegistryRuntimeObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const source = value;
  const phase = source.phase;
  if (phase !== "awaiting" && phase !== "polling" && phase !== "ready" && phase !== "retired") {
    return void 0;
  }
  const startedAt = finiteTimestamp(source.startedAt);
  const deadlineAt = finiteTimestamp(source.deadlineAt);
  if (startedAt === null || deadlineAt === null) return void 0;
  return {
    phase,
    startedAt,
    deadlineAt,
    pollingStartedAt: finiteTimestamp(source.pollingStartedAt),
    readyAt: finiteTimestamp(source.readyAt),
    retiredAt: finiteTimestamp(source.retiredAt),
    lastProbeAt: finiteTimestamp(source.lastProbeAt),
    probeCount: nonNegativeInteger(source.probeCount),
    serviceObservedAt: finiteTimestamp(source.serviceObservedAt),
    channelObservedAt: finiteTimestamp(source.channelObservedAt)
  };
}
function retireObservation(observation, now) {
  return {
    observation: {
      ...observation,
      phase: "retired",
      retiredAt: observation.retiredAt ?? now,
      lastProbeAt: now,
      probeCount: observation.probeCount + 1
    },
    action: "retired",
    transitionedToPolling: false,
    transitionedToReady: false
  };
}
function evaluateRegistryRuntimeObservation(args) {
  const { observation, now, lifecycleActive, probe } = args;
  if (observation.phase === "retired") {
    return {
      observation,
      action: "retired",
      transitionedToPolling: false,
      transitionedToReady: false
    };
  }
  if (!lifecycleActive) {
    return retireObservation(observation, now);
  }
  if (observation.phase === "ready") {
    return {
      observation,
      action: "ready",
      transitionedToPolling: false,
      transitionedToReady: false
    };
  }
  const serviceRunning = probe.serviceRunning === true;
  const channelRunning = probe.channelRunning === true || (probe.activeChannelAccounts ?? 0) > 0;
  const serviceObservedAt = observation.serviceObservedAt ?? (serviceRunning ? now : null);
  const channelObservedAt = observation.channelObservedAt ?? (channelRunning ? now : null);
  const observed = {
    ...observation,
    lastProbeAt: now,
    probeCount: observation.probeCount + 1,
    serviceObservedAt,
    channelObservedAt
  };
  if (serviceRunning && channelRunning) {
    return {
      observation: {
        ...observed,
        phase: "ready",
        readyAt: observed.readyAt ?? now
      },
      action: "ready",
      transitionedToPolling: false,
      transitionedToReady: true
    };
  }
  if (now >= observation.deadlineAt) {
    return {
      observation: {
        ...observed,
        phase: "polling",
        pollingStartedAt: observed.pollingStartedAt ?? now
      },
      action: "poll",
      transitionedToPolling: observation.phase === "awaiting",
      transitionedToReady: false
    };
  }
  return {
    observation: observed,
    action: "wait",
    transitionedToPolling: false,
    transitionedToReady: false
  };
}

// src/bootstrap/register-runtime-helpers.ts
function snapshotBridgeRegisterState(bridge) {
  if (!bridge) return null;
  return {
    registerCount: Number(bridge.registerCount || 0),
    apiGeneration: Number(bridge.apiGeneration || 0),
    firstRegisterAt: typeof bridge.firstRegisterAt === "number" ? bridge.firstRegisterAt : bridge.firstRegisterAt ?? null,
    lastRegisterAt: typeof bridge.lastRegisterAt === "number" ? bridge.lastRegisterAt : bridge.lastRegisterAt ?? null,
    lastApiRebindAt: typeof bridge.lastApiRebindAt === "number" ? bridge.lastApiRebindAt : bridge.lastApiRebindAt ?? null,
    pluginSource: typeof bridge.pluginSource === "string" ? bridge.pluginSource : null,
    pluginVersion: typeof bridge.pluginVersion === "string" ? bridge.pluginVersion : null,
    lastApiInstanceId: typeof bridge.lastApiInstanceId === "string" ? bridge.lastApiInstanceId : null,
    lastRegistryFingerprint: typeof bridge.lastRegistryFingerprint === "string" ? bridge.lastRegistryFingerprint : null,
    lastDriftSnapshot: bridge.lastDriftSnapshot ?? null,
    registerTraceRecent: Array.isArray(bridge.registerTraceRecent) ? bridge.registerTraceRecent.map((trace) => ({ ...trace })) : []
  };
}
function hydrateBridgeRegisterState(bridge, snapshot) {
  if (!snapshot) return bridge;
  bridge.registerCount = snapshot.registerCount;
  bridge.apiGeneration = snapshot.apiGeneration;
  bridge.firstRegisterAt = snapshot.firstRegisterAt;
  bridge.lastRegisterAt = snapshot.lastRegisterAt;
  bridge.lastApiRebindAt = snapshot.lastApiRebindAt;
  bridge.pluginSource = snapshot.pluginSource;
  bridge.pluginVersion = snapshot.pluginVersion;
  bridge.lastApiInstanceId = snapshot.lastApiInstanceId;
  bridge.lastRegistryFingerprint = snapshot.lastRegistryFingerprint;
  bridge.lastDriftSnapshot = snapshot.lastDriftSnapshot;
  bridge.registerTraceRecent = snapshot.registerTraceRecent.map((trace) => ({ ...trace }));
  return bridge;
}

// src/bootstrap/register-runtime-singleton.ts
function isBridgeOwner(value) {
  return Boolean(
    value && typeof value === "object" && "moduleEpoch" in value && "bridgeFactoryId" in value && "apiInstanceId" in value && "registryFingerprint" in value
  );
}
function getBridgeOwnedCarrier(bridge) {
  return bridge;
}
function getBridgeRegisterStateCarrier(bridge) {
  return bridge;
}
function createBncrBridgeSingletonManager(runtime2) {
  const assignBridgeOwner = (bridge, owner) => {
    getBridgeOwnedCarrier(bridge)[runtime2.bridgeOwnerSymbol] = owner;
    return bridge;
  };
  const adoptBridgeSingleton = (api, owner, mode) => {
    const loaded = runtime2.loadBncrRuntimeSync();
    const g = globalThis;
    const previousOwnerRaw = g.__bncrBridge ? getBridgeOwnedCarrier(g.__bncrBridge)[runtime2.bridgeOwnerSymbol] : void 0;
    const previousOwner = isBridgeOwner(previousOwnerRaw) ? previousOwnerRaw : void 0;
    let created = false;
    let rebuilt = false;
    let bridge;
    if (!g.__bncrBridge || mode === "create" || mode === "replace") {
      const registerState = mode === "replace" && g.__bncrBridge ? snapshotBridgeRegisterState(getBridgeRegisterStateCarrier(g.__bncrBridge)) : null;
      bridge = assignBridgeOwner(
        loaded.createBncrBridge(api, {
          pluginRoot: runtime2.pluginRoot,
          pluginFile: runtime2.pluginFile
        }),
        owner
      );
      hydrateBridgeRegisterState(getBridgeRegisterStateCarrier(bridge), registerState);
      g.__bncrBridge = bridge;
      created = true;
      rebuilt = mode === "replace" && Boolean(previousOwner);
    } else {
      bridge = g.__bncrBridge;
      bridge.bindApi?.(api);
      assignBridgeOwner(bridge, owner);
    }
    bridge.bindRuntimePaths?.({
      pluginRoot: runtime2.pluginRoot,
      pluginFile: runtime2.pluginFile
    });
    return { bridge, runtime: loaded, created, rebuilt, owner, previousOwner };
  };
  const getBridgeSingleton = (api) => {
    const loaded = runtime2.loadBncrRuntimeSync();
    const owner = runtime2.getBridgeOwner(api, loaded);
    const g = globalThis;
    const previous = getBridgeOwnerFromBridge2(g.__bncrBridge);
    const sameGeneration = previous?.moduleEpoch === owner.moduleEpoch && previous?.bridgeFactoryId === owner.bridgeFactoryId && previous?.pluginVersion === owner.pluginVersion && previous?.registrationMode === owner.registrationMode && previous?.pluginRoot === owner.pluginRoot && previous?.pluginFile === owner.pluginFile;
    const mode = !g.__bncrBridge ? "create" : sameGeneration ? "reuse" : "replace";
    return adoptBridgeSingleton(api, owner, mode);
  };
  const getExistingBridgeSingleton2 = () => {
    const g = globalThis;
    return g.__bncrBridge;
  };
  const getBridgeOwnerFromBridge2 = (bridge) => {
    if (!bridge) return void 0;
    const bridgeCarrier = getBridgeOwnedCarrier(bridge);
    for (const symbol of Object.getOwnPropertySymbols(bridge)) {
      const owner = bridgeCarrier[symbol];
      if (isBridgeOwner(owner)) return owner;
    }
    return void 0;
  };
  return {
    assignBridgeOwner,
    adoptBridgeSingleton,
    getBridgeRegisterStateCarrier,
    getBridgeSingleton,
    getExistingBridgeSingleton: getExistingBridgeSingleton2,
    getBridgeOwnerFromBridge: getBridgeOwnerFromBridge2
  };
}

// src/bootstrap/runtime-loader.ts
import fs2 from "node:fs";
import { createRequire } from "node:module";
import path2 from "node:path";
import { fileURLToPath } from "node:url";

// src/bootstrap/runtime-discovery.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
var pluginPackageName = "@xmoxmo/bncr";
var sdkCoreSpecifier = "openclaw/plugin-sdk/core";
var linkType = process.platform === "win32" ? "junction" : "dir";
function resolveBncrPluginRoot(filePath) {
  let current = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
  while (true) {
    const pkgPath = path.join(current, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name === pluginPackageName) return current;
      } catch {
      }
    }
    if (fs.existsSync(path.join(current, "openclaw.plugin.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.dirname(filePath);
    current = parent;
  }
}
function tryExec(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}
function readOpenClawPackageName(pkgPath) {
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.name === "string" ? parsed.name : "";
  } catch {
    return "";
  }
}
function unique(items) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const item of items) {
    if (!item) continue;
    const normalized = path.normalize(item);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
function findOpenClawPackageRoot(startPath) {
  let current = startPath;
  try {
    current = fs.realpathSync(startPath);
  } catch {
  }
  let cursor = current;
  while (true) {
    const statPath = fs.existsSync(cursor) ? cursor : path.dirname(cursor);
    const pkgPath = path.join(statPath, "package.json");
    if (fs.existsSync(pkgPath) && readOpenClawPackageName(pkgPath) === "openclaw") {
      return statPath;
    }
    const parent = path.dirname(statPath);
    if (parent === statPath) break;
    cursor = parent;
  }
  return "";
}
function collectOpenClawCandidates(pluginDir2) {
  const directCandidates = [
    path.join(pluginDir2, "node_modules", "openclaw"),
    path.join("/usr/lib/node_modules", "openclaw"),
    path.join("/usr/local/lib/node_modules", "openclaw"),
    path.join("/opt/homebrew/lib/node_modules", "openclaw"),
    path.join(process.env.HOME || "", ".npm-global/lib/node_modules", "openclaw")
  ];
  const npmRoot = tryExec("npm", ["root", "-g"]);
  if (npmRoot) directCandidates.push(path.join(npmRoot, "openclaw"));
  const nodePathEntries = (process.env.NODE_PATH || "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  for (const entry of nodePathEntries) {
    directCandidates.push(path.join(entry, "openclaw"));
  }
  const openclawBin = tryExec("which", ["openclaw"]);
  if (openclawBin) {
    directCandidates.push(openclawBin);
    directCandidates.push(path.dirname(openclawBin));
  }
  const packageRoots = unique(
    directCandidates.map((candidate) => findOpenClawPackageRoot(candidate)).filter(Boolean)
  );
  return packageRoots.filter((candidate) => {
    const pkgJson = path.join(candidate, "package.json");
    return fs.existsSync(pkgJson) && readOpenClawPackageName(pkgJson) === "openclaw";
  });
}
function canResolveSdkCore(pluginRequire2) {
  try {
    pluginRequire2.resolve(sdkCoreSpecifier);
    return true;
  } catch {
    return false;
  }
}
function ensurePluginNodeModulesLink(pluginDir2, targetRoot) {
  const nodeModulesDir = path.join(pluginDir2, "node_modules");
  const linkPath = path.join(nodeModulesDir, "openclaw");
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const existingTarget = fs.realpathSync(linkPath);
      const normalizedExisting = path.normalize(existingTarget);
      const normalizedTarget = path.normalize(fs.realpathSync(targetRoot));
      if (normalizedExisting === normalizedTarget) return;
      fs.unlinkSync(linkPath);
    } else {
      return;
    }
  } catch {
  }
  fs.symlinkSync(targetRoot, linkPath, linkType);
}
function resolveBncrRuntimeSourceDir(pluginDir2) {
  const pluginRoot2 = resolveBncrPluginRoot(pluginDir2);
  const rootSource = path.join(pluginRoot2, "src");
  if (fs.existsSync(path.join(rootSource, "channel.ts"))) return rootSource;
  const direct = path.join(pluginDir2, "src");
  if (fs.existsSync(path.join(direct, "channel.ts"))) return direct;
  const parent = path.join(pluginDir2, "..", "src");
  if (fs.existsSync(path.join(parent, "channel.ts"))) return parent;
  return direct;
}
function ensureBncrOpenClawSdkResolution(pluginDir2, pluginRequire2) {
  if (canResolveSdkCore(pluginRequire2)) return;
  let lastError = "";
  const candidates = collectOpenClawCandidates(pluginDir2);
  for (const candidate of candidates) {
    try {
      ensurePluginNodeModulesLink(pluginDir2, candidate);
      if (canResolveSdkCore(pluginRequire2)) return;
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }
  const suffix = candidates.length ? ` Tried candidates: ${candidates.join(", ")}.` : " No openclaw package root candidates were found from npm root, NODE_PATH, common global paths, or the openclaw binary path.";
  const extra = lastError ? ` Last repair error: ${lastError}.` : "";
  throw new Error(
    `bncr failed to resolve ${sdkCoreSpecifier} from ${pluginDir2}.${suffix}${extra} You can repair manually with: mkdir -p ${path.join(pluginDir2, "node_modules")} && ln -s "$(npm root -g)/openclaw" ${path.join(pluginDir2, "node_modules", "openclaw")}`
  );
}

// src/bootstrap/runtime-loader.ts
function resolvePluginEntryFileFromModule(moduleUrl) {
  const currentFile = fileURLToPath(moduleUrl);
  const pluginRoot2 = resolveBncrPluginRoot(currentFile);
  const currentDir = path2.dirname(currentFile);
  const distEntry = path2.join(pluginRoot2, "dist", "index.js");
  if (currentFile === distEntry && fs2.existsSync(distEntry)) return distEntry;
  const sourceEntry = path2.join(pluginRoot2, "index.ts");
  if (fs2.existsSync(sourceEntry)) return sourceEntry;
  if (fs2.existsSync(distEntry)) return distEntry;
  if (path2.basename(currentDir) === "dist") return distEntry;
  return sourceEntry;
}
function resolvePluginEntryFile() {
  return resolvePluginEntryFileFromModule(import.meta.url);
}
var pluginFile = resolvePluginEntryFile();
var pluginDir = path2.dirname(pluginFile);
var pluginRequire = createRequire(pluginFile);
var pluginRoot = resolveBncrPluginRoot(pluginFile);
var runtimeSourceDir = resolveBncrRuntimeSourceDir(pluginDir);
var runtime = null;
var readPluginVersion = (rootDir = pluginRoot) => {
  try {
    const raw = fs2.readFileSync(path2.join(rootDir, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
};
var pluginVersion = readPluginVersion();
var loadBncrRuntimeSync = () => {
  if (runtime) return runtime;
  ensureBncrOpenClawSdkResolution(pluginDir, pluginRequire);
  try {
    const mod = pluginRequire(path2.join(runtimeSourceDir, "channel.ts"));
    runtime = {
      createBncrBridge: mod.createBncrBridge,
      createBncrChannelPlugin: mod.createBncrChannelPlugin
    };
    return runtime;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(
      `bncr failed to load channel runtime after dependency bootstrap from ${runtimeSourceDir}: ${detail}`
    );
  }
};

// src/bootstrap/register-runtime.ts
var registerMetaSymbol = /* @__PURE__ */ Symbol.for("bncr.register.meta");
var globalRegisterTraceSymbol = /* @__PURE__ */ Symbol.for("bncr.global.register.trace");
var bridgeOwnerSymbol = /* @__PURE__ */ Symbol.for("bncr.bridge.owner");
var gatewayRuntimeSymbol = /* @__PURE__ */ Symbol.for("bncr.gateway.runtime");
var maxRegistryDeclarations = 6;
var maxRegisterTraceEntries = 64;
var moduleEpoch = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
var identityIds = /* @__PURE__ */ new WeakMap();
var identitySeq = 0;
var getIdentityId = (obj, prefix) => {
  const existing = identityIds.get(obj);
  if (existing) return existing;
  const next = `${prefix}_${moduleEpoch}_${++identitySeq}`;
  identityIds.set(obj, next);
  return next;
};
var getRegistryFingerprint = (api) => {
  const serviceId = getIdentityId(api.registerService, "svc");
  const channelId = getIdentityId(api.registerChannel, "chn");
  const methodId = getIdentityId(api.registerGatewayMethod, "mth");
  return `${serviceId}:${channelId}:${methodId}`;
};
var getProcessStore = () => {
  const p = process;
  return p;
};
var rememberRegisterTraceValue = (values, value) => {
  values.delete(value);
  values.add(value);
  while (values.size > maxRegisterTraceEntries) {
    const oldest = values.values().next().value;
    if (oldest === void 0) break;
    values.delete(oldest);
  }
};
var normalizeRegistryDeclaration = (value) => {
  const legacy = value || {};
  const service = legacy.service === "declared" || legacy.service === true ? "declared" : "missing";
  const channel = legacy.channel === "declared" || legacy.channel === true ? "declared" : "missing";
  const registration = legacy.registration === "pending" || legacy.registration === "complete" || legacy.registration === "failed" ? legacy.registration : service === "declared" && channel === "declared" ? "complete" : "failed";
  const state = legacy.state === "active" || legacy.state === "retired" ? legacy.state : "shadow";
  const lifecycleGeneration = typeof legacy.lifecycleGeneration === "number" ? legacy.lifecycleGeneration : typeof legacy.generation === "number" ? legacy.generation : 0;
  return {
    bridgeGenerationKey: typeof legacy.bridgeGenerationKey === "string" ? legacy.bridgeGenerationKey : "",
    lifecycleGeneration,
    service,
    channel,
    registration,
    state,
    runtimeObservation: normalizeRegistryRuntimeObservation(legacy.runtimeObservation)
  };
};
var normalizeRegistryDeclarationInPlace = (value) => {
  const normalized = normalizeRegistryDeclaration(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;
  const target = value;
  delete target.generation;
  Object.assign(target, normalized);
  return value;
};
var pruneRegistryLedgers = (runtime2) => {
  const protectedRegistries = new Set(
    [
      runtime2.lifecycle.active?.key.registryFingerprint,
      runtime2.lifecycle.pending?.key.registryFingerprint
    ].filter((value) => Boolean(value))
  );
  for (const ledger of [runtime2.registryDeclarations, runtime2.registeredMethodsByRegistry]) {
    for (const registryFingerprint of ledger.keys()) {
      if (ledger.size <= maxRegistryDeclarations) break;
      if (!protectedRegistries.has(registryFingerprint)) {
        const timer = runtime2.runtimeObservationTimers.get(registryFingerprint);
        if (timer) {
          clearTimeout(timer.timer);
          runtime2.runtimeObservationTimers.delete(registryFingerprint);
        }
        ledger.delete(registryFingerprint);
      }
    }
  }
};
function createBncrRegisterRuntime() {
  const gatewayMethodDispatchers = {
    "bncr.connect": (bridge, opts) => bridge.handleConnect(opts),
    "bncr.inbound": (bridge, opts) => bridge.handleInbound(opts),
    "bncr.activity": (bridge, opts) => bridge.handleActivity(opts),
    "bncr.ack": (bridge, opts) => bridge.handleAck(opts),
    "bncr.diagnostics": (bridge, opts) => bridge.handleDiagnostics(opts),
    "bncr.deadLetter.inspect": (bridge, opts) => bridge.handleDeadLetterInspect(opts),
    "bncr.deadLetter.prune": (bridge, opts) => bridge.handleDeadLetterPrune(opts),
    "bncr.rpc.response": (bridge, opts) => bridge.handleRpcResponse(opts),
    "bncr.file.init": (bridge, opts) => bridge.handleFileInit(opts),
    "bncr.file.chunk": (bridge, opts) => bridge.handleFileChunk(opts),
    "bncr.file.complete": (bridge, opts) => bridge.handleFileComplete(opts),
    "bncr.file.abort": (bridge, opts) => bridge.handleFileAbort(opts),
    "bncr.file.ack": (bridge, opts) => bridge.handleFileAck(opts)
  };
  const getRegisterMeta2 = (api) => {
    const host = api;
    if (!host[registerMetaSymbol]) {
      host[registerMetaSymbol] = { methods: /* @__PURE__ */ new Set() };
    }
    if (!host[registerMetaSymbol].methods) {
      host[registerMetaSymbol].methods = /* @__PURE__ */ new Set();
    }
    if (!host[registerMetaSymbol].apiInstanceId) {
      host[registerMetaSymbol].apiInstanceId = getIdentityId(api, "api");
    }
    if (!host[registerMetaSymbol].registryFingerprint) {
      host[registerMetaSymbol].registryFingerprint = getRegistryFingerprint(api);
    }
    return host[registerMetaSymbol];
  };
  const getGlobalRegisterTrace2 = () => {
    const p = getProcessStore();
    if (!p[globalRegisterTraceSymbol]) {
      p[globalRegisterTraceSymbol] = {
        seenRegistryFingerprints: /* @__PURE__ */ new Set(),
        seenApiInstanceIds: /* @__PURE__ */ new Set()
      };
    }
    return p[globalRegisterTraceSymbol];
  };
  const getGatewayRuntime2 = () => {
    const p = getProcessStore();
    if (!p[gatewayRuntimeSymbol]) {
      p[gatewayRuntimeSymbol] = {
        registeredMethodsByRegistry: /* @__PURE__ */ new Map(),
        registryDeclarations: /* @__PURE__ */ new Map(),
        runtimeObservationTimers: /* @__PURE__ */ new Map(),
        lifecycle: createRegisterLifecycleState()
      };
    }
    const runtime2 = p[gatewayRuntimeSymbol];
    if (!(runtime2.registeredMethodsByRegistry instanceof Map)) {
      runtime2.registeredMethodsByRegistry = /* @__PURE__ */ new Map();
    }
    if (!(runtime2.registryDeclarations instanceof Map)) {
      runtime2.registryDeclarations = /* @__PURE__ */ new Map();
    } else {
      for (const [registryFingerprint, declaration] of runtime2.registryDeclarations) {
        const normalized = normalizeRegistryDeclarationInPlace(declaration);
        if (normalized !== declaration) {
          runtime2.registryDeclarations.set(registryFingerprint, normalized);
        }
      }
    }
    if (!(runtime2.runtimeObservationTimers instanceof Map)) {
      runtime2.runtimeObservationTimers = /* @__PURE__ */ new Map();
    }
    if (!runtime2.lifecycle) {
      runtime2.lifecycle = createRegisterLifecycleState();
    }
    return runtime2;
  };
  const getBridgeRegisterStateCarrier2 = (bridge) => bridge;
  const gatewayMethodRegistry = createBncrGatewayMethodRegistry({
    getRegisterMeta: getRegisterMeta2,
    getRegistryFingerprint,
    getGatewayRuntime: getGatewayRuntime2,
    gatewayMethodDispatchers,
    getBridgeRegisterStateCarrier: getBridgeRegisterStateCarrier2,
    getRegistryRuntimeObservation: (registryFingerprint) => getRegistryRuntimeObservation(registryFingerprint)
  });
  const getBridgeOwner = (api, loaded) => {
    const meta = getRegisterMeta2(api);
    return {
      moduleEpoch,
      bridgeFactoryId: getIdentityId(loaded.createBncrBridge, "bridgeFactory"),
      apiInstanceId: meta.apiInstanceId || "unknown",
      registryFingerprint: meta.registryFingerprint || "unknown",
      registrationMode: meta.registrationMode,
      pluginVersion,
      pluginRoot,
      pluginFile
    };
  };
  const bridgeSingletonManager = createBncrBridgeSingletonManager({
    bridgeOwnerSymbol,
    pluginRoot,
    pluginFile,
    loadBncrRuntimeSync,
    getBridgeOwner
  });
  const toBridgeOwner = (owner) => ({
    moduleEpoch: owner.bridgeGeneration.moduleEpoch,
    bridgeFactoryId: owner.bridgeGeneration.bridgeFactoryId,
    apiInstanceId: owner.key.apiInstanceId,
    registryFingerprint: owner.key.registryFingerprint,
    registrationMode: owner.bridgeGeneration.registrationMode,
    pluginVersion: owner.bridgeGeneration.pluginVersion,
    pluginRoot: owner.bridgeGeneration.pluginRoot,
    pluginFile: owner.bridgeGeneration.pluginFile
  });
  const getCurrentBridge2 = () => {
    const bridge = getGatewayRuntime2().currentBridge;
    if (!bridge) throw new Error("bncr current bridge unavailable");
    return bridge;
  };
  const clearRegistryRuntimeObservationTimer = (registryFingerprint) => {
    const runtime2 = getGatewayRuntime2();
    const entry = runtime2.runtimeObservationTimers.get(registryFingerprint);
    if (entry) {
      clearTimeout(entry.timer);
      runtime2.runtimeObservationTimers.delete(registryFingerprint);
    }
  };
  const readRegistryRuntimeProbe = () => {
    const bridge = getGatewayRuntime2().currentBridge;
    const probe = bridge?.getRuntimeObservation?.();
    return probe && typeof probe === "object" ? probe : {};
  };
  const isRegistryRuntimeLifecycleActive = (registryFingerprint, lifecycleGeneration) => {
    const active = getGatewayRuntime2().lifecycle.active;
    return Boolean(
      active && active.key.registryFingerprint === registryFingerprint && active.key.generation === lifecycleGeneration && (active.phase === "active" || active.phase === "registering")
    );
  };
  const probeRegistryRuntimeObservation2 = (registryFingerprint, bridgeGenerationKey, lifecycleGeneration, now = Date.now()) => {
    try {
      const runtime2 = getGatewayRuntime2();
      const declaration = runtime2.registryDeclarations.get(registryFingerprint);
      if (!declaration || declaration.bridgeGenerationKey !== bridgeGenerationKey || declaration.lifecycleGeneration !== lifecycleGeneration || !declaration.runtimeObservation) {
        return null;
      }
      const decision = evaluateRegistryRuntimeObservation({
        observation: declaration.runtimeObservation,
        now,
        lifecycleActive: declaration.registration === "complete" && declaration.state === "active" && isRegistryRuntimeLifecycleActive(registryFingerprint, lifecycleGeneration),
        probe: readRegistryRuntimeProbe()
      });
      declaration.runtimeObservation = decision.observation;
      if (decision.transitionedToPolling) {
        emitBncrLogLine(
          "warn",
          `[bncr] runtime observation timeout registry=${registryFingerprint} generation=${lifecycleGeneration} service=${decision.observation.serviceObservedAt !== null} channel=${decision.observation.channelObservedAt !== null} action=poll intervalMs=${REGISTRY_RUNTIME_OBSERVATION_POLL_MS}`
        );
      }
      if (decision.transitionedToReady) {
        emitBncrLogLine(
          "info",
          `[bncr] runtime observation ready registry=${registryFingerprint} generation=${lifecycleGeneration} probes=${decision.observation.probeCount}`
        );
      }
      if (decision.action === "wait" || decision.action === "poll") {
        clearRegistryRuntimeObservationTimer(registryFingerprint);
        const delay = decision.action === "poll" ? REGISTRY_RUNTIME_OBSERVATION_POLL_MS : Math.max(0, decision.observation.deadlineAt - now);
        const timer = setTimeout(() => {
          const current = runtime2.runtimeObservationTimers.get(registryFingerprint);
          if (current?.timer !== timer) return;
          runtime2.runtimeObservationTimers.delete(registryFingerprint);
          probeRegistryRuntimeObservation2(
            registryFingerprint,
            bridgeGenerationKey,
            lifecycleGeneration,
            Date.now()
          );
        }, delay);
        timer.unref?.();
        runtime2.runtimeObservationTimers.set(registryFingerprint, {
          timer,
          bridgeGenerationKey,
          lifecycleGeneration
        });
      } else {
        clearRegistryRuntimeObservationTimer(registryFingerprint);
      }
      return { ...decision.observation };
    } catch (error) {
      try {
        emitBncrLogLine(
          "warn",
          `[bncr] runtime observation probe failed registry=${registryFingerprint} generation=${lifecycleGeneration} error=${error instanceof Error ? error.message : String(error)}`
        );
      } catch {
      }
      try {
        const runtime2 = getGatewayRuntime2();
        const declaration = runtime2.registryDeclarations.get(registryFingerprint);
        if (declaration?.bridgeGenerationKey === bridgeGenerationKey && declaration.lifecycleGeneration === lifecycleGeneration && declaration.registration === "complete" && declaration.state === "active") {
          clearRegistryRuntimeObservationTimer(registryFingerprint);
          const timer = setTimeout(() => {
            const current = runtime2.runtimeObservationTimers.get(registryFingerprint);
            if (current?.timer !== timer) return;
            runtime2.runtimeObservationTimers.delete(registryFingerprint);
            probeRegistryRuntimeObservation2(
              registryFingerprint,
              bridgeGenerationKey,
              lifecycleGeneration,
              Date.now()
            );
          }, REGISTRY_RUNTIME_OBSERVATION_POLL_MS);
          timer.unref?.();
          runtime2.runtimeObservationTimers.set(registryFingerprint, {
            timer,
            bridgeGenerationKey,
            lifecycleGeneration
          });
        }
      } catch {
      }
      return null;
    }
  };
  const startRegistryRuntimeObservation = (registryFingerprint, bridgeGenerationKey, lifecycleGeneration, now = Date.now(), reset = false) => {
    const runtime2 = getGatewayRuntime2();
    const declaration = runtime2.registryDeclarations.get(registryFingerprint);
    if (!declaration || declaration.bridgeGenerationKey !== bridgeGenerationKey || declaration.lifecycleGeneration !== lifecycleGeneration || declaration.registration !== "complete" || declaration.state !== "active") {
      return null;
    }
    if (!reset && declaration.runtimeObservation) {
      return { ...declaration.runtimeObservation };
    }
    clearRegistryRuntimeObservationTimer(registryFingerprint);
    declaration.runtimeObservation = createRegistryRuntimeObservation(now);
    return probeRegistryRuntimeObservation2(
      registryFingerprint,
      bridgeGenerationKey,
      lifecycleGeneration,
      now
    );
  };
  const retireRegistryRuntimeObservation = (registryFingerprint, now = Date.now()) => {
    clearRegistryRuntimeObservationTimer(registryFingerprint);
    const declaration = getGatewayRuntime2().registryDeclarations.get(registryFingerprint);
    if (!declaration?.runtimeObservation) return;
    declaration.runtimeObservation = {
      ...declaration.runtimeObservation,
      phase: "retired",
      retiredAt: declaration.runtimeObservation.retiredAt ?? now
    };
  };
  const getRegistryRuntimeObservation = (registryFingerprint) => {
    const runtime2 = getGatewayRuntime2();
    const declaration = runtime2.registryDeclarations.get(registryFingerprint);
    if (declaration?.state === "active" && declaration.runtimeObservation) {
      return { ...declaration.runtimeObservation };
    }
    const activeRegistry = runtime2.lifecycle.active?.key.registryFingerprint;
    if (activeRegistry && activeRegistry !== registryFingerprint) {
      const activeObservation = runtime2.registryDeclarations.get(activeRegistry)?.runtimeObservation;
      if (activeObservation) return { ...activeObservation };
    }
    return declaration?.runtimeObservation ? { ...declaration.runtimeObservation } : null;
  };
  const planLifecycle2 = (api, now = Date.now()) => {
    const loaded = loadBncrRuntimeSync();
    const owner = getBridgeOwner(api, loaded);
    const runtime2 = getGatewayRuntime2();
    const input = {
      apiInstanceId: owner.apiInstanceId,
      registryFingerprint: owner.registryFingerprint,
      bridgeGeneration: {
        moduleEpoch: owner.moduleEpoch,
        bridgeFactoryId: owner.bridgeFactoryId,
        pluginVersion: owner.pluginVersion || "unknown",
        registrationMode: owner.registrationMode || "unknown",
        pluginRoot: owner.pluginRoot || pluginRoot,
        pluginFile: owner.pluginFile || pluginFile
      },
      now
    };
    const decision = planLifecycleAdoption(runtime2.lifecycle, input);
    const declaration = runtime2.registryDeclarations.get(owner.registryFingerprint);
    if (!declaration) return decision;
    const bridgeGenerationKey = getBridgeGenerationKey(input.bridgeGeneration);
    if (!declaration.bridgeGenerationKey) {
      declaration.bridgeGenerationKey = bridgeGenerationKey;
    } else if (declaration.bridgeGenerationKey !== bridgeGenerationKey) {
      return {
        kind: "reject",
        owner: decision.owner,
        reason: "registration-generation-conflict"
      };
    }
    if (declaration.registration === "failed") {
      return {
        kind: "reject",
        owner: decision.owner,
        reason: "registration-failed"
      };
    }
    if (declaration.registration === "pending") {
      return {
        kind: "reject",
        owner: decision.owner,
        reason: "registration-in-progress"
      };
    }
    return decision;
  };
  const commitLifecycle2 = (decision) => {
    const runtime2 = getGatewayRuntime2();
    if (decision.kind === "initialize" || decision.kind === "takeover") {
      runtime2.gatewayMethodDispatchers = gatewayMethodDispatchers;
    }
    const owner = commitLifecycleAdoption(runtime2.lifecycle, decision);
    const requestedRegistry = decision.owner.key.registryFingerprint;
    const requestedGeneration = decision.owner.key.generation;
    const requestedBridgeGenerationKey = getBridgeGenerationKey(decision.owner.bridgeGeneration);
    if (decision.kind === "initialize" || decision.kind === "takeover") {
      for (const [registryFingerprint, declaration2] of runtime2.registryDeclarations) {
        if (registryFingerprint !== owner?.key.registryFingerprint) {
          declaration2.state = "retired";
          retireRegistryRuntimeObservation(registryFingerprint);
        }
      }
      const declaration = getRegistryDeclaration2(
        requestedRegistry,
        requestedBridgeGenerationKey,
        requestedGeneration
      );
      if (declaration.bridgeGenerationKey && declaration.bridgeGenerationKey !== requestedBridgeGenerationKey) {
        declaration.service = "missing";
        declaration.channel = "missing";
      }
      declaration.bridgeGenerationKey = requestedBridgeGenerationKey;
      declaration.lifecycleGeneration = requestedGeneration;
      declaration.registration = "pending";
      declaration.state = "active";
      declaration.runtimeObservation = void 0;
    } else if (decision.kind === "defer") {
      const declaration = getRegistryDeclaration2(
        requestedRegistry,
        requestedBridgeGenerationKey,
        requestedGeneration
      );
      if (declaration.bridgeGenerationKey && declaration.bridgeGenerationKey !== requestedBridgeGenerationKey) {
        declaration.service = "missing";
        declaration.channel = "missing";
      }
      declaration.bridgeGenerationKey = requestedBridgeGenerationKey;
      declaration.lifecycleGeneration = requestedGeneration;
      declaration.registration = "pending";
      declaration.state = "shadow";
      declaration.runtimeObservation = void 0;
    } else if (decision.kind === "duplicate") {
      const existing = runtime2.registryDeclarations.get(requestedRegistry);
      if (!existing) {
        const declaration = getRegistryDeclaration2(
          requestedRegistry,
          requestedBridgeGenerationKey,
          requestedGeneration
        );
        declaration.registration = "pending";
        declaration.state = "shadow";
      } else if (!existing.bridgeGenerationKey || existing.bridgeGenerationKey === requestedBridgeGenerationKey) {
        existing.bridgeGenerationKey ||= requestedBridgeGenerationKey;
        const activeRegistry = runtime2.lifecycle.active?.key.registryFingerprint;
        const pendingRegistry = runtime2.lifecycle.pending?.key.registryFingerprint;
        if (requestedRegistry === activeRegistry && runtime2.lifecycle.active?.phase !== "stopped") {
          existing.state = "active";
        } else if (requestedRegistry === pendingRegistry) {
          existing.state = "shadow";
        }
      }
    }
    pruneRegistryLedgers(runtime2);
    return owner;
  };
  const adoptLifecycleBridge2 = (api, owner, mode) => {
    try {
      const adopted = bridgeSingletonManager.adoptBridgeSingleton(api, toBridgeOwner(owner), mode);
      getGatewayRuntime2().currentBridge = adopted.bridge;
      return adopted;
    } catch (error) {
      const lifecycle = getGatewayRuntime2().lifecycle;
      if (lifecycle.active?.key.generation === owner.key.generation && lifecycle.active.key.registryFingerprint === owner.key.registryFingerprint) {
        failLifecycle(lifecycle, owner.key.registryFingerprint, error, owner.key.generation);
        const declaration = getRegistryDeclaration2(
          owner.key.registryFingerprint,
          getBridgeGenerationKey(owner.bridgeGeneration),
          owner.key.generation
        );
        declaration.registration = "failed";
        declaration.state = "retired";
        retireRegistryRuntimeObservation(owner.key.registryFingerprint);
      }
      throw error;
    }
  };
  const beginRetirement2 = (registryFingerprint, expectedGeneration, now = Date.now()) => {
    const retirement = beginLifecycleRetirement(
      getGatewayRuntime2().lifecycle,
      registryFingerprint,
      now,
      expectedGeneration
    );
    if (retirement) {
      retireRegistryRuntimeObservation(registryFingerprint, now);
    }
    return retirement;
  };
  const settleRetirement2 = (registryFingerprint, outcome, expectedGeneration, now = Date.now()) => {
    const settled = settleLifecycleRetirement(
      getGatewayRuntime2().lifecycle,
      registryFingerprint,
      outcome,
      now,
      expectedGeneration
    );
    if (settled) {
      const lifecycle = getGatewayRuntime2().lifecycle;
      const declaration = getRegistryDeclaration2(registryFingerprint);
      if (!outcome.ok) {
        declaration.state = "retired";
        retireRegistryRuntimeObservation(registryFingerprint, now);
        const pendingRegistry = lifecycle.pending?.key.registryFingerprint;
        if (pendingRegistry && pendingRegistry !== registryFingerprint) {
          getRegistryDeclaration2(pendingRegistry).state = "retired";
          retireRegistryRuntimeObservation(pendingRegistry, now);
        }
      } else {
        declaration.state = lifecycle.pending?.key.registryFingerprint === registryFingerprint ? "shadow" : "retired";
        retireRegistryRuntimeObservation(registryFingerprint, now);
      }
    }
    return settled;
  };
  const getLifecycleBridgeForStart2 = async (api, registryFingerprint, expectedGeneration) => {
    const runtime2 = getGatewayRuntime2();
    const state = runtime2.lifecycle;
    if (runtime2.registryDeclarations.get(registryFingerprint)?.registration === "failed") {
      state.staleCallbackSuppressions += 1;
      return null;
    }
    if (isLifecycleRegistryActive(state, registryFingerprint, expectedGeneration)) {
      getRegistryDeclaration2(registryFingerprint).state = "active";
      startRegistryRuntimeObservation(
        registryFingerprint,
        getBridgeGenerationKey(state.active.bridgeGeneration),
        expectedGeneration
      );
      return runtime2.currentBridge || null;
    }
    const pending = getPendingLifecycle(state);
    if (pending?.key.registryFingerprint === registryFingerprint && pending.key.generation === expectedGeneration) {
      const pendingMode = state.pendingMode || "reuse";
      const retirement = state.retirement;
      const outcome = retirement ? await retirement : { ok: true };
      if (!outcome.ok) {
        throw new Error(`bncr lifecycle predecessor stop failed: ${outcome.error}`);
      }
      const activated = activatePendingLifecycle(
        state,
        registryFingerprint,
        Date.now(),
        expectedGeneration
      );
      if (activated) {
        getRegistryDeclaration2(registryFingerprint).state = "active";
        const bridge = adoptLifecycleBridge2(api, activated, pendingMode).bridge;
        runtime2.gatewayMethodDispatchers = gatewayMethodDispatchers;
        startRegistryRuntimeObservation(
          registryFingerprint,
          getBridgeGenerationKey(activated.bridgeGeneration),
          expectedGeneration,
          Date.now(),
          true
        );
        return bridge;
      }
    }
    const reactivated = reactivateStoppedLifecycle(
      state,
      registryFingerprint,
      Date.now(),
      expectedGeneration
    );
    if (reactivated) {
      getRegistryDeclaration2(registryFingerprint).state = "active";
      const bridge = adoptLifecycleBridge2(api, reactivated, "reuse").bridge;
      runtime2.gatewayMethodDispatchers = gatewayMethodDispatchers;
      startRegistryRuntimeObservation(
        registryFingerprint,
        getBridgeGenerationKey(reactivated.bridgeGeneration),
        expectedGeneration,
        Date.now(),
        true
      );
      return bridge;
    }
    if (isLifecycleRegistryActive(state, registryFingerprint, expectedGeneration)) {
      getRegistryDeclaration2(registryFingerprint).state = "active";
      startRegistryRuntimeObservation(
        registryFingerprint,
        getBridgeGenerationKey(state.active.bridgeGeneration),
        expectedGeneration
      );
      return runtime2.currentBridge || null;
    }
    state.staleCallbackSuppressions += 1;
    return null;
  };
  const failLifecycleStart2 = (registryFingerprint, error, expectedGeneration) => {
    const failed = failLifecycle(
      getGatewayRuntime2().lifecycle,
      registryFingerprint,
      error,
      expectedGeneration
    );
    if (failed) {
      getRegistryDeclaration2(registryFingerprint).state = "retired";
      retireRegistryRuntimeObservation(registryFingerprint);
    }
    return failed;
  };
  const recoverLifecycleRegistration2 = (decision, error) => {
    const runtime2 = getGatewayRuntime2();
    const state = runtime2.lifecycle;
    const owner = decision.owner;
    const ownsActive = Boolean(
      state.active && state.active.key.registryFingerprint === owner.key.registryFingerprint && state.active.key.generation === owner.key.generation
    );
    const ownsPending = Boolean(
      state.pending && state.pending.key.registryFingerprint === owner.key.registryFingerprint && state.pending.key.generation === owner.key.generation
    );
    let outcome = "none";
    if (ownsActive && (decision.kind === "initialize" || decision.kind === "takeover")) {
      if (state.active) {
        state.active.phase = "stopped";
        state.active.stopRequestedAt = null;
        state.active.stoppedAt = Date.now();
        state.active.failure = null;
      }
      state.pending = void 0;
      state.pendingMode = void 0;
      state.retirement = void 0;
      state.resolveRetirement = void 0;
      outcome = "stopped";
    } else if (ownsPending && decision.kind === "defer") {
      state.pending = void 0;
      state.pendingMode = void 0;
      outcome = "pending-dropped";
    } else if (ownsActive) {
      failLifecycle(state, owner.key.registryFingerprint, error, owner.key.generation);
      outcome = "failed";
    }
    const declaration = runtime2.registryDeclarations.get(owner.key.registryFingerprint);
    const ownsDeclaration = Boolean(
      declaration && declaration.bridgeGenerationKey === getBridgeGenerationKey(owner.bridgeGeneration) && declaration.lifecycleGeneration === owner.key.generation
    );
    if (ownsDeclaration && declaration) {
      declaration.registration = "failed";
      declaration.state = "retired";
      retireRegistryRuntimeObservation(owner.key.registryFingerprint);
    }
    return outcome;
  };
  const canStopLifecycleRegistry2 = (registryFingerprint, expectedGeneration) => {
    const state = getGatewayRuntime2().lifecycle;
    const allowed = isLifecycleRegistryStoppable(state, registryFingerprint, expectedGeneration);
    if (!allowed) {
      state.staleCallbackSuppressions += 1;
    }
    return allowed;
  };
  const canStartLifecycleRegistry2 = (registryFingerprint, expectedGeneration) => {
    const state = getGatewayRuntime2().lifecycle;
    const allowed = getGatewayRuntime2().registryDeclarations.get(registryFingerprint)?.registration !== "failed" && isLifecycleRegistryActive(state, registryFingerprint, expectedGeneration);
    if (!allowed) {
      state.staleCallbackSuppressions += 1;
    }
    return allowed;
  };
  const isLifecycleRegistryCurrent2 = (registryFingerprint, expectedGeneration) => isLifecycleRegistryActive(
    getGatewayRuntime2().lifecycle,
    registryFingerprint,
    expectedGeneration
  );
  const getRegistryDeclaration2 = (registryFingerprint, bridgeGenerationKey = "", lifecycleGeneration = 0) => {
    const runtime2 = getGatewayRuntime2();
    let declaration = runtime2.registryDeclarations.get(registryFingerprint);
    if (!declaration) {
      declaration = {
        bridgeGenerationKey,
        lifecycleGeneration,
        service: "missing",
        channel: "missing",
        registration: "pending",
        state: "shadow"
      };
      runtime2.registryDeclarations.set(registryFingerprint, declaration);
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
  const markRegistryServiceDeclared2 = (registryFingerprint, bridgeGenerationKey, lifecycleGeneration) => {
    const declaration = getRegistryDeclaration2(
      registryFingerprint,
      bridgeGenerationKey,
      lifecycleGeneration
    );
    if (declaration.bridgeGenerationKey !== bridgeGenerationKey) {
      throw new Error(`bncr service declaration scope mismatch: ${registryFingerprint}`);
    }
    declaration.lifecycleGeneration = lifecycleGeneration;
    declaration.service = "declared";
    return declaration;
  };
  const markRegistryChannelDeclared2 = (registryFingerprint, bridgeGenerationKey, lifecycleGeneration) => {
    const declaration = getRegistryDeclaration2(
      registryFingerprint,
      bridgeGenerationKey,
      lifecycleGeneration
    );
    if (declaration.bridgeGenerationKey !== bridgeGenerationKey) {
      throw new Error(`bncr channel declaration scope mismatch: ${registryFingerprint}`);
    }
    declaration.lifecycleGeneration = lifecycleGeneration;
    declaration.channel = "declared";
    return declaration;
  };
  const markRegistryRegistrationComplete2 = (registryFingerprint, bridgeGenerationKey, lifecycleGeneration) => {
    const declaration = getRegistryDeclaration2(
      registryFingerprint,
      bridgeGenerationKey,
      lifecycleGeneration
    );
    if (declaration.bridgeGenerationKey !== bridgeGenerationKey) {
      throw new Error(`bncr register scope mismatch: ${registryFingerprint}`);
    }
    declaration.lifecycleGeneration ||= lifecycleGeneration;
    declaration.registration = "complete";
    if (declaration.state === "active") {
      startRegistryRuntimeObservation(
        registryFingerprint,
        bridgeGenerationKey,
        declaration.lifecycleGeneration
      );
    }
    return declaration;
  };
  return {
    getRegisterMeta: getRegisterMeta2,
    getGlobalRegisterTrace: getGlobalRegisterTrace2,
    noteRegisterTraceValue: rememberRegisterTraceValue,
    getBridgeGenerationKey,
    getGatewayRuntime: getGatewayRuntime2,
    planLifecycle: planLifecycle2,
    commitLifecycle: commitLifecycle2,
    adoptLifecycleBridge: adoptLifecycleBridge2,
    beginRetirement: beginRetirement2,
    settleRetirement: settleRetirement2,
    getLifecycleBridgeForStart: getLifecycleBridgeForStart2,
    failLifecycleStart: failLifecycleStart2,
    recoverLifecycleRegistration: recoverLifecycleRegistration2,
    canStopLifecycleRegistry: canStopLifecycleRegistry2,
    canStartLifecycleRegistry: canStartLifecycleRegistry2,
    isLifecycleRegistryCurrent: isLifecycleRegistryCurrent2,
    getRegistryDeclaration: getRegistryDeclaration2,
    getRegistryRuntimeObservation,
    startRegistryRuntimeObservation,
    probeRegistryRuntimeObservation: probeRegistryRuntimeObservation2,
    retireRegistryRuntimeObservation,
    markRegistryServiceDeclared: markRegistryServiceDeclared2,
    markRegistryChannelDeclared: markRegistryChannelDeclared2,
    markRegistryRegistrationComplete: markRegistryRegistrationComplete2,
    pruneRegistryLedgers: () => pruneRegistryLedgers(getGatewayRuntime2()),
    ensureGatewayMethodRegistered: gatewayMethodRegistry.ensureGatewayMethodRegistered,
    getBridgeSingleton: bridgeSingletonManager.getBridgeSingleton,
    getBridgeOwnerFromBridge: bridgeSingletonManager.getBridgeOwnerFromBridge,
    getExistingBridgeSingleton: bridgeSingletonManager.getExistingBridgeSingleton,
    getCurrentBridge: getCurrentBridge2
  };
}

// src/core/config-schema.ts
var BncrConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: true,
    properties: {
      enabled: { type: "boolean" },
      dmPolicy: {
        type: "string",
        enum: ["open", "allowlist", "disabled"]
      },
      groupPolicy: {
        type: "string",
        enum: ["open", "allowlist", "disabled"]
      },
      allowFrom: {
        type: "array",
        items: { type: "string" }
      },
      groupAllowFrom: {
        type: "array",
        items: { type: "string" }
      },
      debug: {
        type: "object",
        additionalProperties: true,
        properties: {
          verbose: {
            type: "boolean",
            default: false,
            description: "Enable verbose debug logs for bncr channel runtime."
          }
        }
      },
      allowTool: {
        type: "boolean",
        default: false,
        description: "Allow tool messages to be forwarded when streaming is enabled. Defaults to false; only explicit true enables forwarding. When enabled, bncr also requests upstream tool summaries/results."
      },
      requireMention: {
        type: "boolean",
        default: false,
        description: "Whether group messages must explicitly mention the bot before bncr handles them. Default false. Current version keeps this as a reserved field and does not enforce it yet."
      },
      outboundRequireAck: {
        type: "boolean",
        default: true,
        description: "Whether outbound text waits for bncr.ack before leaving the retry queue. Default true to preserve current ack/dead-letter behavior."
      },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: true,
          properties: {
            enabled: { type: "boolean" },
            name: { type: "string" }
          }
        }
      }
    }
  }
};

// index.ts
var pluginVersion2 = pluginVersion;
var registerRuntime = createBncrRegisterRuntime();
var {
  adoptLifecycleBridge,
  beginRetirement,
  canStartLifecycleRegistry,
  canStopLifecycleRegistry,
  commitLifecycle,
  ensureGatewayMethodRegistered,
  getBridgeOwnerFromBridge,
  getBridgeGenerationKey: getBridgeGenerationKey2,
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
  pruneRegistryLedgers: pruneRegistryLedgers2,
  recoverLifecycleRegistration,
  settleRetirement,
  failLifecycleStart
} = registerRuntime;
var plugin = {
  id: "bncr",
  name: "Bncr",
  description: "Bncr channel plugin",
  configSchema: BncrConfigSchema,
  register(api) {
    registerBncrCli(api);
    if (shouldSkipNonRuntimeRegister(api.registrationMode)) return;
    const meta = getRegisterMeta(api);
    meta.registrationMode = api.registrationMode;
    const globalTrace = getGlobalRegisterTrace();
    const previousApiInstanceId = globalTrace.lastApiInstanceId;
    const previousRegistryFingerprint = globalTrace.lastRegistryFingerprint;
    const apiInstanceId = meta.apiInstanceId || "unknown";
    const registryFingerprint = meta.registryFingerprint || "unknown";
    const sameApiAsPrevious = previousApiInstanceId === apiInstanceId;
    const sameRegistryAsPrevious = previousRegistryFingerprint === registryFingerprint;
    const apiSeenRecently = globalTrace.seenApiInstanceIds.has(apiInstanceId);
    const registrySeenRecently = globalTrace.seenRegistryFingerprints.has(registryFingerprint);
    let ownerDecision;
    try {
      const gatewayRuntime = getGatewayRuntime();
      ownerDecision = planLifecycle(api);
      const lifecycleOwner = commitLifecycle(ownerDecision);
      let bridge;
      const runtime2 = loadBncrRuntimeSync();
      let created = false;
      let rebuilt = false;
      let owner;
      let previousOwner;
      const shouldDeclareLifecycle = ownerDecision.kind === "initialize" || ownerDecision.kind === "takeover" || ownerDecision.kind === "defer";
      if (ownerDecision.kind === "initialize") {
        if (lifecycleOwner) {
          const adopted = adoptLifecycleBridge(api, lifecycleOwner, "create");
          bridge = adopted.bridge;
          created = adopted.created;
          rebuilt = adopted.rebuilt;
          owner = adopted.owner;
          previousOwner = adopted.previousOwner;
        }
      } else if (ownerDecision.kind === "takeover") {
        if (lifecycleOwner) {
          const adopted = adoptLifecycleBridge(api, lifecycleOwner, ownerDecision.mode);
          bridge = adopted.bridge;
          created = adopted.created;
          rebuilt = adopted.rebuilt;
          owner = adopted.owner;
          previousOwner = adopted.previousOwner;
        }
      } else if (ownerDecision.kind === "defer") {
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
      if (bridge && !gatewayRuntime.currentBridge) {
        gatewayRuntime.currentBridge = bridge;
      }
      noteRegisterTraceValue(globalTrace.seenApiInstanceIds, apiInstanceId);
      noteRegisterTraceValue(globalTrace.seenRegistryFingerprints, registryFingerprint);
      globalTrace.lastApiInstanceId = apiInstanceId;
      globalTrace.lastRegistryFingerprint = registryFingerprint;
      bridge?.noteRegister?.({
        source: "@xmoxmo/bncr",
        pluginVersion: pluginVersion2,
        apiRebound: ownerDecision.kind === "takeover" && !created && !rebuilt,
        apiInstanceId: meta.apiInstanceId,
        registryFingerprint: meta.registryFingerprint
      });
      const debugLog = (...args) => {
        const rendered = args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ").trim();
        if (!rendered) return;
        emitBncrLogLine(
          "info",
          `[bncr] debug ${rendered}`,
          { debugOnly: true },
          () => Boolean(bridge?.isDebugEnabled?.())
        );
      };
      debugLog(
        `register begin bridge=${bridge?.getBridgeId?.() || "unknown"} created=${created} rebuilt=${rebuilt} ownerApi=${owner?.apiInstanceId || "none"} ownerRegistry=${owner?.registryFingerprint || "none"} previousOwnerApi=${previousOwner?.apiInstanceId || "none"} previousOwnerRegistry=${previousOwner?.registryFingerprint || "none"}`
      );
      debugLog(
        `register classify mode=${meta.registrationMode || "unknown"} api=${apiInstanceId} registry=${registryFingerprint} sameApiAsPrevious=${sameApiAsPrevious} sameRegistryAsPrevious=${sameRegistryAsPrevious} apiSeenRecently=${apiSeenRecently} registrySeenRecently=${registrySeenRecently}`
      );
      debugLog(
        `register lifecycle decision=${ownerDecision.kind} reason=${ownerDecision.reason} generation=${ownerDecision.owner.key.generation} existingOwnerApi=${previousOwner?.apiInstanceId || "none"}`
      );
      if (!shouldDeclareLifecycle) {
        debugLog(
          `service/channel declaration suppressed for ${ownerDecision.kind} registry=${registryFingerprint}`
        );
      }
      const resolveDebug = async () => {
        try {
          const cfg = getOpenClawRuntimeConfig(api);
          return Boolean(cfg?.channels?.bncr?.debug?.verbose);
        } catch {
          return false;
        }
      };
      const registryGeneration = ownerDecision.owner.key.generation;
      const registryBridgeGenerationKey = getBridgeGenerationKey2(
        ownerDecision.owner.bridgeGeneration
      );
      const registryDeclaration = ownerDecision.kind === "reject" ? gatewayRuntime.registryDeclarations.get(registryFingerprint) : getRegistryDeclaration(
        registryFingerprint,
        registryBridgeGenerationKey,
        registryGeneration
      );
      const serviceDeclaredForGeneration = registryDeclaration?.service === "declared";
      const channelDeclaredForGeneration = registryDeclaration?.channel === "declared";
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
          id: "bncr-bridge-service",
          start: async (ctx) => {
            const lifecycleBridge = await getLifecycleBridgeForStart(
              api,
              registryFingerprint,
              registryGeneration
            );
            if (!lifecycleBridge) {
              debugLog(`service start suppressed for stale registry=${registryFingerprint}`);
              return;
            }
            const debug = await resolveDebug();
            if (!canStartLifecycleRegistry(registryFingerprint, registryGeneration)) {
              debugLog(
                `service start suppressed after await for stale registry=${registryFingerprint}`
              );
              return;
            }
            try {
              const started = await lifecycleBridge.startService(
                ctx,
                debug,
                () => isLifecycleRegistryCurrent(registryFingerprint, registryGeneration)
              );
              if (started === false || !canStartLifecycleRegistry(registryFingerprint, registryGeneration)) {
                debugLog(
                  `service start suppressed after await for stale registry=${registryFingerprint}`
                );
                return;
              }
              probeRegistryRuntimeObservation(
                registryFingerprint,
                registryBridgeGenerationKey,
                registryGeneration
              );
            } catch (error) {
              failLifecycleStart(registryFingerprint, error, registryGeneration);
              throw error;
            }
          },
          stop: serviceStopHandler
        });
        markRegistryServiceDeclared(
          registryFingerprint,
          registryBridgeGenerationKey,
          registryGeneration
        );
        meta.service = true;
        debugLog(`register service ok ownerApi=${apiInstanceId}`);
      } else {
        meta.service = registryDeclaration?.service === "declared";
        debugLog(
          `register service skip registry=${registryFingerprint} declared=${registryDeclaration?.service || "missing"}`
        );
      }
      if (shouldDeclareLifecycle && !channelDeclaredForGeneration) {
        api.registerChannel({
          plugin: createDynamicChannelPlugin({
            loaded: runtime2,
            getCurrentBridge,
            resolveBridgeForStart: async () => {
              const lifecycleBridge = await getLifecycleBridgeForStart(
                api,
                registryFingerprint,
                registryGeneration
              );
              if (!lifecycleBridge) {
                throw new Error(`bncr lifecycle registry is inactive: ${registryFingerprint}`);
              }
              return lifecycleBridge;
            },
            isBridgeForStartCurrent: () => canStartLifecycleRegistry(registryFingerprint, registryGeneration),
            onBridgeStartObserved: () => probeRegistryRuntimeObservation(
              registryFingerprint,
              registryBridgeGenerationKey,
              registryGeneration
            ),
            resolveBridgeForStop: () => {
              if (!canStopLifecycleRegistry(registryFingerprint, registryGeneration)) {
                debugLog(`channel stop suppressed for stale registry=${registryFingerprint}`);
                return null;
              }
              return getCurrentBridge();
            },
            isBridgeForStopCurrent: () => canStopLifecycleRegistry(registryFingerprint, registryGeneration)
          })
        });
        markRegistryChannelDeclared(
          registryFingerprint,
          registryBridgeGenerationKey,
          registryGeneration
        );
        meta.channel = true;
        debugLog(`register channel ok ownerApi=${apiInstanceId}`);
      } else {
        meta.channel = registryDeclaration?.channel === "declared";
        debugLog(
          `register channel skip registry=${registryFingerprint} declared=${registryDeclaration?.channel || "missing"}`
        );
      }
      ensureGatewayMethodRegistered(api, "bncr.connect", debugLog);
      ensureGatewayMethodRegistered(api, "bncr.inbound", debugLog);
      ensureGatewayMethodRegistered(api, "bncr.activity", debugLog);
      ensureGatewayMethodRegistered(api, "bncr.ack", debugLog);
      ensureGatewayMethodRegistered(api, "bncr.diagnostics", debugLog);
      ensureGatewayMethodRegistered(api, "bncr.deadLetter.inspect", debugLog);
      ensureGatewayMethodRegistered(api, "bncr.deadLetter.prune", debugLog);
      ensureGatewayMethodRegistered(api, "bncr.rpc.response", debugLog);
      ensureGatewayMethodRegistered(api, "bncr.file.init", debugLog);
      ensureGatewayMethodRegistered(api, "bncr.file.chunk", debugLog);
      ensureGatewayMethodRegistered(api, "bncr.file.complete", debugLog);
      ensureGatewayMethodRegistered(api, "bncr.file.abort", debugLog);
      ensureGatewayMethodRegistered(api, "bncr.file.ack", debugLog);
      if (ownerDecision.kind !== "reject") {
        markRegistryRegistrationComplete(
          registryFingerprint,
          registryBridgeGenerationKey,
          registryGeneration
        );
      }
      pruneRegistryLedgers2();
      debugLog("register done");
    } catch (error) {
      const recovered = ownerDecision ? recoverLifecycleRegistration(ownerDecision, error) : "plan-not-committed";
      emitBncrLogLine(
        "error",
        `[bncr] register failed recovered=${recovered} error=${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }
};
var index_default = plugin;
export {
  index_default as default
};
