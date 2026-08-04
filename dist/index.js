// src/bootstrap/channel-plugin-runtime.ts
function createDynamicChannelPlugin(args) {
  const { loaded, getCurrentBridge: getCurrentBridge2 } = args;
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
    startAccount: (ctx) => getCurrentBridge2().channelStartAccount(
      ctx
    ),
    stopAccount: (ctx) => getCurrentBridge2().channelStopAccount(
      ctx
    )
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

// src/bootstrap/register-runtime-gateway.ts
function createBncrGatewayMethodRegistry(runtime2) {
  const dispatchGatewayMethod = (name, opts) => {
    const gatewayRuntime = runtime2.getGatewayRuntime();
    const bridge = gatewayRuntime.currentBridge;
    if (!bridge) {
      throw new Error(`bncr gateway runtime unavailable for ${name}`);
    }
    try {
      return runtime2.gatewayMethodDispatchers[name](bridge, opts);
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
    api.methods.push({ name, handler: (opts) => dispatchGatewayMethod(name, opts) });
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
      (opts) => dispatchGatewayMethod(name, opts)
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

// src/bootstrap/register-runtime-helpers.ts
function getProcessOwnerApiInstanceId(args) {
  return args.serviceOwnerApiInstanceId || args.channelOwnerApiInstanceId || void 0;
}
function sameBridgeOwner(left, right) {
  if (!left || !right) return false;
  return left.moduleEpoch === right.moduleEpoch && left.bridgeFactoryId === right.bridgeFactoryId && left.apiInstanceId === right.apiInstanceId && left.registryFingerprint === right.registryFingerprint;
}
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
function shouldAdoptProcessOwner(args) {
  const existingOwnerApiInstanceId = getProcessOwnerApiInstanceId({
    serviceOwnerApiInstanceId: args.serviceOwnerApiInstanceId,
    channelOwnerApiInstanceId: args.channelOwnerApiInstanceId
  });
  const hasSingletonOwner = Boolean(args.serviceRegistered) || Boolean(args.channelRegistered);
  if (!hasSingletonOwner) {
    return {
      adoptOwner: true,
      existingOwnerApiInstanceId,
      reason: "no-singleton-owner"
    };
  }
  if (existingOwnerApiInstanceId && existingOwnerApiInstanceId === args.apiInstanceId) {
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
  const getBridgeSingleton2 = (api) => {
    const loaded = runtime2.loadBncrRuntimeSync();
    const g = globalThis;
    const owner = runtime2.getBridgeOwner(api, loaded);
    const previousOwnerRaw = g.__bncrBridge ? getBridgeOwnedCarrier(g.__bncrBridge)[runtime2.bridgeOwnerSymbol] : void 0;
    const previousOwner = isBridgeOwner(previousOwnerRaw) ? previousOwnerRaw : void 0;
    let created = false;
    let rebuilt = false;
    if (g.__bncrBridge) {
      const mustRebuild = !sameBridgeOwner(previousOwner, owner) && (previousOwner?.moduleEpoch !== owner.moduleEpoch || previousOwner?.bridgeFactoryId !== owner.bridgeFactoryId || previousOwner?.registrationMode !== owner.registrationMode || previousOwner?.apiInstanceId !== owner.apiInstanceId || previousOwner?.registryFingerprint !== owner.registryFingerprint);
      if (mustRebuild) {
        const registerState = snapshotBridgeRegisterState(
          getBridgeRegisterStateCarrier(g.__bncrBridge)
        );
        try {
          g.__bncrBridge.stopService?.();
        } catch {
        }
        const rebuiltBridge = assignBridgeOwner(
          loaded.createBncrBridge(api, {
            pluginRoot: runtime2.pluginRoot,
            pluginFile: runtime2.pluginFile
          }),
          owner
        );
        hydrateBridgeRegisterState(getBridgeRegisterStateCarrier(rebuiltBridge), registerState);
        g.__bncrBridge = rebuiltBridge;
        created = true;
        rebuilt = true;
      } else {
        g.__bncrBridge.bindApi?.(api);
        assignBridgeOwner(g.__bncrBridge, owner);
      }
    } else {
      g.__bncrBridge = assignBridgeOwner(
        loaded.createBncrBridge(api, {
          pluginRoot: runtime2.pluginRoot,
          pluginFile: runtime2.pluginFile
        }),
        owner
      );
      created = true;
    }
    g.__bncrBridge?.bindRuntimePaths?.({
      pluginRoot: runtime2.pluginRoot,
      pluginFile: runtime2.pluginFile
    });
    return { bridge: g.__bncrBridge, runtime: loaded, created, rebuilt, owner, previousOwner };
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
    getBridgeRegisterStateCarrier,
    getBridgeSingleton: getBridgeSingleton2,
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
        serviceRegistered: false,
        channelRegistered: false
      };
    }
    return p[gatewayRuntimeSymbol];
  };
  const getBridgeRegisterStateCarrier2 = (bridge) => bridge;
  const gatewayMethodRegistry = createBncrGatewayMethodRegistry({
    getRegisterMeta: getRegisterMeta2,
    getRegistryFingerprint,
    getGatewayRuntime: getGatewayRuntime2,
    gatewayMethodDispatchers,
    getBridgeRegisterStateCarrier: getBridgeRegisterStateCarrier2
  });
  const getBridgeOwner = (api, loaded) => {
    const meta = getRegisterMeta2(api);
    return {
      moduleEpoch,
      bridgeFactoryId: getIdentityId(loaded.createBncrBridge, "bridgeFactory"),
      apiInstanceId: meta.apiInstanceId || "unknown",
      registryFingerprint: meta.registryFingerprint || "unknown",
      registrationMode: meta.registrationMode
    };
  };
  const bridgeSingletonManager = createBncrBridgeSingletonManager({
    bridgeOwnerSymbol,
    pluginRoot,
    pluginFile,
    loadBncrRuntimeSync,
    getBridgeOwner
  });
  const getCurrentBridge2 = () => {
    const bridge = getGatewayRuntime2().currentBridge;
    if (!bridge) throw new Error("bncr current bridge unavailable");
    return bridge;
  };
  return {
    getRegisterMeta: getRegisterMeta2,
    getGlobalRegisterTrace: getGlobalRegisterTrace2,
    getGatewayRuntime: getGatewayRuntime2,
    shouldAdoptProcessOwner: (apiInstanceId, gatewayRuntime) => shouldAdoptProcessOwner({
      apiInstanceId,
      serviceRegistered: gatewayRuntime.serviceRegistered,
      channelRegistered: gatewayRuntime.channelRegistered,
      serviceOwnerApiInstanceId: gatewayRuntime.serviceOwnerApiInstanceId,
      channelOwnerApiInstanceId: gatewayRuntime.channelOwnerApiInstanceId
    }),
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
  ensureGatewayMethodRegistered,
  getBridgeSingleton,
  getBridgeOwnerFromBridge,
  getCurrentBridge,
  getExistingBridgeSingleton,
  getGatewayRuntime,
  getGlobalRegisterTrace,
  getRegisterMeta,
  shouldAdoptProcessOwner: shouldAdoptProcessOwner2
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
    const firstSeenApi = !globalTrace.seenApiInstanceIds.has(apiInstanceId);
    const firstSeenRegistry = !globalTrace.seenRegistryFingerprints.has(registryFingerprint);
    const gatewayRuntime = getGatewayRuntime();
    const ownerDecision = shouldAdoptProcessOwner2(apiInstanceId, gatewayRuntime);
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
      if (rebuilt) {
        gatewayRuntime.serviceRegistered = false;
        gatewayRuntime.channelRegistered = false;
        gatewayRuntime.serviceOwnerApiInstanceId = void 0;
        gatewayRuntime.channelOwnerApiInstanceId = void 0;
      }
    } else {
      runtime2 = loadBncrRuntimeSync();
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
      source: "@xmoxmo/bncr",
      pluginVersion: pluginVersion2,
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
      api.registerChannel({
        plugin: createDynamicChannelPlugin({ loaded: runtime2, getCurrentBridge })
      });
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
    ensureGatewayMethodRegistered(api, "bncr.deadLetter.inspect", debugLog);
    ensureGatewayMethodRegistered(api, "bncr.deadLetter.prune", debugLog);
    ensureGatewayMethodRegistered(api, "bncr.rpc.response", debugLog);
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
