import { existsSync, readFileSync } from 'node:fs';
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
let resolvedSessionRuntimeUrlCache: string | null = null;

export function setBncrSessionResetRuntimeForTest(fn: SessionResetFn | null): () => void {
  const previous = testOverride;
  testOverride = fn;
  return () => {
    testOverride = previous;
  };
}

function resolveOpenClawSessionsRuntimeUrl(): string {
  if (resolvedSessionRuntimeUrlCache) return resolvedSessionRuntimeUrlCache;
  let current = dirname(fileURLToPath(import.meta.url));
  let pluginRoot: string | null = null;
  while (true) {
    const pkgPath = join(current, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
      if (pkg.name === '@xmoxmo/bncr') {
        pluginRoot = current;
        break;
      }
    } catch {
      // Keep walking up toward the plugin root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!pluginRoot) {
    throw new Error('bncr plugin root not found for session reset runtime');
  }

  // Try candidate paths for the sessions runtime re-export file.
  // The hash-stamped bundle name may change across OpenClaw releases, so we
  // first try the stable re-export entry and fall back to the known hash.
  const candidates = [
    join(pluginRoot, 'node_modules', 'openclaw', 'dist', 'sessions.runtime.js'),
    join(pluginRoot, 'node_modules', 'openclaw', 'dist', 'sessions.runtime-BQwwkuFq.js'),
  ];
  for (const target of candidates) {
    if (existsSync(target)) {
      resolvedSessionRuntimeUrlCache = pathToFileURL(target).href;
      return resolvedSessionRuntimeUrlCache;
    }
  }
  throw new Error(
    `OpenClaw sessions runtime not found under ${join(pluginRoot, 'node_modules', 'openclaw', 'dist')}`,
  );
}

export async function performBncrGatewaySessionReset(
  params: SessionResetParams,
): Promise<SessionResetResult> {
  if (testOverride) return testOverride(params);
  const mod = (await import(resolveOpenClawSessionsRuntimeUrl())) as {
    performGatewaySessionReset?: SessionResetFn;
  };
  if (typeof mod.performGatewaySessionReset !== 'function') {
    throw new Error('OpenClaw performGatewaySessionReset is unavailable');
  }
  return mod.performGatewaySessionReset(params);
}
