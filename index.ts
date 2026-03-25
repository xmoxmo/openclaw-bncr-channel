import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BncrConfigSchema } from './src/core/config-schema.ts';

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

let runtime: LoadedRuntime | null = null;

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
    directCandidates
      .map((candidate) => findOpenClawPackageRoot(candidate))
      .filter(Boolean),
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

const getBridgeSingleton = (api: OpenClawPluginApi) => {
  const loaded = loadRuntimeSync();
  const g = globalThis as typeof globalThis & { __bncrBridge?: BridgeSingleton };
  if (!g.__bncrBridge) g.__bncrBridge = loaded.createBncrBridge(api);
  return { bridge: g.__bncrBridge, runtime: loaded };
};

const plugin = {
  id: 'bncr',
  name: 'Bncr',
  description: 'Bncr channel plugin',
  configSchema: BncrConfigSchema,
  register(api: OpenClawPluginApi) {
    const { bridge, runtime } = getBridgeSingleton(api);
    const debugLog = (...args: any[]) => {
      if (!bridge.isDebugEnabled?.()) return;
      api.logger.info?.(...args);
    };

    debugLog(`bncr plugin register bridge=${(bridge as any)?.bridgeId || 'unknown'}`);

    const resolveDebug = async () => {
      try {
        const cfg = await api.runtime.config.loadConfig();
        return Boolean((cfg as any)?.channels?.bncr?.debug?.verbose);
      } catch {
        return false;
      }
    };

    api.registerService({
      id: 'bncr-bridge-service',
      start: async (ctx) => {
        const debug = await resolveDebug();
        await bridge.startService(ctx, debug);
      },
      stop: bridge.stopService,
    });

    api.registerChannel({ plugin: runtime.createBncrChannelPlugin(bridge) });

    api.registerGatewayMethod('bncr.connect', (opts) => bridge.handleConnect(opts));
    api.registerGatewayMethod('bncr.inbound', (opts) => bridge.handleInbound(opts));
    api.registerGatewayMethod('bncr.activity', (opts) => bridge.handleActivity(opts));
    api.registerGatewayMethod('bncr.ack', (opts) => bridge.handleAck(opts));
    api.registerGatewayMethod('bncr.diagnostics', (opts) => bridge.handleDiagnostics(opts));
    api.registerGatewayMethod('bncr.file.init', (opts) => bridge.handleFileInit(opts));
    api.registerGatewayMethod('bncr.file.chunk', (opts) => bridge.handleFileChunk(opts));
    api.registerGatewayMethod('bncr.file.complete', (opts) => bridge.handleFileComplete(opts));
    api.registerGatewayMethod('bncr.file.abort', (opts) => bridge.handleFileAbort(opts));
    api.registerGatewayMethod('bncr.file.ack', (opts) => bridge.handleFileAck(opts));
  },
};

export default plugin;
