import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BncrConfigSchema } from './src/core/config-schema.ts';
import { emitBncrLogLine } from './src/core/logging.ts';

const pluginFile = fileURLToPath(import.meta.url);
const pluginDir = path.dirname(pluginFile);
const pluginRequire = createRequire(import.meta.url);
const sdkCoreSpecifier = 'openclaw/plugin-sdk/core';
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

type ChannelModule = typeof import('./src/channel.ts');
type OpenClawPluginApi = Parameters<ChannelModule['createBncrBridge']>[0];
type BridgeSingleton = ReturnType<ChannelModule['createBncrBridge']>;
type ChannelPlugin = ReturnType<ChannelModule['createBncrChannelPlugin']>;

type LoadedRuntime = {
  createBncrBridge: ChannelModule['createBncrBridge'];
  createBncrChannelPlugin: ChannelModule['createBncrChannelPlugin'];
};

const BNCR_REGISTER_META = Symbol.for('bncr.register.meta');
const BNCR_GLOBAL_REGISTER_TRACE = Symbol.for('bncr.global.register.trace');
const BNCR_BRIDGE_OWNER = Symbol.for('bncr.bridge.owner');
const BNCR_GATEWAY_RUNTIME = Symbol.for('bncr.gateway.runtime');
const MODULE_EPOCH = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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

type BridgeOwner = {
  moduleEpoch: string;
  bridgeFactoryId: string;
  apiInstanceId: string;
  registryFingerprint: string;
  registrationMode?: string;
};

type BridgeRegisterStateSnapshot = {
  registerCount: number;
  apiGeneration: number;
  firstRegisterAt: number | null;
  lastRegisterAt: number | null;
  lastApiRebindAt: number | null;
  pluginSource: string | null;
  pluginVersion: string | null;
  lastApiInstanceId: string | null;
  lastRegistryFingerprint: string | null;
  lastDriftSnapshot: unknown;
  registerTraceRecent: Array<Record<string, unknown>>;
};

type GatewayMethodName =
  | 'bncr.connect'
  | 'bncr.inbound'
  | 'bncr.activity'
  | 'bncr.ack'
  | 'bncr.diagnostics'
  | 'bncr.file.init'
  | 'bncr.file.chunk'
  | 'bncr.file.complete'
  | 'bncr.file.abort'
  | 'bncr.file.ack';

type BridgeSingletonWithOwner = BridgeSingleton & {
  [BNCR_BRIDGE_OWNER]?: BridgeOwner;
  registerCount?: number;
  apiGeneration?: number;
  firstRegisterAt?: number | null;
  lastRegisterAt?: number | null;
  lastApiRebindAt?: number | null;
  pluginSource?: string | null;
  pluginVersion?: string | null;
  lastApiInstanceId?: string | null;
  lastRegistryFingerprint?: string | null;
  lastDriftSnapshot?: unknown;
  registerTraceRecent?: Array<Record<string, unknown>>;
};

type OpenClawPluginApiWithMeta = OpenClawPluginApi & {
  [BNCR_REGISTER_META]?: RegisterMeta;
};

type BncrGatewayRuntime = {
  currentBridge?: BridgeSingletonWithOwner;
  registeredMethodsByRegistry: Map<string, Set<GatewayMethodName>>;
  serviceRegistered?: boolean;
  channelRegistered?: boolean;
  serviceOwnerApiInstanceId?: string;
  channelOwnerApiInstanceId?: string;
};

let runtime: LoadedRuntime | null = null;
let activeServiceStop: (() => Promise<void>) | null = null;
const identityIds = new WeakMap<object, string>();
let identitySeq = 0;

const tryExec = (command: string, args: string[]) => {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};

const readOpenClawPackageName = (pkgPath: string) => {
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.name === 'string' ? parsed.name : '';
  } catch {
    return '';
  }
};

const readPluginVersion = () => {
  try {
    const raw = fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
};

const pluginVersion = readPluginVersion();

const findOpenClawPackageRoot = (startPath: string) => {
  let current = startPath;
  try {
    current = fs.realpathSync(startPath);
  } catch {
    // keep original path when realpath fails
  }

  let cursor = current;
  while (true) {
    const statPath = fs.existsSync(cursor) ? cursor : path.dirname(cursor);
    const pkgPath = path.join(statPath, 'package.json');
    if (fs.existsSync(pkgPath) && readOpenClawPackageName(pkgPath) === 'openclaw') {
      return statPath;
    }
    const parent = path.dirname(statPath);
    if (parent === statPath) break;
    cursor = parent;
  }
  return '';
};

const unique = (items: string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item) continue;
    const normalized = path.normalize(item);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const collectOpenClawCandidates = () => {
  const directCandidates = [
    path.join(pluginDir, 'node_modules', 'openclaw'),
    path.join('/usr/lib/node_modules', 'openclaw'),
    path.join('/usr/local/lib/node_modules', 'openclaw'),
    path.join('/opt/homebrew/lib/node_modules', 'openclaw'),
    path.join(process.env.HOME || '', '.npm-global/lib/node_modules', 'openclaw'),
  ];

  const npmRoot = tryExec('npm', ['root', '-g']);
  if (npmRoot) directCandidates.push(path.join(npmRoot, 'openclaw'));

  const nodePathEntries = (process.env.NODE_PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of nodePathEntries) {
    directCandidates.push(path.join(entry, 'openclaw'));
  }

  const openclawBin = tryExec('which', ['openclaw']);
  if (openclawBin) {
    directCandidates.push(openclawBin);
    directCandidates.push(path.dirname(openclawBin));
  }

  const packageRoots = unique(
    directCandidates.map((candidate) => findOpenClawPackageRoot(candidate)).filter(Boolean),
  );

  return packageRoots.filter((candidate) => {
    const pkgJson = path.join(candidate, 'package.json');
    return fs.existsSync(pkgJson) && readOpenClawPackageName(pkgJson) === 'openclaw';
  });
};

const canResolveSdkCore = () => {
  try {
    pluginRequire.resolve(sdkCoreSpecifier);
    return true;
  } catch {
    return false;
  }
};

const ensurePluginNodeModulesLink = (targetRoot: string) => {
  const nodeModulesDir = path.join(pluginDir, 'node_modules');
  const linkPath = path.join(nodeModulesDir, 'openclaw');
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
    // missing link is fine
  }

  fs.symlinkSync(targetRoot, linkPath, linkType as fs.symlink.Type);
};

const ensureOpenClawSdkResolution = () => {
  if (canResolveSdkCore()) return;

  let lastError = '';
  const candidates = collectOpenClawCandidates();
  for (const candidate of candidates) {
    try {
      ensurePluginNodeModulesLink(candidate);
      if (canResolveSdkCore()) return;
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }

  const suffix = candidates.length
    ? ` Tried candidates: ${candidates.join(', ')}.`
    : ' No openclaw package root candidates were found from npm root, NODE_PATH, common global paths, or the openclaw binary path.';
  const extra = lastError ? ` Last repair error: ${lastError}.` : '';
  throw new Error(
    `bncr failed to resolve ${sdkCoreSpecifier} from ${pluginDir}.${suffix}${extra} ` +
      `You can repair manually with: mkdir -p ${path.join(pluginDir, 'node_modules')} && ln -s "$(npm root -g)/openclaw" ${path.join(pluginDir, 'node_modules', 'openclaw')}`,
  );
};

const loadRuntimeSync = (): LoadedRuntime => {
  if (runtime) return runtime;
  ensureOpenClawSdkResolution();
  try {
    const mod = pluginRequire('./src/channel.ts') as ChannelModule;
    runtime = {
      createBncrBridge: mod.createBncrBridge,
      createBncrChannelPlugin: mod.createBncrChannelPlugin,
    };
    return runtime;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`bncr failed to load channel runtime after dependency bootstrap: ${detail}`);
  }
};

const getIdentityId = (obj: object, prefix: string) => {
  const existing = identityIds.get(obj);
  if (existing) return existing;
  const next = `${prefix}_${MODULE_EPOCH}_${++identitySeq}`;
  identityIds.set(obj, next);
  return next;
};

const getRegistryFingerprint = (api: OpenClawPluginApi) => {
  const serviceId = getIdentityId(api.registerService as object, 'svc');
  const channelId = getIdentityId(api.registerChannel as object, 'chn');
  const methodId = getIdentityId(api.registerGatewayMethod as object, 'mth');
  return `${serviceId}:${channelId}:${methodId}`;
};

const getRegisterMeta = (api: OpenClawPluginApi): RegisterMeta => {
  const host = api as OpenClawPluginApiWithMeta;
  if (!host[BNCR_REGISTER_META]) {
    host[BNCR_REGISTER_META] = { methods: new Set<string>() };
  }
  if (!host[BNCR_REGISTER_META]!.methods) {
    host[BNCR_REGISTER_META]!.methods = new Set<string>();
  }
  if (!host[BNCR_REGISTER_META]!.apiInstanceId) {
    host[BNCR_REGISTER_META]!.apiInstanceId = getIdentityId(api as object, 'api');
  }
  if (!host[BNCR_REGISTER_META]!.registryFingerprint) {
    host[BNCR_REGISTER_META]!.registryFingerprint = getRegistryFingerprint(api);
  }
  return host[BNCR_REGISTER_META]!;
};

const getProcessStore = () => {
  const p = process as NodeJS.Process & {
    [BNCR_GLOBAL_REGISTER_TRACE]?: GlobalRegisterTrace;
    [BNCR_GATEWAY_RUNTIME]?: BncrGatewayRuntime;
  };
  return p;
};

const getGlobalRegisterTrace = () => {
  const p = getProcessStore();
  if (!p[BNCR_GLOBAL_REGISTER_TRACE]) {
    p[BNCR_GLOBAL_REGISTER_TRACE] = {
      seenRegistryFingerprints: new Set<string>(),
      seenApiInstanceIds: new Set<string>(),
    };
  }
  return p[BNCR_GLOBAL_REGISTER_TRACE]!;
};

const getGatewayRuntime = (): BncrGatewayRuntime => {
  const p = getProcessStore();
  if (!p[BNCR_GATEWAY_RUNTIME]) {
    p[BNCR_GATEWAY_RUNTIME] = {
      registeredMethodsByRegistry: new Map<string, Set<GatewayMethodName>>(),
      serviceRegistered: false,
      channelRegistered: false,
    };
  }
  return p[BNCR_GATEWAY_RUNTIME]!;
};

const getProcessOwnerApiInstanceId = (gatewayRuntime: BncrGatewayRuntime) =>
  gatewayRuntime.serviceOwnerApiInstanceId ||
  gatewayRuntime.channelOwnerApiInstanceId ||
  undefined;

const shouldAdoptProcessOwner = (
  apiInstanceId: string,
  gatewayRuntime: BncrGatewayRuntime,
) => {
  const existingOwnerApiInstanceId = getProcessOwnerApiInstanceId(gatewayRuntime);
  const hasSingletonOwner =
    Boolean(gatewayRuntime.serviceRegistered) || Boolean(gatewayRuntime.channelRegistered);

  if (!hasSingletonOwner) {
    return {
      adoptOwner: true,
      existingOwnerApiInstanceId,
      reason: 'no-singleton-owner',
    };
  }

  if (existingOwnerApiInstanceId && existingOwnerApiInstanceId === apiInstanceId) {
    return {
      adoptOwner: true,
      existingOwnerApiInstanceId,
      reason: 'same-owner-api',
    };
  }

  return {
    adoptOwner: false,
    existingOwnerApiInstanceId,
    reason: 'singleton-owned-by-other-api',
  };
};

const gatewayMethodDispatchers: Record<
  GatewayMethodName,
  (bridge: BridgeSingletonWithOwner, opts: any) => any
> = {
  'bncr.connect': (bridge, opts) => bridge.handleConnect(opts),
  'bncr.inbound': (bridge, opts) => bridge.handleInbound(opts),
  'bncr.activity': (bridge, opts) => bridge.handleActivity(opts),
  'bncr.ack': (bridge, opts) => bridge.handleAck(opts),
  'bncr.diagnostics': (bridge, opts) => bridge.handleDiagnostics(opts),
  'bncr.file.init': (bridge, opts) => bridge.handleFileInit(opts),
  'bncr.file.chunk': (bridge, opts) => bridge.handleFileChunk(opts),
  'bncr.file.complete': (bridge, opts) => bridge.handleFileComplete(opts),
  'bncr.file.abort': (bridge, opts) => bridge.handleFileAbort(opts),
  'bncr.file.ack': (bridge, opts) => bridge.handleFileAck(opts),
};

const dispatchGatewayMethod = (name: GatewayMethodName, opts: any) => {
  const gatewayRuntime = getGatewayRuntime();
  const bridge = gatewayRuntime.currentBridge;
  if (!bridge) {
    throw new Error(`bncr gateway runtime unavailable for ${name}`);
  }
  return gatewayMethodDispatchers[name](bridge, opts);
};

const mirrorGatewayMethodForMockApi = (api: OpenClawPluginApi, name: GatewayMethodName) => {
  const host = api as OpenClawPluginApi & {
    methods?: Array<{ name: string; handler: (opts: any) => any }>;
  };
  if (!Array.isArray(host.methods)) return;
  if (host.methods.some((item) => item?.name === name)) return;
  host.methods.push({ name, handler: (opts) => dispatchGatewayMethod(name, opts) });
};

const ensureGatewayMethodRegistered = (
  api: OpenClawPluginApi,
  name: GatewayMethodName,
  debugLog: (...args: any[]) => void,
) => {
  const meta = getRegisterMeta(api);
  const gatewayRuntime = getGatewayRuntime();
  const registryFingerprint = meta.registryFingerprint || getRegistryFingerprint(api);
  let registryMethods = gatewayRuntime.registeredMethodsByRegistry.get(registryFingerprint);
  if (!registryMethods) {
    registryMethods = new Set<GatewayMethodName>();
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

const getBridgeOwner = (api: OpenClawPluginApi, loaded: LoadedRuntime): BridgeOwner => {
  const meta = getRegisterMeta(api);
  return {
    moduleEpoch: MODULE_EPOCH,
    bridgeFactoryId: getIdentityId(loaded.createBncrBridge as object, 'bridgeFactory'),
    apiInstanceId: meta.apiInstanceId || 'unknown',
    registryFingerprint: meta.registryFingerprint || 'unknown',
    registrationMode: meta.registrationMode,
  };
};

const sameBridgeOwner = (left?: BridgeOwner, right?: BridgeOwner) => {
  if (!left || !right) return false;
  return (
    left.moduleEpoch === right.moduleEpoch &&
    left.bridgeFactoryId === right.bridgeFactoryId &&
    left.apiInstanceId === right.apiInstanceId &&
    left.registryFingerprint === right.registryFingerprint
  );
};

const snapshotBridgeRegisterState = (
  bridge?: BridgeSingletonWithOwner,
): BridgeRegisterStateSnapshot | null => {
  if (!bridge) return null;
  return {
    registerCount: Number(bridge.registerCount || 0),
    apiGeneration: Number(bridge.apiGeneration || 0),
    firstRegisterAt:
      typeof bridge.firstRegisterAt === 'number'
        ? bridge.firstRegisterAt
        : (bridge.firstRegisterAt ?? null),
    lastRegisterAt:
      typeof bridge.lastRegisterAt === 'number'
        ? bridge.lastRegisterAt
        : (bridge.lastRegisterAt ?? null),
    lastApiRebindAt:
      typeof bridge.lastApiRebindAt === 'number'
        ? bridge.lastApiRebindAt
        : (bridge.lastApiRebindAt ?? null),
    pluginSource: typeof bridge.pluginSource === 'string' ? bridge.pluginSource : null,
    pluginVersion: typeof bridge.pluginVersion === 'string' ? bridge.pluginVersion : null,
    lastApiInstanceId:
      typeof bridge.lastApiInstanceId === 'string' ? bridge.lastApiInstanceId : null,
    lastRegistryFingerprint:
      typeof bridge.lastRegistryFingerprint === 'string' ? bridge.lastRegistryFingerprint : null,
    lastDriftSnapshot: bridge.lastDriftSnapshot ?? null,
    registerTraceRecent: Array.isArray(bridge.registerTraceRecent)
      ? bridge.registerTraceRecent.map((trace) => ({ ...trace }))
      : [],
  };
};

const hydrateBridgeRegisterState = (
  bridge: BridgeSingletonWithOwner,
  snapshot: BridgeRegisterStateSnapshot | null,
) => {
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

const assignBridgeOwner = (bridge: BridgeSingleton, owner: BridgeOwner) => {
  (bridge as BridgeSingletonWithOwner)[BNCR_BRIDGE_OWNER] = owner;
  return bridge as BridgeSingletonWithOwner;
};

const getBridgeSingleton = (api: OpenClawPluginApi) => {
  const loaded = loadRuntimeSync();
  const g = globalThis as typeof globalThis & { __bncrBridge?: BridgeSingletonWithOwner };
  const owner = getBridgeOwner(api, loaded);
  const previousOwner = g.__bncrBridge?.[BNCR_BRIDGE_OWNER];

  let created = false;
  let rebuilt = false;

  if (g.__bncrBridge) {
    const mustRebuild =
      !sameBridgeOwner(previousOwner, owner) &&
      (previousOwner?.moduleEpoch !== owner.moduleEpoch ||
        previousOwner?.bridgeFactoryId !== owner.bridgeFactoryId ||
        previousOwner?.registrationMode !== owner.registrationMode ||
        previousOwner?.apiInstanceId !== owner.apiInstanceId ||
        previousOwner?.registryFingerprint !== owner.registryFingerprint);

    if (mustRebuild) {
      const registerState = snapshotBridgeRegisterState(g.__bncrBridge);
      try {
        g.__bncrBridge.stopService?.();
      } catch {
        // ignore stop errors during hot-restart recovery
      }
      g.__bncrBridge = hydrateBridgeRegisterState(
        assignBridgeOwner(loaded.createBncrBridge(api), owner),
        registerState,
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

const getExistingBridgeSingleton = (): BridgeSingletonWithOwner | undefined => {
  const g = globalThis as typeof globalThis & { __bncrBridge?: BridgeSingletonWithOwner };
  return g.__bncrBridge;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getCurrentBridge = (): BridgeSingletonWithOwner => {
  const bridge = getGatewayRuntime().currentBridge;
  if (!bridge) throw new Error('bncr current bridge unavailable');
  return bridge;
};

const createDynamicChannelPlugin = (loaded: LoadedRuntime): ChannelPlugin => {
  const base = loaded.createBncrChannelPlugin(() => getCurrentBridge());

  return {
    ...base,
    outbound: {
      ...base.outbound,
      sendText: (ctx: any) => getCurrentBridge().channelSendText(ctx),
      sendMedia: (ctx: any) => getCurrentBridge().channelSendMedia(ctx),
    },
    status: {
      ...base.status,
      buildChannelSummary: async ({ defaultAccountId }: any) =>
        getCurrentBridge().getChannelSummary(defaultAccountId || 'Primary'),
      buildAccountSnapshot: async ({ account, runtime }: any) => {
        const bridgeNow = getCurrentBridge();
        return base.status.buildAccountSnapshot({
          account,
          runtime: runtime || bridgeNow.getAccountRuntimeSnapshot(account?.accountId),
        });
      },
      resolveAccountState: ({ enabled, configured, account, cfg, runtime }: any) => {
        const bridgeNow = getCurrentBridge();
        return base.status.resolveAccountState({
          enabled,
          configured,
          account,
          cfg,
          runtime: runtime || bridgeNow.getAccountRuntimeSnapshot(account?.accountId),
        });
      },
    },
    gateway: {
      ...base.gateway,
      startAccount: (ctx: any) => getCurrentBridge().channelStartAccount(ctx),
      stopAccount: (ctx: any) => getCurrentBridge().channelStopAccount(ctx),
    },
  };
};

const registerBncrCli = (api: OpenClawPluginApi & { registerCli?: (...args: any[]) => void }) => {
  if (typeof api.registerCli !== 'function') return;
  api.registerCli(
    ({ program }: any) => {
      const bncr = program.command('bncr').description('Bncr channel utilities');
      bncr
        .command('miniconfig')
        .description(
          'Seed minimal channels.bncr config (adds enabled=true and allowTool=false only when missing)',
        )
        .action(async () => {
          const cfg = api.runtime.config.current() as Record<string, unknown>;
          const next = structuredClone(cfg);
          if (!isPlainObject(next.channels)) next.channels = {};

          const existing = isPlainObject(next.channels.bncr) ? next.channels.bncr : {};
          const bncrCfg: Record<string, unknown> = { ...existing };
          const added: string[] = [];

          if (bncrCfg.enabled === undefined) {
            bncrCfg.enabled = true;
            added.push('enabled=true');
          }

          if (bncrCfg.allowTool === undefined) {
            bncrCfg.allowTool = false;
            added.push('allowTool=false');
          }

          next.channels.bncr = bncrCfg;

          if (added.length === 0) {
            console.log('Minimal bncr config already present. No changes made.');
            return;
          }

          await api.runtime.config.writeConfigFile(next);
          console.log('Seeded minimal bncr config at channels.bncr.');
          console.log(`Added missing fields: ${added.join(', ')}`);
          console.log('Restart the gateway to apply changes.');
        });
    },
    { commands: ['bncr'] },
  );
};

const shouldSkipNonRuntimeRegister = (mode?: string) =>
  mode === 'cli-metadata' || mode === 'discovery';

const plugin = {
  id: 'bncr',
  name: 'Bncr',
  description: 'Bncr channel plugin',
  configSchema: BncrConfigSchema,
  register(
    api: OpenClawPluginApi & { registerCli?: (...args: any[]) => void; registrationMode?: string },
  ) {
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
    } else {
      runtime = loadRuntimeSync();
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
      source: '~/.openclaw/workspace/plugins/bncr/index.ts',
      pluginVersion,
      apiRebound: ownerDecision.adoptOwner ? !created && !rebuilt : false,
      apiInstanceId: meta.apiInstanceId,
      registryFingerprint: meta.registryFingerprint,
    });
    const debugLog = (...args: any[]) => {
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
        const cfg = api.runtime.config.current();
        return Boolean((cfg as any)?.channels?.bncr?.debug?.verbose);
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
      activeServiceStop = serviceStopHandler;
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
      api.registerChannel({ plugin: createDynamicChannelPlugin(runtime) });
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
    ensureGatewayMethodRegistered(api, 'bncr.file.init', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.file.chunk', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.file.complete', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.file.abort', debugLog);
    ensureGatewayMethodRegistered(api, 'bncr.file.ack', debugLog);
    debugLog('register done');
  },
};

export default plugin;
