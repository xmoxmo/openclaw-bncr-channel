import { BNCR_DEFAULT_ACCOUNT_ID, normalizeAccountId } from '../core/accounts.ts';
import {
  formatDisplayScope,
  formatTargetDisplay,
  parseExplicitTarget,
} from '../core/targets.ts';
import { resolveBncrOutboundSessionRoute } from '../messaging/outbound/session-route.ts';
import {
  looksLikeBncrExplicitTarget,
  resolveBncrOutboundTarget,
} from '../messaging/outbound/target-resolver.ts';

type BncrMessagingRuntimeBridge = {
  canonicalAgentId?: string;
  ensureCanonicalAgentId: (params: { cfg: any; accountId: string }) => string;
  resolveRouteBySession: (raw: string, accountId: string) => any;
};

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function normalizeBncrMessagingTarget(raw: string) {
  const input = asString(raw).trim();
  return input || undefined;
}

export function formatBncrMessagingTargetDisplay({ target }: any) {
  return formatTargetDisplay(target);
}

function resolveMessagingAccountId(accountId: unknown) {
  return normalizeAccountId(asString(accountId || BNCR_DEFAULT_ACCOUNT_ID));
}

function resolveMessagingCanonicalAgentId(
  runtimeBridge: BncrMessagingRuntimeBridge,
  cfg: any,
  accountId: string,
) {
  return (
    runtimeBridge.canonicalAgentId ||
    runtimeBridge.ensureCanonicalAgentId({ cfg, accountId })
  );
}

export function createBncrMessagingExplicitTargetParser(
  getBridge: () => BncrMessagingRuntimeBridge,
) {
  return ({ raw, accountId, cfg }: any) => {
    const resolvedAccountId = resolveMessagingAccountId(accountId);
    const runtimeBridge = getBridge();
    const canonicalAgentId = resolveMessagingCanonicalAgentId(
      runtimeBridge,
      cfg,
      resolvedAccountId,
    );
    return parseExplicitTarget(asString(raw).trim(), { canonicalAgentId });
  };
}

export function createBncrMessagingSessionTargetResolver(
  getBridge: () => BncrMessagingRuntimeBridge,
) {
  return ({ id, accountId, cfg }: any) => {
    const raw = asString(id).trim();
    if (!raw) return undefined;
    const resolvedAccountId = resolveMessagingAccountId(accountId);
    const runtimeBridge = getBridge();
    const canonicalAgentId = resolveMessagingCanonicalAgentId(
      runtimeBridge,
      cfg,
      resolvedAccountId,
    );

    let parsed = parseExplicitTarget(raw, { canonicalAgentId });
    if (!parsed) {
      const route = runtimeBridge.resolveRouteBySession(raw, resolvedAccountId);
      if (route) {
        parsed = parseExplicitTarget(formatDisplayScope(route), { canonicalAgentId });
      }
    }
    return parsed?.displayScope || undefined;
  };
}

export function createBncrMessagingOutboundSessionRouteResolver(
  getBridge: () => BncrMessagingRuntimeBridge,
) {
  return (params: any) => {
    const accountId = resolveMessagingAccountId(params?.accountId);
    const runtimeBridge = getBridge();
    const canonicalAgentId = resolveMessagingCanonicalAgentId(
      runtimeBridge,
      params?.cfg,
      accountId,
    );
    return resolveBncrOutboundSessionRoute({
      ...params,
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
      return looksLikeBncrExplicitTarget(asString(normalized || raw).trim());
    },
    resolveTarget: async ({ accountId, input, normalized }: any) => {
      const runtimeBridge = getBridge();
      const resolved = resolveBncrOutboundTarget({
        target: asString(normalized || input).trim(),
        accountId: resolveMessagingAccountId(accountId),
        resolveRouteBySession: (raw: string, acc: string) =>
          runtimeBridge.resolveRouteBySession(raw, acc),
      });
      if (!resolved) return null;
      return {
        to: resolved.displayScope,
        kind: resolved.kind,
        display: resolved.displayScope,
        source: 'normalized' as const,
      };
    },
    hint: 'Standard to=Bncr:<platform>:<group>:<user> or Bncr:<platform>:<user>; sessionKey keeps existing strict/legacy compatibility, canonical sessionKey=agent:<agentId>:bncr:direct:<hex>',
  };
}
