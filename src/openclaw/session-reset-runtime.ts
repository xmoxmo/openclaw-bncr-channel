import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type SessionResetResult = { ok?: boolean } | undefined;
type SessionResetParams = {
  key: string;
  reason: 'new' | 'reset';
  agentId?: string;
  commandSource?: string;
};
type SessionResetFn = (params: SessionResetParams) => Promise<SessionResetResult>;

let testOverride: SessionResetFn | null = null;
let resolvedSessionResetRuntimeCache: SessionResetFn | null = null;

export function setBncrSessionResetRuntimeForTest(fn: SessionResetFn | null): () => void {
  const previous = testOverride;
  testOverride = fn;
  return () => {
    testOverride = previous;
  };
}

function findPackageRoot(startPath: string, packageName: string): string | null {
  let current = dirname(startPath);
  while (true) {
    const pkgPath = join(current, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
      if (pkg.name === packageName) return current;
    } catch {
      // Keep walking toward the package root.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveOpenClawDistDir(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  let resolvedOpenClawEntry: string | null = null;
  try {
    resolvedOpenClawEntry = createRequire(import.meta.url).resolve('openclaw');
  } catch {
    // Fall back to the plugin-local dependency path below.
  }

  const openClawRoot = resolvedOpenClawEntry
    ? findPackageRoot(resolvedOpenClawEntry, 'openclaw')
    : null;
  if (openClawRoot) {
    const distDir = join(openClawRoot, 'dist');
    if (existsSync(distDir)) return distDir;
  }

  while (true) {
    const pluginRoot = findPackageRoot(current, '@xmoxmo/bncr');
    if (pluginRoot) {
      const distDir = join(pluginRoot, 'node_modules', 'openclaw', 'dist');
      if (existsSync(distDir)) return distDir;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const resolvedPath = resolvedOpenClawEntry || '(unresolved)';
  const pluginPath = join(
    dirname(fileURLToPath(import.meta.url)),
    'node_modules',
    'openclaw',
    'dist',
  );
  throw new Error(
    `OpenClaw dist directory not found (resolved entry: ${resolvedPath}; plugin fallback: ${pluginPath})`,
  );
}

function resolveOpenClawSessionsRuntimeUrls(): string[] {
  const distDir = resolveOpenClawDistDir();
  if (!existsSync(distDir)) {
    throw new Error(`OpenClaw dist directory not found: ${distDir}`);
  }

  // Scan dist for sessions.runtime*.js, preferring the stable re-export.
  const candidates = readdirSync(distDir)
    .filter((name) => /^sessions\.runtime(?:-[A-Za-z0-9_-]+)?\.js$/.test(name))
    .sort(
      (a, b) =>
        Number(b === 'sessions.runtime.js') - Number(a === 'sessions.runtime.js') ||
        a.localeCompare(b),
    );
  return candidates.map((name) => pathToFileURL(join(distDir, name)).href);
}

export async function performBncrGatewaySessionReset(
  params: SessionResetParams,
): Promise<SessionResetResult> {
  if (testOverride) return testOverride(params);
  if (!resolvedSessionResetRuntimeCache) {
    const candidates = resolveOpenClawSessionsRuntimeUrls();
    const importErrors: string[] = [];
    for (const url of candidates) {
      try {
        const mod = (await import(url)) as { performGatewaySessionReset?: SessionResetFn };
        if (typeof mod.performGatewaySessionReset === 'function') {
          resolvedSessionResetRuntimeCache = mod.performGatewaySessionReset;
          break;
        }
        importErrors.push(`${url}: export unavailable`);
      } catch (error) {
        importErrors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!resolvedSessionResetRuntimeCache) {
      throw new Error(
        `OpenClaw performGatewaySessionReset is unavailable; candidates: ${importErrors.join('; ') || '(none)'}`,
      );
    }
  }
  return resolvedSessionResetRuntimeCache(params);
}
