import type { ChatType } from 'openclaw/plugin-sdk/core';
import { BNCR_DEFAULT_ACCOUNT_ID, normalizeAccountId } from '../core/accounts.ts';
import { formatDisplayScope, parseExplicitTarget } from '../core/targets.ts';
import type { BncrRoute } from '../core/types.ts';
import { asSanitizedString } from '../core/value-sanitize.ts';
import { resolveBncrOutboundSessionRoute } from '../messaging/outbound/session-route.ts';
import {
  looksLikeBncrExplicitTarget,
  resolveBncrOutboundTarget,
} from '../messaging/outbound/target-resolver.ts';
import type { BncrChannelConfigRoot } from './channel-runtime-types.ts';

function formatBncrHumanDisplay(route: BncrRoute): string {
  const platform = asSanitizedString(route?.platform).trim();
  const groupId = asSanitizedString(route?.groupId).trim();
  const userId = asSanitizedString(route?.userId).trim();
  if (platform && groupId && groupId !== '0') return `Bncr:${platform}:Group:${groupId}`;
  if (platform && userId && userId !== '0') return `Bncr:${platform}:User:${userId}`;
  return formatDisplayScope(route);
}

type BncrMessagingRuntimeBridge = {
  canonicalAgentId?: string;
  ensureCanonicalAgentId: (params: { cfg: BncrChannelConfigRoot; accountId: string }) => string;
  resolveRouteBySession: (raw: string, accountId: string) => BncrRoute | null;
};

type BncrMessagingTargetDisplayInput = {
  target?:
    | string
    | {
        displayScope?: string;
        to?: string;
        platform?: string;
        groupId?: string;
        userId?: string;
      }
    | null;
  display?: string;
  kind?: string;
};

type BncrMessagingExplicitTargetArgs = { raw: string };

type BncrMessagingSessionTargetArgs = {
  kind?: 'group' | 'channel' | string;
  id: string;
  threadId?: string | null;
};

type BncrMessagingOutboundSessionRouteArgs = {
  agentId: string;
  target: string;
  resolvedTarget?: { to?: string } | null;
  currentSessionKey?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  accountId?: string | null;
  cfg: BncrChannelConfigRoot;
};

type BncrMessagingResolveTargetArgs = {
  accountId?: string | null;
  input?: string;
  normalized?: string;
  preferredKind?: string;
};

function isDisplayTarget(
  value: unknown,
): value is Exclude<NonNullable<BncrMessagingTargetDisplayInput['target']>, string> {
  return Boolean(value && typeof value === 'object');
}

export function normalizeBncrMessagingTarget(raw: string) {
  const input = asSanitizedString(raw).trim();
  return input || undefined;
}

export function formatBncrMessagingTargetDisplay({ target }: BncrMessagingTargetDisplayInput) {
  if (typeof target === 'string') {
    const parsed = parseExplicitTarget(asSanitizedString(target).trim());
    return parsed?.route ? formatBncrHumanDisplay(parsed.route) : asSanitizedString(target).trim();
  }
  if (!isDisplayTarget(target)) return '';
  const displayScope = asSanitizedString(target?.displayScope || target?.to).trim();
  if (displayScope) {
    const parsed = parseExplicitTarget(displayScope);
    if (parsed?.route) return formatBncrHumanDisplay(parsed.route);
    return displayScope;
  }
  if (target.platform || target.groupId || target.userId) {
    const route = {
      platform: asSanitizedString(target.platform).trim(),
      groupId: asSanitizedString(target.groupId).trim(),
      userId: asSanitizedString(target.userId).trim(),
    };
    return formatBncrHumanDisplay(route);
  }
  return '';
}

function resolveMessagingAccountId(accountId: unknown) {
  return normalizeAccountId(asSanitizedString(accountId || BNCR_DEFAULT_ACCOUNT_ID));
}

function resolveMessagingCanonicalAgentId(
  runtimeBridge: BncrMessagingRuntimeBridge,
  cfg: BncrChannelConfigRoot,
  accountId: string,
) {
  return runtimeBridge.canonicalAgentId || runtimeBridge.ensureCanonicalAgentId({ cfg, accountId });
}

export function createBncrMessagingExplicitTargetParser(
  getBridge: () => BncrMessagingRuntimeBridge,
) {
  return ({ raw }: BncrMessagingExplicitTargetArgs) => {
    const runtimeBridge = getBridge();
    const canonicalAgentId = runtimeBridge.canonicalAgentId || 'main';
    const parsed = parseExplicitTarget(asSanitizedString(raw).trim(), { canonicalAgentId });
    if (!parsed) return null;
    const chatType: ChatType = parsed.route?.groupId ? 'group' : 'direct';
    return {
      to: parsed.displayScope,
      displayScope: parsed.displayScope,
      threadId: undefined,
      chatType,
    };
  };
}

export function createBncrMessagingSessionTargetResolver(
  getBridge: () => BncrMessagingRuntimeBridge,
) {
  return ({ id }: BncrMessagingSessionTargetArgs) => {
    const raw = asSanitizedString(id).trim();
    if (!raw) return undefined;
    const runtimeBridge = getBridge();
    const canonicalAgentId = runtimeBridge.canonicalAgentId || 'main';

    const parsed = parseExplicitTarget(raw, { canonicalAgentId });
    if (!parsed) {
      return raw || undefined;
    }
    return parsed?.displayScope || undefined;
  };
}

export function createBncrMessagingOutboundSessionRouteResolver(
  getBridge: () => BncrMessagingRuntimeBridge,
) {
  return (params: BncrMessagingOutboundSessionRouteArgs) => {
    const accountId = resolveMessagingAccountId(params?.accountId);
    const runtimeBridge = getBridge();
    const canonicalAgentId = resolveMessagingCanonicalAgentId(
      runtimeBridge,
      params?.cfg,
      accountId,
    );
    return resolveBncrOutboundSessionRoute({
      channel: 'bncr',
      cfg: params.cfg,
      agentId: params.agentId,
      accountId: params.accountId ?? undefined,
      target: params.target,
      resolvedTarget: params.resolvedTarget,
      threadId:
        params.threadId === null || params.threadId === undefined
          ? undefined
          : asSanitizedString(params.threadId),
      canonicalAgentId,
      resolveRouteBySession: (raw: string, acc: string) =>
        runtimeBridge.resolveRouteBySession(raw, acc),
    });
  };
}

export function createBncrMessagingSurface(getBridge: () => BncrMessagingRuntimeBridge) {
  return {
    // 接收任意标签输入；不在 normalize 阶段做格式门槛，统一下沉到发送前验证。
    normalizeTarget: normalizeBncrMessagingTarget,
    parseExplicitTarget: createBncrMessagingExplicitTargetParser(getBridge),
    formatTargetDisplay: formatBncrMessagingTargetDisplay,
    resolveSessionTarget: createBncrMessagingSessionTargetResolver(getBridge),
    resolveOutboundSessionRoute: createBncrMessagingOutboundSessionRouteResolver(getBridge),
    targetResolver: createBncrMessagingTargetResolver(getBridge),
  };
}

export function createBncrMessagingTargetResolver(getBridge: () => BncrMessagingRuntimeBridge) {
  return {
    looksLikeId: (raw: string, normalized?: string) => {
      return looksLikeBncrExplicitTarget(asSanitizedString(normalized || raw).trim());
    },
    resolveTarget: async ({ accountId, input, normalized }: BncrMessagingResolveTargetArgs) => {
      const runtimeBridge = getBridge();
      const resolved = resolveBncrOutboundTarget({
        target: asSanitizedString(normalized || input).trim(),
        accountId: resolveMessagingAccountId(accountId),
        resolveRouteBySession: (raw: string, acc: string) =>
          runtimeBridge.resolveRouteBySession(raw, acc),
      });
      if (!resolved) return null;
      return {
        to: resolved.displayScope,
        kind: resolved.kind,
        display: formatBncrHumanDisplay(resolved.route),
        source: 'normalized' as const,
      };
    },
    hint: 'Standard to=Bncr:<platform>:<group>:<user> or Bncr:<platform>:<user>; sessionKey keeps existing strict/legacy compatibility, canonical sessionKey=agent:<agentId>:bncr:direct:<hex>',
  };
}
