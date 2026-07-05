import { CHANNEL_ID } from '../core/accounts.ts';
import { normalizeInboundSessionKey, withTaskSessionKey } from '../core/targets.ts';
import type { BncrRoute } from '../core/types.ts';
import type { OpenClawResolvedAgentRoute } from '../openclaw/routing-runtime.ts';
import type { BncrChannelConfigRoot } from './channel-runtime-types.ts';

function assertResolvedSessionKey(
  resolvedRoute: OpenClawResolvedAgentRoute,
): OpenClawResolvedAgentRoute & { sessionKey: string } {
  if (typeof resolvedRoute.sessionKey !== 'string' || !resolvedRoute.sessionKey.trim()) {
    throw new Error('OpenClaw resolveAgentRoute returned empty sessionKey');
  }
  return { ...resolvedRoute, sessionKey: resolvedRoute.sessionKey };
}

export function buildInboundAcceptedLifecycleDebugInfo(args: {
  stage: 'accepted';
  bridge: string;
  accountId: string;
  connId: string;
  clientId?: string;
  outboundReady: boolean;
  preferredForOutbound: boolean;
  inboundOnly: boolean;
  onlineAfterSeen: boolean;
  recentInboundReachable: boolean;
  activeConnectionKey: string | null;
  activeConnections: Array<{
    connId: string;
    clientId?: string;
    connectedAt: number;
    lastSeenAt: number;
  }>;
}) {
  return {
    stage: args.stage,
    bridge: args.bridge,
    accountId: args.accountId,
    connId: args.connId,
    clientId: args.clientId,
    outboundReady: args.outboundReady,
    preferredForOutbound: args.preferredForOutbound,
    inboundOnly: args.inboundOnly,
    onlineAfterSeen: args.onlineAfterSeen,
    recentInboundReachable: args.recentInboundReachable,
    activeConnectionKey: args.activeConnectionKey,
    activeConnections: args.activeConnections,
  };
}

export function resolveInboundSessionContext(args: {
  cfg: BncrChannelConfigRoot;
  accountId: string;
  peer: { kind: string } & Record<string, unknown>;
  route: BncrRoute;
  sessionKeyFromRoute?: string;
  canonicalAgentId: string;
  resolvedAgentId?: string;
  taskKey?: string;
  text: string;
  extractedText?: string;
  asString: (value: unknown, fallback?: string) => string;
  resolveAgentRoute: (params: {
    cfg: BncrChannelConfigRoot;
    channel: string;
    accountId: string;
    peer: unknown;
  }) => OpenClawResolvedAgentRoute;
}) {
  const resolvedRoute = assertResolvedSessionKey(
    args.resolveAgentRoute({
      cfg: args.cfg,
      channel: CHANNEL_ID,
      accountId: args.accountId,
      peer: args.peer,
    }),
  );
  const normalizedAgentId =
    (args.resolvedAgentId || '').trim() || resolvedRoute.agentId || args.canonicalAgentId;
  const baseSessionKey =
    normalizeInboundSessionKey(
      args.sessionKeyFromRoute || '',
      args.route,
      normalizedAgentId || '',
    ) || resolvedRoute.sessionKey;
  const taskSessionKey = withTaskSessionKey(baseSessionKey, args.taskKey);
  return {
    resolvedRoute: {
      ...resolvedRoute,
      agentId: normalizedAgentId || resolvedRoute.agentId,
      sessionKey: baseSessionKey || resolvedRoute.sessionKey,
    },
    baseSessionKey,
    taskSessionKey,
    sessionKey: taskSessionKey || baseSessionKey,
    inboundText: args.asString(args.extractedText || args.text || ''),
  };
}

export function buildInboundResponsePayload(
  args:
    | { kind: 'stale-ignored'; accountId: string; msgId?: string | null }
    | { kind: 'invalid-peer' }
    | { kind: 'duplicated'; accountId: string; msgId?: string | null }
    | { kind: 'gate-denied'; accountId: string; msgId?: string | null; reason: string }
    | {
        kind: 'accepted';
        accountId: string;
        sessionKey: string;
        msgId?: string | null;
        taskKey?: string | null;
      }
    | { kind: 'invalid-session'; accountId: string; msgId?: string | null },
) {
  switch (args.kind) {
    case 'stale-ignored':
      return {
        accepted: false,
        stale: true,
        ignored: true,
        accountId: args.accountId,
        msgId: args.msgId ?? null,
      };
    case 'invalid-peer':
      return { error: 'platform/groupId/userId required' };
    case 'duplicated':
      return {
        accepted: true,
        duplicated: true,
        accountId: args.accountId,
        msgId: args.msgId ?? null,
      };
    case 'gate-denied':
      return {
        accepted: false,
        accountId: args.accountId,
        msgId: args.msgId ?? null,
        reason: args.reason,
      };
    case 'accepted':
      return {
        accepted: true,
        accountId: args.accountId,
        sessionKey: args.sessionKey,
        msgId: args.msgId ?? null,
        taskKey: args.taskKey ?? null,
      };
    case 'invalid-session':
      return {
        accepted: false,
        accountId: args.accountId,
        invalidSession: true,
        msgId: args.msgId ?? null,
      };
  }
}
