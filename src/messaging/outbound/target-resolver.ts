import {
  formatDisplayScope,
  parseRouteFromDisplayScope,
  parseStrictBncrSessionKey,
} from '../../core/targets.ts';
import type { BncrRoute } from '../../core/types.ts';

type ResolveBncrOutboundTargetParams = {
  target: string;
  accountId?: string | null;
  resolveRouteBySession?: (raw: string, accountId: string) => BncrRoute | null;
};

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

export function looksLikeBncrExplicitTarget(input: string): boolean {
  const raw = asString(input).trim();
  if (!raw) return false;
  return Boolean(parseRouteFromDisplayScope(raw) || parseStrictBncrSessionKey(raw));
}

export function resolveBncrOutboundTarget(params: ResolveBncrOutboundTargetParams): {
  route: BncrRoute;
  displayScope: string;
  kind: 'user' | 'group';
} | null {
  const raw = asString(params.target).trim();
  if (!raw) return null;

  let route: BncrRoute | null = null;

  const strict = parseStrictBncrSessionKey(raw);
  if (strict?.route) {
    route = strict.route;
  }

  if (!route) {
    route = parseRouteFromDisplayScope(raw);
  }

  if (!route && params.accountId && params.resolveRouteBySession) {
    route = params.resolveRouteBySession(raw, params.accountId);
  }

  if (!route) return null;

  return {
    route,
    displayScope: formatDisplayScope(route),
    kind: route.groupId === '0' ? 'user' : 'group',
  };
}
