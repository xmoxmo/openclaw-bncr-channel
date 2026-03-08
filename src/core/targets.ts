import type { BncrRoute } from './types.js';

const BNCR_SESSION_KEY_PREFIX = 'agent:main:bncr:direct:';

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

function parseRouteFromModernDisplayScope(scope: string): BncrRoute | null {
  const parts = asString(scope).trim().split(':');
  if (parts.length === 2) {
    const [platform, userId] = parts;
    if (!platform || !userId) return null;
    return { platform, groupId: '0', userId };
  }

  if (parts.length >= 3) {
    const [platform, groupId, userId] = parts;
    if (!platform || !groupId || !userId) return null;
    return { platform, groupId, userId };
  }

  return null;
}

export function parseRouteFromDisplayScope(scope: string): BncrRoute | null {
  const raw = asString(scope).trim();
  if (!raw) return null;

  const modernPayload = raw.match(/^bncr-(.+)$/i)?.[1];
  if (modernPayload) {
    return parseRouteFromModernDisplayScope(modernPayload);
  }

  const gPayload = raw.match(/^bncr:g-(.+)$/i)?.[1];
  if (gPayload) {
    if (isLowerHex(gPayload)) {
      const route = parseRouteFromHexScope(gPayload);
      if (route) return route;
    }
    return parseRouteFromScope(gPayload);
  }

  const bPayload = raw.match(/^bncr:(.+)$/i)?.[1];
  if (bPayload) {
    if (isLowerHex(bPayload)) {
      const route = parseRouteFromHexScope(bPayload);
      if (route) return route;
    }
    return parseRouteFromScope(bPayload);
  }

  return null;
}

export function formatLegacyDisplayScope(route: BncrRoute): string {
  return `bncr:${route.platform}:${route.groupId}:${route.userId}`;
}

export function formatDisplayScope(route: BncrRoute): string {
  if (route.groupId === '0' && route.userId !== '0') {
    return `Bncr-${route.platform}:${route.userId}`;
  }
  return `Bncr-${route.platform}:${route.groupId}:${route.userId}`;
}

export function buildDisplayScopeCandidates(route: BncrRoute): string[] {
  const candidates = [
    formatDisplayScope(route),
    formatLegacyDisplayScope(route),
    `${route.platform}:${route.groupId}:${route.userId}`,
    `${route.platform}:${route.userId}`,
    `${route.userId}`,
  ].filter(Boolean);

  return Array.from(new Set(candidates.map((x) => asString(x).trim()).filter(Boolean)));
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

export function parseLegacySessionKeyToStrict(input: string): string | null {
  const raw = asString(input).trim();
  if (!raw) return null;

  const directLegacy = raw.match(/^agent:main:bncr:direct:([0-9a-fA-F]+):0$/);
  if (directLegacy?.[1]) {
    const route = parseRouteFromHexScope(directLegacy[1].toLowerCase());
    if (route) return buildFallbackSessionKey(route);
  }

  const bncrLegacy = raw.match(/^bncr:([0-9a-fA-F]+):0$/);
  if (bncrLegacy?.[1]) {
    const route = parseRouteFromHexScope(bncrLegacy[1].toLowerCase());
    if (route) return buildFallbackSessionKey(route);
  }

  const agentLegacy = raw.match(/^agent:main:bncr:([0-9a-fA-F]+):0$/);
  if (agentLegacy?.[1]) {
    const route = parseRouteFromHexScope(agentLegacy[1].toLowerCase());
    if (route) return buildFallbackSessionKey(route);
  }

  if (isLowerHex(raw.toLowerCase())) {
    const route = parseRouteFromHexScope(raw.toLowerCase());
    if (route) return buildFallbackSessionKey(route);
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

export function parseStrictBncrSessionKey(input: string): { sessionKey: string; scopeHex: string; route: BncrRoute } | null {
  const raw = asString(input).trim();
  if (!raw) return null;

  const m = raw.match(/^agent:main:bncr:(direct|group):(.+)$/);
  if (!m?.[1] || !m?.[2]) return null;

  const payload = asString(m[2]).trim();
  let route: BncrRoute | null = null;
  let scopeHex = '';

  if (isLowerHex(payload)) {
    scopeHex = payload;
    route = parseRouteFromHexScope(payload);
  } else {
    route = parseRouteFromScope(payload);
    if (route) scopeHex = routeScopeToHex(route);
  }

  if (!route || !scopeHex) return null;

  return {
    sessionKey: `${BNCR_SESSION_KEY_PREFIX}${scopeHex}`,
    scopeHex,
    route,
  };
}

export function normalizeTaskKey(input: unknown): string | null {
  const raw = asString(input).trim().toLowerCase();
  if (!raw) return null;
  const normalized = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return normalized || null;
}

export function normalizeStoredSessionKey(input: string): { sessionKey: string; route: BncrRoute } | null {
  const raw = asString(input).trim();
  if (!raw) return null;

  let taskKey: string | null = null;
  let base = raw;

  const taskTagged = raw.match(/^(.*):task:([a-z0-9_-]{1,32})$/i);
  if (taskTagged) {
    base = asString(taskTagged[1]).trim();
    taskKey = normalizeTaskKey(taskTagged[2]);
  }

  const strict = parseStrictBncrSessionKey(base);
  if (strict) {
    if (isLegacyNoiseRoute(strict.route)) return null;
    return {
      sessionKey: taskKey ? `${strict.sessionKey}:task:${taskKey}` : strict.sessionKey,
      route: strict.route,
    };
  }

  const migrated = parseLegacySessionKeyToStrict(base);
  if (!migrated) return null;

  const parsed = parseStrictBncrSessionKey(migrated);
  if (!parsed) return null;
  if (isLegacyNoiseRoute(parsed.route)) return null;

  return {
    sessionKey: taskKey ? `${parsed.sessionKey}:task:${taskKey}` : parsed.sessionKey,
    route: parsed.route,
  };
}

export function normalizeInboundSessionKey(scope: string, route: BncrRoute): string | null {
  const raw = asString(scope).trim();
  if (!raw) return buildFallbackSessionKey(route);

  const parsed = parseStrictBncrSessionKey(raw);
  if (!parsed) return null;
  return parsed.sessionKey;
}

export function extractInlineTaskKey(text: string): { taskKey: string | null; text: string } {
  const raw = asString(text);
  if (!raw) return { taskKey: null, text: '' };

  const tagged = raw.match(/^\s*(?:#task|\/task)\s*[:=]\s*([a-zA-Z0-9_-]{1,32})\s*\n?\s*([\s\S]*)$/i);
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

export function buildFallbackSessionKey(route: BncrRoute): string {
  return `${BNCR_SESSION_KEY_PREFIX}${routeScopeToHex(route)}`;
}

export function routeKey(accountId: string, route: BncrRoute): string {
  return `${accountId}:${route.platform}:${route.groupId}:${route.userId}`.toLowerCase();
}
