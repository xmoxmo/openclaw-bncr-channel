import { normalizeAccountId } from '../../core/accounts.js';
import { resolveBncrChannelPolicy } from '../../core/policy.js';
import { formatDisplayScope } from '../../core/targets.js';

export type BncrGateResult =
  | { allowed: true }
  | { allowed: false; reason: string };

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

function matchesAllowList(list: string[], candidates: string[]): boolean {
  if (!list.length) return false;
  const normalized = new Set(list.map((x) => x.toLowerCase()));
  return candidates.some((x) => normalized.has(asString(x).toLowerCase()));
}

export function checkBncrMessageGate(params: {
  parsed: any;
  cfg: any;
  account: { accountId: string; enabled?: boolean };
}): BncrGateResult {
  const { parsed, cfg, account } = params;
  const accountId = normalizeAccountId(account?.accountId);
  const channelCfg = cfg?.channels?.bncr || {};
  const accountCfg = channelCfg?.accounts?.[accountId] || {};
  const policy = resolveBncrChannelPolicy(channelCfg);

  if (policy.enabled === false || account?.enabled === false || accountCfg?.enabled === false) {
    return { allowed: false, reason: 'account disabled' };
  }

  const route = parsed?.route;
  const isGroup = asString(route?.groupId || '0') !== '0';

  if (!isGroup && policy.dmPolicy === 'disabled') {
    return { allowed: false, reason: 'dm disabled' };
  }

  if (isGroup && policy.groupPolicy === 'disabled') {
    return { allowed: false, reason: 'group disabled' };
  }

  const candidates = [
    formatDisplayScope(route),
    `${route?.platform}:${route?.groupId}:${route?.userId}`,
    `${route?.platform}:${route?.userId}`,
    `${route?.userId}`,
  ].filter(Boolean);

  if (!isGroup && policy.dmPolicy === 'allowlist') {
    if (!matchesAllowList(policy.allowFrom, candidates)) {
      return { allowed: false, reason: 'dm allowlist blocked' };
    }
  }

  if (isGroup && policy.groupPolicy === 'allowlist') {
    if (!matchesAllowList(policy.groupAllowFrom, candidates)) {
      return { allowed: false, reason: 'group allowlist blocked' };
    }
  }

  // requireMention 当前仅保留为待实现配置位。
  // 现阶段 parse 层尚未稳定提取 mentions，上游客户端也未统一透传 mention 信号，
  // 因此这里先不做实际拦截，避免表现成“看似开启但行为不稳定”的半实现状态。
  return { allowed: true };
}
