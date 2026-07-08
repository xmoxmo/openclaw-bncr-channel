import type { BncrRoute } from './types.ts';

type RouteInputLike = {
  platform?: unknown;
  groupId?: unknown;
  userId?: unknown;
  route?: unknown;
};

export type BncrSessionKind = 'direct' | 'group';

export type BncrExplicitTarget = {
  raw: string;
  normalized: string;
  source:
    | 'display-scope'
    | 'strict-session-key'
    | 'legacy-session-key'
    | 'hex-scope'
    | 'route-scope';
  kind: BncrSessionKind;
  chatType: 'direct';
  displayScope: string;
  route: BncrRoute;
  canonicalSessionKey?: string;
  platform: string;
  userId: string;
  groupId?: string;
};

export function asTargetString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  return String(value);
}

export function parseRouteFromStandardDisplayScope(scope: string): BncrRoute | null {
  const parts = asTargetString(scope).trim().split(':');
  if (parts.length === 3) {
    const [platform, kind, id] = parts;
    if (!platform || !kind || !id) return null;
    if (kind === 'User') return { platform, groupId: '0', userId: id };
    if (kind === 'Group') return { platform, groupId: id, userId: '0' };
    if (kind.toLowerCase() === 'user' || kind.toLowerCase() === 'group') return null;
  }

  if (parts.length === 2) {
    const [platform, userId] = parts;
    if (!platform || !userId) return null;
    return { platform, groupId: '0', userId };
  }

  if (parts.length === 3) {
    const [platform, groupId, userId] = parts;
    if (!platform || !groupId || !userId) return null;
    if (groupId !== '0' && userId !== '0') {
      // Legacy group routes may still include the triggering userId; collapse them
      // back to the shared group route so old targets remain deliverable.
      return { platform, groupId, userId: '0' };
    }
    return { platform, groupId, userId };
  }

  return null;
}

function parseGroupScope(scope: string): { platform: string; groupId: string } | null {
  const parts = asTargetString(scope).trim().split(':');
  if (parts.length !== 2) return null;
  const [platform, groupId] = parts;
  if (!platform || !groupId) return null;
  return { platform, groupId };
}

function parseDirectScope(scope: string): { platform: string; userId: string } | null {
  const parts = asTargetString(scope).trim().split(':');
  if (parts.length !== 2) return null;
  const [platform, userId] = parts;
  if (!platform || !userId) return null;
  return { platform, userId };
}

export function normalizeDisplayScopePrefix(scope: string): string {
  const raw = asTargetString(scope).trim();
  if (!raw) return '';
  if (raw.startsWith('Bncr:')) return raw;
  if (/^bncr[:-]/i.test(raw)) return raw;
  if (!parseRouteFromStandardDisplayScope(raw)) return raw;
  return `Bncr:${raw}`;
}

export function resolveCanonicalSessionKind(): BncrSessionKind {
  return 'direct';
}

export function buildExplicitTargetResult(args: {
  raw: string;
  source:
    | 'display-scope'
    | 'strict-session-key'
    | 'legacy-session-key'
    | 'hex-scope'
    | 'route-scope';
  route: BncrRoute;
  displayScope: string;
  canonicalSessionKey?: string;
}) {
  const kind: BncrSessionKind = args.route.groupId === '0' ? 'direct' : 'group';
  return {
    raw: args.raw,
    normalized: args.displayScope,
    source: args.source,
    kind,
    chatType: 'direct' as const,
    displayScope: args.displayScope,
    route: args.route,
    ...(args.canonicalSessionKey ? { canonicalSessionKey: args.canonicalSessionKey } : {}),
    platform: args.route.platform,
    userId: args.route.userId,
    ...(args.route.groupId === '0' ? {} : { groupId: args.route.groupId }),
  };
}

export function isLowerHex(input: string): boolean {
  const raw = asTargetString(input).trim();
  return !!raw && /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0;
}

export function routeScopeToHex(route: BncrRoute): string {
  const raw = `${route.platform}:${route.groupId}:${route.userId}`;
  return Buffer.from(raw, 'utf8').toString('hex').toLowerCase();
}

export function groupScopeToHex(route: BncrRoute): string {
  const raw = `${route.platform}:${route.groupId}`;
  return Buffer.from(raw, 'utf8').toString('hex').toLowerCase();
}

export function directScopeToHex(route: BncrRoute): string {
  const raw = `${route.platform}:${route.userId}`;
  return Buffer.from(raw, 'utf8').toString('hex').toLowerCase();
}

export function parseRouteFromScope(scope: string): BncrRoute | null {
  const parts = asTargetString(scope).trim().split(':');
  if (parts.length < 3) return null;
  const [platform, groupId, userId] = parts;
  if (!platform || !groupId || !userId) return null;
  if (groupId !== '0' && userId !== '0') return null;
  return { platform, groupId, userId };
}

export function parseRouteFromHexScope(scopeHex: string): BncrRoute | null {
  const rawHex = asTargetString(scopeHex).trim();
  if (!isLowerHex(rawHex)) return null;

  try {
    const decoded = Buffer.from(rawHex, 'hex').toString('utf8');
    return parseRouteFromScope(decoded);
  } catch {
    return null;
  }
}

export function parseGroupRouteFromHexScope(scopeHex: string): BncrRoute | null {
  const rawHex = asTargetString(scopeHex).trim();
  if (!isLowerHex(rawHex)) return null;

  try {
    const decoded = Buffer.from(rawHex, 'hex').toString('utf8');
    const parsed = parseGroupScope(decoded);
    if (!parsed) return null;
    return { platform: parsed.platform, groupId: parsed.groupId, userId: '0' };
  } catch {
    return null;
  }
}

export function parseDirectRouteFromHexScope(scopeHex: string): BncrRoute | null {
  const rawHex = asTargetString(scopeHex).trim();
  if (!isLowerHex(rawHex)) return null;

  try {
    const decoded = Buffer.from(rawHex, 'hex').toString('utf8');
    const parsed = parseDirectScope(decoded);
    if (!parsed) return null;
    return { platform: parsed.platform, groupId: '0', userId: parsed.userId };
  } catch {
    return null;
  }
}

export function parseStrictBncrSessionKey(input: string): {
  inputSessionKey: string;
  inputAgentId: string;
  inputKind: BncrSessionKind;
  scopeHex: string;
  route: BncrRoute;
} | null {
  const raw = asTargetString(input).trim();
  if (!raw) return null;

  const m = raw.match(/^agent:([^:]+):bncr:(direct|group):(.+)$/);
  if (!m?.[1] || !m?.[2] || !m?.[3]) return null;

  const inputAgentId = asTargetString(m[1]).trim();
  const inputKind = m[2] as BncrSessionKind;
  const payload = asTargetString(m[3]).trim();
  let route: BncrRoute | null = null;
  let scopeHex = '';

  if (isLowerHex(payload)) {
    scopeHex = payload.toLowerCase();
    route =
      inputKind === 'group'
        ? parseGroupRouteFromHexScope(scopeHex)
        : parseDirectRouteFromHexScope(scopeHex) || parseRouteFromHexScope(scopeHex);
  } else {
    route =
      inputKind === 'group'
        ? (() => {
            const parsed = parseGroupScope(payload);
            return parsed
              ? { platform: parsed.platform, groupId: parsed.groupId, userId: '0' }
              : null;
          })()
        : (() => {
            const direct = parseDirectScope(payload);
            if (direct) return { platform: direct.platform, groupId: '0', userId: direct.userId };
            return parseRouteFromScope(payload);
          })();
    if (route) scopeHex = routeScopeToHex(route);
  }

  if (!route || !scopeHex) return null;

  return {
    inputSessionKey: raw,
    inputAgentId,
    inputKind,
    scopeHex,
    route,
  };
}

export function parseLegacySessionKey(input: string): {
  route: BncrRoute;
  inputKind: BncrSessionKind;
  inputAgentId?: string;
  source: 'legacy-direct' | 'legacy-bncr' | 'legacy-agent' | 'hex';
} | null {
  const raw = asTargetString(input).trim();
  if (!raw) return null;

  const directLegacy = raw.match(/^agent:([^:]+):bncr:direct:([0-9a-fA-F]+):0$/);
  if (directLegacy?.[1] && directLegacy?.[2]) {
    const route = parseRouteFromHexScope(directLegacy[2].toLowerCase());
    if (route) {
      return {
        route,
        inputKind: 'direct',
        inputAgentId: directLegacy[1],
        source: 'legacy-direct',
      };
    }
  }

  const bncrLegacy = raw.match(/^bncr:([0-9a-fA-F]+):0$/);
  if (bncrLegacy?.[1]) {
    const route = parseRouteFromHexScope(bncrLegacy[1].toLowerCase());
    if (route) {
      return {
        route,
        inputKind: 'direct',
        source: 'legacy-bncr',
      };
    }
  }

  const agentLegacy = raw.match(/^agent:([^:]+):bncr:([0-9a-fA-F]+):0$/);
  if (agentLegacy?.[1] && agentLegacy?.[2]) {
    const route = parseRouteFromHexScope(agentLegacy[2].toLowerCase());
    if (route) {
      return {
        route,
        inputKind: 'direct',
        inputAgentId: agentLegacy[1],
        source: 'legacy-agent',
      };
    }
  }

  if (isLowerHex(raw.toLowerCase())) {
    const route = parseRouteFromHexScope(raw.toLowerCase());
    if (route) {
      return {
        route,
        inputKind: 'direct',
        source: 'hex',
      };
    }
  }

  return null;
}

export function isLegacyNoiseRoute(route: BncrRoute): boolean {
  const platform = asTargetString(route.platform).trim().toLowerCase();
  const groupId = asTargetString(route.groupId).trim().toLowerCase();
  const userId = asTargetString(route.userId).trim().toLowerCase();

  if (platform === 'agent' && groupId === 'main' && userId === 'bncr') return true;
  if (platform === 'bncr' && userId === '0' && isLowerHex(groupId)) return true;
  return false;
}

export function parseRouteFromDisplayScope(scope: string): BncrRoute | null {
  const raw = normalizeDisplayScopePrefix(scope);
  if (!raw) return null;

  const payload = raw.match(/^Bncr:(.+)$/)?.[1];
  if (!payload) return null;
  const route = parseRouteFromStandardDisplayScope(payload);
  if (!route) return null;
  return route;
}

export function buildCanonicalBncrSessionKey(route: BncrRoute, canonicalAgentId: string): string {
  const agentId = asTargetString(canonicalAgentId).trim() || 'main';
  if (route.groupId !== '0') {
    return `agent:${agentId}:bncr:group:${groupScopeToHex(route)}`;
  }
  return `agent:${agentId}:bncr:direct:${directScopeToHex(route)}`;
}

export function normalizeStoredSessionKey(
  input: string,
  canonicalAgentId?: string | null,
  helpers?: { normalizeTaskKey?: (input: unknown) => string | null },
): { sessionKey: string; route: BncrRoute } | null {
  const raw = asTargetString(input).trim();
  if (!raw) return null;

  let taskKey: string | null = null;
  let base = raw;

  const taskTagged = raw.match(/^(.*):task:([a-z0-9_-]{1,32})$/i);
  if (taskTagged) {
    base = asTargetString(taskTagged[1]).trim();
    taskKey = helpers?.normalizeTaskKey?.(taskTagged[2]) || null;
  }

  let route: BncrRoute | null = null;
  let passthroughAgentId: string | null = null;

  const legacy = parseLegacySessionKey(base);
  if (legacy) {
    route = legacy.route;
    passthroughAgentId = legacy.inputAgentId || null;
  }

  if (!route) {
    const strict = parseStrictBncrSessionKey(base);
    if (strict) {
      route = strict.route;
      passthroughAgentId = strict.inputAgentId;
    }
  }

  if (!route) return null;
  if (isLegacyNoiseRoute(route)) return null;

  const finalAgentId = asTargetString(canonicalAgentId).trim() || passthroughAgentId;
  if (!finalAgentId) return null;

  const finalSessionKey = buildCanonicalBncrSessionKey(route, finalAgentId);
  return {
    sessionKey: taskKey ? `${finalSessionKey}:task:${taskKey}` : finalSessionKey,
    route,
  };
}

export function normalizeInboundSessionKey(
  scope: string,
  route: BncrRoute,
  canonicalAgentId: string,
): string | null {
  const raw = asTargetString(scope).trim();
  let finalRoute: BncrRoute | null = null;

  if (!raw) finalRoute = route;
  if (!finalRoute) finalRoute = parseStrictBncrSessionKey(raw)?.route || null;
  if (!finalRoute) finalRoute = parseLegacySessionKey(raw)?.route || null;
  if (!finalRoute) finalRoute = parseRouteFromDisplayScope(raw);
  if (!finalRoute) finalRoute = parseRouteFromScope(raw);
  if (!finalRoute && route) finalRoute = route;
  if (!finalRoute) return null;

  return buildCanonicalBncrSessionKey(finalRoute, canonicalAgentId);
}

export function buildFallbackSessionKey(route: BncrRoute, canonicalAgentId: string): string {
  return buildCanonicalBncrSessionKey(route, canonicalAgentId);
}

export function parseRouteLike(input: unknown): BncrRoute | null {
  const routeInput = input && typeof input === 'object' ? (input as RouteInputLike) : null;
  const platform = asTargetString(routeInput?.platform || '').trim();
  const groupId = asTargetString(routeInput?.groupId || '').trim();
  const userId = asTargetString(routeInput?.userId || '').trim();
  if (!platform || !groupId || !userId) return null;
  if (groupId !== '0' && userId !== '0') return null;
  return { platform, groupId, userId };
}

export type BncrExplicitTargetSource =
  | 'display-scope'
  | 'strict-session-key'
  | 'legacy-session-key'
  | 'hex-scope'
  | 'route-scope';

export function formatDisplayScope(route: BncrRoute): string {
  const platform = asTargetString(route?.platform).trim();
  const groupId = asTargetString(route?.groupId || '0').trim() || '0';
  const userId = asTargetString(route?.userId || '0').trim() || '0';
  if (groupId !== '0') return `Bncr:${platform}:${groupId}:0`;
  return `Bncr:${platform}:0:${userId}`;
}

export function formatHumanDisplayScope(route: BncrRoute): string {
  const platform = asTargetString(route?.platform).trim();
  const groupId = asTargetString(route?.groupId || '0').trim() || '0';
  const userId = asTargetString(route?.userId || '0').trim() || '0';
  if (groupId !== '0') return `Bncr:${platform}:Group:${groupId}`;
  if (userId !== '0') return `Bncr:${platform}:User:${userId}`;
  return formatDisplayScope(route);
}

export function buildDisplayScopeCandidates(route: BncrRoute): string[] {
  const candidates = [formatDisplayScope(route)].filter(Boolean);
  return Array.from(new Set(candidates.map((x) => asTargetString(x).trim()).filter(Boolean)));
}

export function resolveExplicitTargetRoute(raw: string): {
  route: BncrRoute | null;
  source: BncrExplicitTargetSource | null;
} {
  let route: BncrRoute | null = null;
  let source: BncrExplicitTargetSource | null = null;

  const strict = parseStrictBncrSessionKey(raw);
  if (strict?.route) {
    route = strict.route;
    source = 'strict-session-key';
  }

  if (!route) {
    const displayRoute = parseRouteFromDisplayScope(raw);
    if (displayRoute) {
      route = displayRoute;
      source = 'display-scope';
    }
  }

  if (!route) {
    const legacy = parseLegacySessionKey(raw);
    if (legacy?.route) {
      route = legacy.route;
      source = legacy.source === 'hex' ? 'hex-scope' : 'legacy-session-key';
    }
  }

  if (!route) {
    const hexRoute = parseRouteFromHexScope(raw);
    if (hexRoute) {
      route = hexRoute;
      source = 'hex-scope';
    }
  }

  if (!route) {
    const scopedRoute = parseRouteFromScope(raw);
    if (scopedRoute) {
      route = scopedRoute;
      source = 'route-scope';
    }
  }

  return { route, source };
}

export function parseExplicitTarget(input: string, options?: { canonicalAgentId?: string | null }) {
  const raw = asTargetString(input).trim();
  if (!raw) return null;

  const canonicalAgentId = asTargetString(options?.canonicalAgentId).trim() || undefined;
  const { route, source } = resolveExplicitTargetRoute(raw);
  if (!route || !source) return null;

  const displayScope = formatDisplayScope(route);
  return buildExplicitTargetResult({
    raw,
    source,
    route,
    displayScope,
    ...(canonicalAgentId
      ? { canonicalSessionKey: buildCanonicalBncrSessionKey(route, canonicalAgentId) }
      : {}),
  });
}

export function normalizeTaskKey(input: unknown): string | null {
  const raw = asTargetString(input).trim().toLowerCase();
  if (!raw) return null;
  const normalized = raw
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return normalized || null;
}

export function extractInlineTaskKey(text: string): { taskKey: string | null; text: string } {
  const raw = asTargetString(text);
  if (!raw) return { taskKey: null, text: '' };

  const tagged = raw.match(
    /^\s*(?:#task|\/task)\s*[:=]\s*([a-zA-Z0-9_-]{1,32})\s*\n?\s*([\s\S]*)$/i,
  );
  if (tagged) {
    return {
      taskKey: normalizeTaskKey(tagged[1]),
      text: asTargetString(tagged[2]),
    };
  }

  const spaced = raw.match(/^\s*\/task\s+([a-zA-Z0-9_-]{1,32})\s+([\s\S]*)$/i);
  if (spaced) {
    return {
      taskKey: normalizeTaskKey(spaced[1]),
      text: asTargetString(spaced[2]),
    };
  }

  return { taskKey: null, text: raw };
}

export function withTaskSessionKey(sessionKey: string, taskKey?: string | null): string {
  const base = asTargetString(sessionKey).trim();
  const tk = normalizeTaskKey(taskKey);
  if (!base || !tk) return base;
  if (/:task:[a-z0-9_-]+(?:$|:)/i.test(base)) return base;
  return `${base}:task:${tk}`;
}

export function formatTargetDisplay(
  input: BncrRoute | BncrExplicitTarget | null | undefined,
): string {
  if (!input) return '';
  const routeInput = input && typeof input === 'object' ? (input as RouteInputLike) : null;
  const route = parseRouteLike(routeInput?.route) || parseRouteLike(input);
  if (!route) return '';
  return formatDisplayScope(route);
}

export function routeKey(accountId: string, route: BncrRoute): string {
  return `${accountId}:${route.platform}:${route.groupId}:${route.userId}`.toLowerCase();
}
