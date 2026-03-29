import type { BncrRoute } from './types.ts';

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

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

export function parseRouteFromScope(scope: string): BncrRoute | null {
  const parts = asString(scope).trim().split(':');
  if (parts.length < 3) return null;
  const [platform, groupId, userId] = parts;
  if (!platform || !groupId || !userId) return null;
  return { platform, groupId, userId };
}

function parseRouteFromStandardDisplayScope(scope: string): BncrRoute | null {
  const parts = asString(scope).trim().split(':');
  if (parts.length === 2) {
    const [platform, userId] = parts;
    if (!platform || !userId) return null;
    return { platform, groupId: '0', userId };
  }

  if (parts.length === 3) {
    const [platform, groupId, userId] = parts;
    if (!platform || !groupId || !userId) return null;
    return { platform, groupId, userId };
  }

  return null;
}

export function parseRouteFromDisplayScope(scope: string): BncrRoute | null {
  const raw = asString(scope).trim();
  if (!raw) return null;

  const payload = raw.match(/^Bncr:(.+)$/)?.[1];
  if (!payload) return null;
  return parseRouteFromStandardDisplayScope(payload);
}

export function formatDisplayScope(route: BncrRoute): string {
  if (route.groupId === '0' && route.userId !== '0') {
    return `Bncr:${route.platform}:${route.userId}`;
  }
  return `Bncr:${route.platform}:${route.groupId}:${route.userId}`;
}

export function buildDisplayScopeCandidates(route: BncrRoute): string[] {
  const candidates = [formatDisplayScope(route)].filter(Boolean);
  return Array.from(new Set(candidates.map((x) => asString(x).trim()).filter(Boolean)));
}

export function formatTargetDisplay(
  input: BncrRoute | BncrExplicitTarget | null | undefined,
): string {
  if (!input) return '';
  const route = parseRouteLike((input as any)?.route) || parseRouteLike(input);
  if (!route) return '';
  return formatDisplayScope(route);
}

export function parseExplicitTarget(
  input: string,
  options?: { canonicalAgentId?: string | null },
): BncrExplicitTarget | null {
  const raw = asString(input).trim();
  if (!raw) return null;

  const canonicalAgentId = asString(options?.canonicalAgentId).trim() || undefined;
  let route: BncrRoute | null = null;
  let source: BncrExplicitTarget['source'] | null = null;

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

  if (!route || !source) return null;

  const kind: BncrSessionKind = route.groupId === '0' ? 'direct' : 'group';
  const displayScope = formatDisplayScope(route);
  return {
    raw,
    normalized: displayScope,
    source,
    kind,
    chatType: 'direct',
    displayScope,
    route,
    ...(canonicalAgentId
      ? { canonicalSessionKey: buildCanonicalBncrSessionKey(route, canonicalAgentId) }
      : {}),
    platform: route.platform,
    userId: route.userId,
    ...(route.groupId === '0' ? {} : { groupId: route.groupId }),
  };
}

export function isLowerHex(input: string): boolean {
  const raw = asString(input).trim();
  return !!raw && /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0;
}

export function routeScopeToHex(route: BncrRoute): string {
  const raw = `${route.platform}:${route.groupId}:${route.userId}`;
  return Buffer.from(raw, 'utf8').toString('hex').toLowerCase();
}

export function parseRouteFromHexScope(scopeHex: string): BncrRoute | null {
  const rawHex = asString(scopeHex).trim();
  if (!isLowerHex(rawHex)) return null;

  try {
    const decoded = Buffer.from(rawHex, 'hex').toString('utf8');
    return parseRouteFromScope(decoded);
  } catch {
    return null;
  }
}

export function parseRouteLike(input: unknown): BncrRoute | null {
  const platform = asString((input as any)?.platform || '').trim();
  const groupId = asString((input as any)?.groupId || '').trim();
  const userId = asString((input as any)?.userId || '').trim();
  if (!platform || !groupId || !userId) return null;
  return { platform, groupId, userId };
}

export function resolveCanonicalSessionKind(_input?: {
  route?: BncrRoute | null;
  scope?: string | null;
  sessionKey?: string | null;
}): BncrSessionKind {
  return 'direct';
}

export function buildCanonicalBncrSessionKey(route: BncrRoute, canonicalAgentId: string): string {
  const agentId = asString(canonicalAgentId).trim() || 'main';
  const kind = resolveCanonicalSessionKind({ route });
  return `agent:${agentId}:bncr:${kind}:${routeScopeToHex(route)}`;
}

export function parseLegacySessionKey(input: string): {
  route: BncrRoute;
  inputKind: BncrSessionKind;
  inputAgentId?: string;
  source: 'legacy-direct' | 'legacy-bncr' | 'legacy-agent' | 'hex';
} | null {
  const raw = asString(input).trim();
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
  const platform = asString(route.platform).trim().toLowerCase();
  const groupId = asString(route.groupId).trim().toLowerCase();
  const userId = asString(route.userId).trim().toLowerCase();

  if (platform === 'agent' && groupId === 'main' && userId === 'bncr') return true;
  if (platform === 'bncr' && userId === '0' && isLowerHex(groupId)) return true;
  return false;
}

export function parseStrictBncrSessionKey(input: string): {
  inputSessionKey: string;
  inputAgentId: string;
  inputKind: BncrSessionKind;
  scopeHex: string;
  route: BncrRoute;
} | null {
  const raw = asString(input).trim();
  if (!raw) return null;

  const m = raw.match(/^agent:([^:]+):bncr:(direct|group):(.+)$/);
  if (!m?.[1] || !m?.[2] || !m?.[3]) return null;

  const inputAgentId = asString(m[1]).trim();
  const inputKind = m[2] as BncrSessionKind;
  const payload = asString(m[3]).trim();
  let route: BncrRoute | null = null;
  let scopeHex = '';

  if (isLowerHex(payload)) {
    scopeHex = payload.toLowerCase();
    route = parseRouteFromHexScope(scopeHex);
  } else {
    route = parseRouteFromScope(payload);
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

export function normalizeTaskKey(input: unknown): string | null {
  const raw = asString(input).trim().toLowerCase();
  if (!raw) return null;
  const normalized = raw
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return normalized || null;
}

export function normalizeStoredSessionKey(
  input: string,
  canonicalAgentId?: string | null,
): { sessionKey: string; route: BncrRoute } | null {
  const raw = asString(input).trim();
  if (!raw) return null;

  let taskKey: string | null = null;
  let base = raw;

  const taskTagged = raw.match(/^(.*):task:([a-z0-9_-]{1,32})$/i);
  if (taskTagged) {
    base = asString(taskTagged[1]).trim();
    taskKey = normalizeTaskKey(taskTagged[2]);
  }

  let route: BncrRoute | null = null;
  let passthroughAgentId: string | null = null;

  const strict = parseStrictBncrSessionKey(base);
  if (strict) {
    route = strict.route;
    passthroughAgentId = strict.inputAgentId;
  }

  if (!route) {
    const legacy = parseLegacySessionKey(base);
    if (legacy) {
      route = legacy.route;
      passthroughAgentId = legacy.inputAgentId || null;
    }
  }

  if (!route) return null;
  if (isLegacyNoiseRoute(route)) return null;

  const finalAgentId = asString(canonicalAgentId).trim() || passthroughAgentId;
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
  const raw = asString(scope).trim();
  let finalRoute: BncrRoute | null = null;

  if (!raw) {
    finalRoute = route;
  }

  if (!finalRoute) {
    const strict = parseStrictBncrSessionKey(raw);
    if (strict?.route) {
      finalRoute = strict.route;
    }
  }

  if (!finalRoute) {
    const legacy = parseLegacySessionKey(raw);
    if (legacy?.route) {
      finalRoute = legacy.route;
    }
  }

  if (!finalRoute) {
    const displayRoute = parseRouteFromDisplayScope(raw);
    if (displayRoute) {
      finalRoute = displayRoute;
    }
  }

  if (!finalRoute) {
    const scopedRoute = parseRouteFromScope(raw);
    if (scopedRoute) {
      finalRoute = scopedRoute;
    }
  }

  if (!finalRoute && route) {
    finalRoute = route;
  }

  if (!finalRoute) return null;
  return buildCanonicalBncrSessionKey(finalRoute, canonicalAgentId);
}

export function extractInlineTaskKey(text: string): { taskKey: string | null; text: string } {
  const raw = asString(text);
  if (!raw) return { taskKey: null, text: '' };

  const tagged = raw.match(
    /^\s*(?:#task|\/task)\s*[:=]\s*([a-zA-Z0-9_-]{1,32})\s*\n?\s*([\s\S]*)$/i,
  );
  if (tagged) {
    return {
      taskKey: normalizeTaskKey(tagged[1]),
      text: asString(tagged[2]),
    };
  }

  const spaced = raw.match(/^\s*\/task\s+([a-zA-Z0-9_-]{1,32})\s+([\s\S]*)$/i);
  if (spaced) {
    return {
      taskKey: normalizeTaskKey(spaced[1]),
      text: asString(spaced[2]),
    };
  }

  return { taskKey: null, text: raw };
}

export function withTaskSessionKey(sessionKey: string, taskKey?: string | null): string {
  const base = asString(sessionKey).trim();
  const tk = normalizeTaskKey(taskKey);
  if (!base || !tk) return base;
  if (/:task:[a-z0-9_-]+(?:$|:)/i.test(base)) return base;
  return `${base}:task:${tk}`;
}

export function buildFallbackSessionKey(route: BncrRoute, canonicalAgentId: string): string {
  return buildCanonicalBncrSessionKey(route, canonicalAgentId);
}

export function routeKey(accountId: string, route: BncrRoute): string {
  return `${accountId}:${route.platform}:${route.groupId}:${route.userId}`.toLowerCase();
}
