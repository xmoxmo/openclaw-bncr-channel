import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readBncrSessionEntryStrict } from './inbound-session-runtime.ts';

type SessionResetResult = { ok?: boolean } | undefined;
type SessionResetParams = {
  key: string;
  reason: 'new' | 'reset';
  agentId?: string;
  commandSource?: string;
  authorizedPluginId?: string;
};
type SessionResetFn = (params: SessionResetParams) => Promise<SessionResetResult>;

const BNCR_PLUGIN_ID = 'bncr';

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

async function resolveSessionResetRuntime(): Promise<SessionResetFn> {
  if (testOverride) return testOverride;
  if (resolvedSessionResetRuntimeCache) return resolvedSessionResetRuntimeCache;

  const candidates = resolveOpenClawSessionsRuntimeUrls();
  const importErrors: string[] = [];
  for (const url of candidates) {
    try {
      const mod = (await import(url)) as { performGatewaySessionReset?: SessionResetFn };
      if (typeof mod.performGatewaySessionReset === 'function') {
        resolvedSessionResetRuntimeCache = mod.performGatewaySessionReset;
        return resolvedSessionResetRuntimeCache;
      }
      importErrors.push(`${url}: export unavailable`);
    } catch (error) {
      importErrors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `OpenClaw performGatewaySessionReset is unavailable; candidates: ${importErrors.join('; ') || '(none)'}`,
  );
}

export type SessionResetRuntimeProbe = { available: true } | { available: false; error: string };

/** Verify the host lifecycle bridge without mutating a session. */
export async function probeBncrSessionResetRuntime(): Promise<SessionResetRuntimeProbe> {
  try {
    await resolveSessionResetRuntime();
    return { available: true };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Refuse to reset a session owned by another plugin. Channel-created sessions
 * have no pluginOwnerId; those remain eligible under Bncr's own admission rules.
 */
export async function assertBncrSessionResetOwnership(params: {
  storePath: string;
  sessionKey: string;
}): Promise<void> {
  const entry = await readBncrSessionEntryStrict(params);
  const owner = typeof entry?.pluginOwnerId === 'string' ? entry.pluginOwnerId.trim() : '';
  if (owner && owner !== BNCR_PLUGIN_ID) {
    throw new Error(
      `session reset refused: target is owned by plugin ${owner}, not ${BNCR_PLUGIN_ID}`,
    );
  }
}

export async function performBncrGatewaySessionReset(
  params: SessionResetParams,
): Promise<SessionResetResult> {
  return (await resolveSessionResetRuntime())({
    ...params,
    authorizedPluginId: BNCR_PLUGIN_ID,
  });
}
