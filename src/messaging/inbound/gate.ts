import { normalizeAccountId } from '../../core/accounts.ts';
import { resolveBncrChannelPolicy } from '../../core/policy.ts';
import { buildDisplayScopeCandidates } from '../../core/targets.ts';

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
  const normalized = new Set(list.map((x) => asString(x).trim()).filter(Boolean));
  return candidates.some((x) => normalized.has(asString(x).trim()));
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

  const candidates = buildDisplayScopeCandidates(route);

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

  // requireMention 默认值为 false。
  // 设计目标：当它未来真正生效时，含义是“群消息只有在明确提到机器人时才允许进入处理链”。
  // 但当前 parse 层尚未稳定提取 mentions，上游客户端也未统一透传 mention 信号，
  // 因此现阶段即使配置为 true，也仍不做实际拦截，避免出现半实现状态。
  return { allowed: true };
}
