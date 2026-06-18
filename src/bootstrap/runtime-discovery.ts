import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const pluginPackageName = '@xmoxmo/bncr';
const sdkCoreSpecifier = 'openclaw/plugin-sdk/core';
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

export function resolveBncrPluginRoot(filePath: string) {
  let current =
    fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
      ? filePath
      : path.dirname(filePath);
  while (true) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === pluginPackageName) return current;
      } catch {
        // Keep walking; package metadata is diagnostic-only for root resolution.
      }
    }
    if (fs.existsSync(path.join(current, 'openclaw.plugin.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.dirname(filePath);
    current = parent;
  }
}

function tryExec(command: string, args: string[]) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function readOpenClawPackageName(pkgPath: string) {
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.name === 'string' ? parsed.name : '';
  } catch {
    return '';
  }
}

function unique(items: string[]) {
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
}

function findOpenClawPackageRoot(startPath: string) {
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
}

function collectOpenClawCandidates(pluginDir: string) {
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
}

function canResolveSdkCore(pluginRequire: NodeRequire) {
  try {
    pluginRequire.resolve(sdkCoreSpecifier);
    return true;
  } catch {
    return false;
  }
}

function ensurePluginNodeModulesLink(pluginDir: string, targetRoot: string) {
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
}

export function resolveBncrRuntimeSourceDir(pluginDir: string) {
  const pluginRoot = resolveBncrPluginRoot(pluginDir);
  const rootSource = path.join(pluginRoot, 'src');
  if (fs.existsSync(path.join(rootSource, 'channel.ts'))) return rootSource;

  const direct = path.join(pluginDir, 'src');
  if (fs.existsSync(path.join(direct, 'channel.ts'))) return direct;

  const parent = path.join(pluginDir, '..', 'src');
  if (fs.existsSync(path.join(parent, 'channel.ts'))) return parent;

  return direct;
}

export function ensureBncrOpenClawSdkResolution(pluginDir: string, pluginRequire: NodeRequire) {
  if (canResolveSdkCore(pluginRequire)) return;

  let lastError = '';
  const candidates = collectOpenClawCandidates(pluginDir);
  for (const candidate of candidates) {
    try {
      ensurePluginNodeModulesLink(pluginDir, candidate);
      if (canResolveSdkCore(pluginRequire)) return;
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
}
