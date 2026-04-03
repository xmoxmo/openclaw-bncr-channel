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

type LoadedRuntime = {
  createBncrBridge: ChannelModule['createBncrBridge'];
  createBncrChannelPlugin: ChannelModule['createBncrChannelPlugin'];
};

const BNCR_REGISTER_META = Symbol.for('bncr.register.meta');

type RegisterMeta = {
  service?: boolean;
  channel?: boolean;
  methods?: Set<string>;
  apiInstanceId?: string;
  registryFingerprint?: string;
};

type OpenClawPluginApiWithMeta = OpenClawPluginApi & {
  [BNCR_REGISTER_META]?: RegisterMeta;
};

let runtime: LoadedRuntime | null = null;
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
  const next = `${prefix}_${++identitySeq}`;
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

const ensureGatewayMethodRegistered = (
  api: OpenClawPluginApi,
  name: string,
  handler: (opts: any) => any,
  debugLog: (...args: any[]) => void,
) => {
  const meta = getRegisterMeta(api);
  if (meta.methods?.has(name)) {
    debugLog(`register method skip ${name} (already registered on this api)`);
    return;
  }
  api.registerGatewayMethod(name, handler);
  meta.methods?.add(name);
  debugLog(`register method ok ${name}`);
};

const getBridgeSingleton = (api: OpenClawPluginApi) => {
  const loaded = loadRuntimeSync();
  const g = globalThis as typeof globalThis & { __bncrBridge?: BridgeSingleton };
  let created = false;
  if (!g.__bncrBridge) {
    g.__bncrBridge = loaded.createBncrBridge(api);
    created = true;
  } else {
    g.__bncrBridge.bindApi?.(api);
  }
  return { bridge: g.__bncrBridge, runtime: loaded, created };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
          const cfg = (await api.runtime.config.loadConfig()) as Record<string, unknown>;
          if (!isPlainObject(cfg.channels)) cfg.channels = {};

          const existing = isPlainObject(cfg.channels.bncr) ? cfg.channels.bncr : {};
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

          cfg.channels.bncr = bncrCfg;

          if (added.length === 0) {
            console.log('Minimal bncr config already present. No changes made.');
            return;
          }

          await api.runtime.config.writeConfigFile(cfg);
          console.log('Seeded minimal bncr config at channels.bncr.');
          console.log(`Added missing fields: ${added.join(', ')}`);
          console.log('Restart the gateway to apply changes.');
        });
    },
    { commands: ['bncr'] },
  );
};

const plugin = {
  id: 'bncr',
  name: 'Bncr',
  description: 'Bncr channel plugin',
  configSchema: BncrConfigSchema,
  register(
    api: OpenClawPluginApi & { registerCli?: (...args: any[]) => void; registrationMode?: string },
  ) {
    registerBncrCli(api);
    if (api.registrationMode === 'cli-metadata') return;

    const meta = getRegisterMeta(api);
    const { bridge, runtime, created } = getBridgeSingleton(api);
    bridge.noteRegister?.({
      source: '~/.openclaw/workspace/plugins/bncr/index.ts',
      pluginVersion,
      apiRebound: !created,
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
        Boolean(bridge.isDebugEnabled?.()),
      );
    };

    debugLog(`register begin bridge=${bridge.getBridgeId?.() || 'unknown'} created=${created}`);
    if (!created) debugLog('bridge api rebound');

    const resolveDebug = async () => {
      try {
        const cfg = await api.runtime.config.loadConfig();
        return Boolean((cfg as any)?.channels?.bncr?.debug?.verbose);
      } catch {
        return false;
      }
    };

    if (!meta.service) {
      api.registerService({
        id: 'bncr-bridge-service',
        start: async (ctx) => {
          const debug = await resolveDebug();
          await bridge.startService(ctx, debug);
        },
        stop: bridge.stopService,
      });
      meta.service = true;
      debugLog('register service ok');
    } else {
      debugLog('register service skip (already registered on this api)');
    }

    if (!meta.channel) {
      api.registerChannel({ plugin: runtime.createBncrChannelPlugin(bridge) });
      meta.channel = true;
      debugLog('register channel ok');
    } else {
      debugLog('register channel skip (already registered on this api)');
    }

    ensureGatewayMethodRegistered(
      api,
      'bncr.connect',
      (opts) => bridge.handleConnect(opts),
      debugLog,
    );
    ensureGatewayMethodRegistered(
      api,
      'bncr.inbound',
      (opts) => bridge.handleInbound(opts),
      debugLog,
    );
    ensureGatewayMethodRegistered(
      api,
      'bncr.activity',
      (opts) => bridge.handleActivity(opts),
      debugLog,
    );
    ensureGatewayMethodRegistered(api, 'bncr.ack', (opts) => bridge.handleAck(opts), debugLog);
    ensureGatewayMethodRegistered(
      api,
      'bncr.diagnostics',
      (opts) => bridge.handleDiagnostics(opts),
      debugLog,
    );
    ensureGatewayMethodRegistered(
      api,
      'bncr.file.init',
      (opts) => bridge.handleFileInit(opts),
      debugLog,
    );
    ensureGatewayMethodRegistered(
      api,
      'bncr.file.chunk',
      (opts) => bridge.handleFileChunk(opts),
      debugLog,
    );
    ensureGatewayMethodRegistered(
      api,
      'bncr.file.complete',
      (opts) => bridge.handleFileComplete(opts),
      debugLog,
    );
    ensureGatewayMethodRegistered(
      api,
      'bncr.file.abort',
      (opts) => bridge.handleFileAbort(opts),
      debugLog,
    );
    ensureGatewayMethodRegistered(
      api,
      'bncr.file.ack',
      (opts) => bridge.handleFileAck(opts),
      debugLog,
    );
    debugLog('register done');
  },
};

export default plugin;
