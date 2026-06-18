import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureBncrOpenClawSdkResolution,
  resolveBncrPluginRoot,
  resolveBncrRuntimeSourceDir,
} from './runtime-discovery.ts';

export type ChannelModule = typeof import('../channel.ts');

export type LoadedRuntime = {
  createBncrBridge: ChannelModule['createBncrBridge'];
  createBncrChannelPlugin: ChannelModule['createBncrChannelPlugin'];
};

export function resolvePluginEntryFileFromModule(moduleUrl: string) {
  const currentFile = fileURLToPath(moduleUrl);
  const pluginRoot = resolveBncrPluginRoot(currentFile);
  const currentDir = path.dirname(currentFile);
  const distEntry = path.join(pluginRoot, 'dist', 'index.js');
  if (currentFile === distEntry && fs.existsSync(distEntry)) return distEntry;

  const sourceEntry = path.join(pluginRoot, 'index.ts');
  if (fs.existsSync(sourceEntry)) return sourceEntry;

  if (fs.existsSync(distEntry)) return distEntry;

  if (path.basename(currentDir) === 'dist') return distEntry;

  return sourceEntry;
}

function resolvePluginEntryFile() {
  return resolvePluginEntryFileFromModule(import.meta.url);
}

export const pluginFile = resolvePluginEntryFile();
export const pluginDir = path.dirname(pluginFile);
export const pluginRequire = createRequire(pluginFile);
export const pluginRoot = resolveBncrPluginRoot(pluginFile);

const runtimeSourceDir = resolveBncrRuntimeSourceDir(pluginDir);
let runtime: LoadedRuntime | null = null;

export const readPluginVersion = (rootDir = pluginRoot) => {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
};

export const pluginVersion = readPluginVersion();

export const loadBncrRuntimeSync = (): LoadedRuntime => {
  if (runtime) return runtime;
  ensureBncrOpenClawSdkResolution(pluginDir, pluginRequire as NodeRequire);
  try {
    const mod = pluginRequire(path.join(runtimeSourceDir, 'channel.ts')) as ChannelModule;
    runtime = {
      createBncrBridge: mod.createBncrBridge,
      createBncrChannelPlugin: mod.createBncrChannelPlugin,
    };
    return runtime;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(
      `bncr failed to load channel runtime after dependency bootstrap from ${runtimeSourceDir}: ${detail}`,
    );
  }
};
