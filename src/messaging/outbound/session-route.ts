import { buildChannelOutboundSessionRoute } from 'openclaw/plugin-sdk/core';
import {
  buildCanonicalBncrSessionKey,
  formatDisplayScope,
  parseRouteFromDisplayScope,
  parseStrictBncrSessionKey,
  routeScopeToHex,
} from '../../core/targets.ts';
import type { BncrRoute } from '../../core/types.ts';

type ResolveBncrOutboundSessionRouteParams = {
  cfg: any;
  channel: string;
  agentId: string;
  accountId?: string;
  target: string;
  resolvedTarget?: { to?: string } | null;
  threadId?: string;
  canonicalAgentId: string;
  resolveRouteBySession?: (raw: string, accountId: string) => BncrRoute | null;
};

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

export function resolveBncrOutboundSessionRoute(params: ResolveBncrOutboundSessionRouteParams) {
  const raw = asString(params.resolvedTarget?.to || params.target).trim();
  if (!raw) return null;

  let route: BncrRoute | null = null;

  const strict = parseStrictBncrSessionKey(raw);
  if (strict) {
    route = strict.route;
  } else {
    route = parseRouteFromDisplayScope(raw);
    if (!route && params.accountId && params.resolveRouteBySession) {
      route = params.resolveRouteBySession(raw, params.accountId);
    }
  }

  if (!route) return null;

  const canonicalAgentId =
    asString(params.canonicalAgentId).trim() || asString(params.agentId).trim() || 'main';
  const peerId = routeScopeToHex(route);
  const sessionKey = buildCanonicalBncrSessionKey(route, canonicalAgentId);
  const displayTo = formatDisplayScope(route);

  const built = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: canonicalAgentId,
    channel: params.channel,
    accountId: params.accountId,
    peer: {
      kind: 'direct',
      id: peerId,
    },
    chatType: 'direct',
    from: displayTo,
    to: displayTo,
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
  });

  return {
    ...built,
    sessionKey,
    baseSessionKey: sessionKey,
  };
}
