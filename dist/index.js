// index.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// src/openclaw/config-runtime.ts
function resolveConfigApi(api) {
  const config = api?.runtime?.config;
  if (!config) throw new Error("OpenClaw runtime config API is unavailable");
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

// index.ts
var pluginFile = fileURLToPath(import.meta.url);
var pluginDir = path.dirname(pluginFile);
var pluginRequire = createRequire(import.meta.url);
var sdkCoreSpecifier = "openclaw/plugin-sdk/core";
var linkType = process.platform === "win32" ? "junction" : "dir";
var BNCR_REGISTER_META = /* @__PURE__ */ Symbol.for("bncr.register.meta");
var BNCR_GLOBAL_REGISTER_TRACE = /* @__PURE__ */ Symbol.for("bncr.global.register.trace");
var BNCR_BRIDGE_OWNER = /* @__PURE__ */ Symbol.for("bncr.bridge.owner");
var BNCR_GATEWAY_RUNTIME = /* @__PURE__ */ Symbol.for("bncr.gateway.runtime");
var MODULE_EPOCH = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
var runtime = null;
var activeServiceStop = null;
var identityIds = /* @__PURE__ */ new WeakMap();
var identitySeq = 0;
var tryExec = (command, args) => {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
};
var readOpenClawPackageName = (pkgPath) => {
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.name === "string" ? parsed.name : "";
  } catch {
    return "";
  }
};
var readPluginVersion = () => {
  try {
    const raw = fs.readFileSync(path.join(pluginDir, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
};
var pluginVersion = readPluginVersion();
var findOpenClawPackageRoot = (startPath) => {
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
};
var unique = (items) => {
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
};
var collectOpenClawCandidates = () => {
  const directCandidates = [
    path.join(pluginDir, "node_modules", "openclaw"),
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
};
var canResolveSdkCore = () => {
  try {
    pluginRequire.resolve(sdkCoreSpecifier);
    return true;
  } catch {
    return false;
  }
};
var ensurePluginNodeModulesLink = (targetRoot) => {
  const nodeModulesDir = path.join(pluginDir, "node_modules");
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
};
var ensureOpenClawSdkResolution = () => {
  if (canResolveSdkCore()) return;
  let lastError = "";
  const candidates = collectOpenClawCandidates();
  for (const candidate of candidates) {
    try {
      ensurePluginNodeModulesLink(candidate);
      if (canResolveSdkCore()) return;
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }
  const suffix = candidates.length ? ` Tried candidates: ${candidates.join(", ")}.` : " No openclaw package root candidates were found from npm root, NODE_PATH, common global paths, or the openclaw binary path.";
  const extra = lastError ? ` Last repair error: ${lastError}.` : "";
  throw new Error(
    `bncr failed to resolve ${sdkCoreSpecifier} from ${pluginDir}.${suffix}${extra} You can repair manually with: mkdir -p ${path.join(pluginDir, "node_modules")} && ln -s "$(npm root -g)/openclaw" ${path.join(pluginDir, "node_modules", "openclaw")}`
  );
};
var loadRuntimeSync = () => {
  if (runtime) return runtime;
  ensureOpenClawSdkResolution();
  try {
    const mod = pluginRequire("./src/channel.ts");
    runtime = {
      createBncrBridge: mod.createBncrBridge,
      createBncrChannelPlugin: mod.createBncrChannelPlugin
    };
    return runtime;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`bncr failed to load channel runtime after dependency bootstrap: ${detail}`);
  }
};
var getIdentityId = (obj, prefix) => {
  const existing = identityIds.get(obj);
  if (existing) return existing;
  const next = `${prefix}_${MODULE_EPOCH}_${++identitySeq}`;
  identityIds.set(obj, next);
  return next;
};
var getRegistryFingerprint = (api) => {
  const serviceId = getIdentityId(api.registerService, "svc");
  const channelId = getIdentityId(api.registerChannel, "chn");
  const methodId = getIdentityId(api.registerGatewayMethod, "mth");
  return `${serviceId}:${channelId}:${methodId}`;
};
var getRegisterMeta = (api) => {
  const host = api;
  if (!host[BNCR_REGISTER_META]) {
    host[BNCR_REGISTER_META] = { methods: /* @__PURE__ */ new Set() };
  }
  if (!host[BNCR_REGISTER_META].methods) {
    host[BNCR_REGISTER_META].methods = /* @__PURE__ */ new Set();
  }
  if (!host[BNCR_REGISTER_META].apiInstanceId) {
    host[BNCR_REGISTER_META].apiInstanceId = getIdentityId(api, "api");
  }
  if (!host[BNCR_REGISTER_META].registryFingerprint) {
    host[BNCR_REGISTER_META].registryFingerprint = getRegistryFingerprint(api);
  }
  return host[BNCR_REGISTER_META];
};
var getProcessStore = () => {
  const p = process;
  return p;
};
var getGlobalRegisterTrace = () => {
  const p = getProcessStore();
  if (!p[BNCR_GLOBAL_REGISTER_TRACE]) {
    p[BNCR_GLOBAL_REGISTER_TRACE] = {
      seenRegistryFingerprints: /* @__PURE__ */ new Set(),
      seenApiInstanceIds: /* @__PURE__ */ new Set()
    };
  }
  return p[BNCR_GLOBAL_REGISTER_TRACE];
};
var getGatewayRuntime = () => {
  const p = getProcessStore();
  if (!p[BNCR_GATEWAY_RUNTIME]) {
    p[BNCR_GATEWAY_RUNTIME] = {
      registeredMethodsByRegistry: /* @__PURE__ */ new Map(),
      serviceRegistered: false,
      channelRegistered: false
    };
  }
  return p[BNCR_GATEWAY_RUNTIME];
};
var getProcessOwnerApiInstanceId = (gatewayRuntime) => gatewayRuntime.serviceOwnerApiInstanceId || gatewayRuntime.channelOwnerApiInstanceId || void 0;
var shouldAdoptProcessOwner = (apiInstanceId, gatewayRuntime) => {
  const existingOwnerApiInstanceId = getProcessOwnerApiInstanceId(gatewayRuntime);
  const hasSingletonOwner = Boolean(gatewayRuntime.serviceRegistered) || Boolean(gatewayRuntime.channelRegistered);
  if (!hasSingletonOwner) {
    return {
      adoptOwner: true,
      existingOwnerApiInstanceId,
      reason: "no-singleton-owner"
    };
  }
  if (existingOwnerApiInstanceId && existingOwnerApiInstanceId === apiInstanceId) {
    return {
      adoptOwner: true,
      existingOwnerApiInstanceId,
      reason: "same-owner-api"
    };
  }
  return {
    adoptOwner: false,
    existingOwnerApiInstanceId,
    reason: "singleton-owned-by-other-api"
  };
};
var gatewayMethodDispatchers = {
  "bncr.connect": (bridge, opts) => bridge.handleConnect(opts),
  "bncr.inbound": (bridge, opts) => bridge.handleInbound(opts),
  "bncr.activity": (bridge, opts) => bridge.handleActivity(opts),
  "bncr.ack": (bridge, opts) => bridge.handleAck(opts),
  "bncr.diagnostics": (bridge, opts) => bridge.handleDiagnostics(opts),
  "bncr.file.init": (bridge, opts) => bridge.handleFileInit(opts),
  "bncr.file.chunk": (bridge, opts) => bridge.handleFileChunk(opts),
  "bncr.file.complete": (bridge, opts) => bridge.handleFileComplete(opts),
  "bncr.file.abort": (bridge, opts) => bridge.handleFileAbort(opts),
  "bncr.file.ack": (bridge, opts) => bridge.handleFileAck(opts)
};
var dispatchGatewayMethod = (name, opts) => {
  const gatewayRuntime = getGatewayRuntime();
  const bridge = gatewayRuntime.currentBridge;
  if (!bridge) {
    throw new Error(`bncr gateway runtime unavailable for ${name}`);
  }
  try {
    return gatewayMethodDispatchers[name](bridge, opts);
  } catch (error) {
    const detail = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack || null
    } : { name: "NonError", message: String(error), stack: null };
    emitBncrLogLine(
      "error",
      `[bncr] gateway method error ${JSON.stringify({
        method: name,
        bridgeId: bridge.getBridgeId?.() || null,
        gatewayPid: bridge.gatewayPid || null,
        detail
      })}`,
      { debugOnly: true },
      () => true
    );
    throw error;
  }
};
var mirrorGatewayMethodForMockApi = (api, name) => {
  const host = api;
  if (!Array.isArray(host.methods)) return;
  if (host.methods.some((item) => item?.name === name)) return;
  host.methods.push({ name, handler: (opts) => dispatchGatewayMethod(name, opts) });
};
var ensureGatewayMethodRegistered = (api, name, debugLog) => {
  const meta = getRegisterMeta(api);
  const gatewayRuntime = getGatewayRuntime();
  const registryFingerprint = meta.registryFingerprint || getRegistryFingerprint(api);
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
  api.registerGatewayMethod(name, (opts) => dispatchGatewayMethod(name, opts));
  mirrorGatewayMethodForMockApi(api, name);
  registryMethods.add(name);
  meta.methods?.add(name);
  debugLog(`register method ok ${name}`);
};
var getBridgeOwner = (api, loaded) => {
  const meta = getRegisterMeta(api);
  return {
    moduleEpoch: MODULE_EPOCH,
    bridgeFactoryId: getIdentityId(loaded.createBncrBridge, "bridgeFactory"),
    apiInstanceId: meta.apiInstanceId || "unknown",
    registryFingerprint: meta.registryFingerprint || "unknown",
    registrationMode: meta.registrationMode
  };
};
var sameBridgeOwner = (left, right) => {
  if (!left || !right) return false;
  return left.moduleEpoch === right.moduleEpoch && left.bridgeFactoryId === right.bridgeFactoryId && left.apiInstanceId === right.apiInstanceId && left.registryFingerprint === right.registryFingerprint;
};
var snapshotBridgeRegisterState = (bridge) => {
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
};
var hydrateBridgeRegisterState = (bridge, snapshot) => {
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
};
var assignBridgeOwner = (bridge, owner) => {
  bridge[BNCR_BRIDGE_OWNER] = owner;
  return bridge;
};
var getBridgeSingleton = (api) => {
  const loaded = loadRuntimeSync();
  const g = globalThis;
  const owner = getBridgeOwner(api, loaded);
  const previousOwner = g.__bncrBridge?.[BNCR_BRIDGE_OWNER];
  let created = false;
  let rebuilt = false;
  if (g.__bncrBridge) {
    const mustRebuild = !sameBridgeOwner(previousOwner, owner) && (previousOwner?.moduleEpoch !== owner.moduleEpoch || previousOwner?.bridgeFactoryId !== owner.bridgeFactoryId || previousOwner?.registrationMode !== owner.registrationMode || previousOwner?.apiInstanceId !== owner.apiInstanceId || previousOwner?.registryFingerprint !== owner.registryFingerprint);
    if (mustRebuild) {
      const registerState = snapshotBridgeRegisterState(g.__bncrBridge);
      try {
        g.__bncrBridge.stopService?.();
      } catch {
      }
      g.__bncrBridge = hydrateBridgeRegisterState(
        assignBridgeOwner(loaded.createBncrBridge(api), owner),
        registerState
      );
      created = true;
      rebuilt = true;
    } else {
      g.__bncrBridge.bindApi?.(api);
      assignBridgeOwner(g.__bncrBridge, owner);
      created = false;
      rebuilt = false;
    }
  } else {
    g.__bncrBridge = assignBridgeOwner(loaded.createBncrBridge(api), owner);
    created = true;
  }
  return { bridge: g.__bncrBridge, runtime: loaded, created, rebuilt, owner, previousOwner };
};
var getExistingBridgeSingleton = () => {
  const g = globalThis;
  return g.__bncrBridge;
};
var isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var getCurrentBridge = () => {
  const bridge = getGatewayRuntime().currentBridge;
  if (!bridge) throw new Error("bncr current bridge unavailable");
  return bridge;
};
var createDynamicChannelPlugin = (loaded) => {
  const base = loaded.createBncrChannelPlugin(() => getCurrentBridge());
  return {
    ...base,
    outbound: {
      ...base.outbound,
      sendText: (ctx) => getCurrentBridge().channelSendText(ctx),
      sendMedia: (ctx) => getCurrentBridge().channelSendMedia(ctx)
    },
    status: {
      ...base.status,
      buildChannelSummary: async ({ defaultAccountId }) => getCurrentBridge().getChannelSummary(defaultAccountId || "Primary"),
      buildAccountSnapshot: async ({ account, runtime: runtime2 }) => {
        const bridgeNow = getCurrentBridge();
        return base.status.buildAccountSnapshot({
          account,
          runtime: runtime2 || bridgeNow.getAccountRuntimeSnapshot(account?.accountId)
        });
      },
      resolveAccountState: ({ enabled, configured, account, cfg, runtime: runtime2 }) => {
        const bridgeNow = getCurrentBridge();
        return base.status.resolveAccountState({
          enabled,
          configured,
          account,
          cfg,
          runtime: runtime2 || bridgeNow.getAccountRuntimeSnapshot(account?.accountId)
        });
      }
    },
    gateway: {
      ...base.gateway,
      startAccount: (ctx) => getCurrentBridge().channelStartAccount(ctx),
      stopAccount: (ctx) => getCurrentBridge().channelStopAccount(ctx)
    }
  };
};
var registerBncrCli = (api) => {
  if (typeof api.registerCli !== "function") return;
  api.registerCli(
    ({ program }) => {
      const bncr = program.command("bncr").description("Bncr channel utilities");
      bncr.command("miniconfig").description(
        "Seed minimal channels.bncr config (adds enabled=true and allowTool=false only when missing)"
      ).action(async () => {
        const cfg = getOpenClawRuntimeConfig(api);
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
};
var shouldSkipNonRuntimeRegister = (mode) => mode === "cli-metadata" || mode === "discovery";
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
    const firstSeenApi = !globalTrace.seenApiInstanceIds.has(apiInstanceId);
    const firstSeenRegistry = !globalTrace.seenRegistryFingerprints.has(registryFingerprint);
    const gatewayRuntime = getGatewayRuntime();
    const ownerDecision = shouldAdoptProcessOwner(apiInstanceId, gatewayRuntime);
    let bridge;
    let runtime2;
    let created = false;
    let rebuilt = false;
    let owner;
    let previousOwner;
    if (ownerDecision.adoptOwner) {
      const adopted = getBridgeSingleton(api);
      bridge = adopted.bridge;
      runtime2 = adopted.runtime;
      created = adopted.created;
      rebuilt = adopted.rebuilt;
      owner = adopted.owner;
      previousOwner = adopted.previousOwner;
      gatewayRuntime.currentBridge = bridge;
    } else {
      runtime2 = loadRuntimeSync();
      bridge = gatewayRuntime.currentBridge || getExistingBridgeSingleton();
      previousOwner = getExistingBridgeSingleton()?.[BNCR_BRIDGE_OWNER];
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
      source: "~/.openclaw/workspace/plugins/bncr/index.ts",
      pluginVersion,
      apiRebound: ownerDecision.adoptOwner ? !created && !rebuilt : false,
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
      `register classify mode=${meta.registrationMode || "unknown"} api=${apiInstanceId} registry=${registryFingerprint} sameApiAsPrevious=${sameApiAsPrevious} sameRegistryAsPrevious=${sameRegistryAsPrevious} firstSeenApi=${firstSeenApi} firstSeenRegistry=${firstSeenRegistry}`
    );
    debugLog(
      `register owner adopt=${ownerDecision.adoptOwner} reason=${ownerDecision.reason} existingOwnerApi=${ownerDecision.existingOwnerApiInstanceId || "none"}`
    );
    if (!ownerDecision.adoptOwner) {
      debugLog(
        `bridge rebuild suppressed due to existing singleton owner api ${ownerDecision.existingOwnerApiInstanceId || "unknown"}`
      );
    } else {
      if (!created && !rebuilt) debugLog("bridge api rebound");
      if (rebuilt) debugLog("bridge rebuilt due to owner/runtime change");
    }
    const resolveDebug = async () => {
      try {
        const cfg = getOpenClawRuntimeConfig(api);
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
        id: "bncr-bridge-service",
        start: async (ctx) => {
          const debug = await resolveDebug();
          await getCurrentBridge().startService(ctx, debug);
        },
        stop: serviceStopHandler
      });
      activeServiceStop = serviceStopHandler;
      gatewayRuntime.serviceRegistered = true;
      gatewayRuntime.serviceOwnerApiInstanceId = apiInstanceId;
      meta.service = true;
      debugLog(`register service ok ownerApi=${apiInstanceId}`);
    } else {
      meta.service = true;
      debugLog(
        `register service skip (process singleton already registered by api ${gatewayRuntime.serviceOwnerApiInstanceId || "unknown"})`
      );
    }
    if (!gatewayRuntime.channelRegistered) {
      api.registerChannel({ plugin: createDynamicChannelPlugin(runtime2) });
      gatewayRuntime.channelRegistered = true;
      gatewayRuntime.channelOwnerApiInstanceId = apiInstanceId;
      meta.channel = true;
      debugLog(`register channel ok ownerApi=${apiInstanceId}`);
    } else {
      meta.channel = true;
      debugLog(
        `register channel skip (process singleton already registered by api ${gatewayRuntime.channelOwnerApiInstanceId || "unknown"})`
      );
    }
    ensureGatewayMethodRegistered(api, "bncr.connect", debugLog);
    ensureGatewayMethodRegistered(api, "bncr.inbound", debugLog);
    ensureGatewayMethodRegistered(api, "bncr.activity", debugLog);
    ensureGatewayMethodRegistered(api, "bncr.ack", debugLog);
    ensureGatewayMethodRegistered(api, "bncr.diagnostics", debugLog);
    ensureGatewayMethodRegistered(api, "bncr.file.init", debugLog);
    ensureGatewayMethodRegistered(api, "bncr.file.chunk", debugLog);
    ensureGatewayMethodRegistered(api, "bncr.file.complete", debugLog);
    ensureGatewayMethodRegistered(api, "bncr.file.abort", debugLog);
    ensureGatewayMethodRegistered(api, "bncr.file.ack", debugLog);
    debugLog("register done");
  }
};
var index_default = plugin;
export {
  index_default as default
};
