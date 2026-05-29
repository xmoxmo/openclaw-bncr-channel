import { normalizeAccountId } from '../../core/accounts.ts';
import { resolveBncrChannelPolicy } from '../../core/policy.ts';
import { buildDisplayScopeCandidates } from '../../core/targets.ts';
import {
  defineOpenClawStableChannelIngressIdentity,
  resolveOpenClawChannelMessageIngress,
} from '../../openclaw/ingress-runtime.ts';

export type BncrGateResult = { allowed: true } | { allowed: false; reason: string };

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

const bncrIngressIdentity = defineOpenClawStableChannelIngressIdentity({
  key: 'displayScope',
  kind: 'plugin:bncr-display-scope',
  normalize: (value: string) => asString(value).trim() || null,
  sensitivity: 'pii',
  entryIdPrefix: 'bncr-allow',
  aliases: [
    {
      key: 'routeKey',
      kind: 'plugin:bncr-route-key',
      normalize: (value: string) => asString(value).trim() || null,
      sensitivity: 'pii',
    },
  ],
});

function gateReasonFromIngress(reasonCode?: string): string {
  switch (reasonCode) {
    case 'dm_policy_disabled':
      return 'dm disabled';
    case 'dm_policy_not_allowlisted':
    case 'dm_policy_pairing_required':
      return 'dm allowlist blocked';
    case 'group_policy_disabled':
      return 'group disabled';
    case 'group_policy_not_allowlisted':
    case 'group_policy_empty_allowlist':
      return 'group allowlist blocked';
    default:
      return reasonCode || 'ingress blocked';
  }
}

export async function checkBncrMessageGate(params: {
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

  const candidates = buildDisplayScopeCandidates(route);
  const displayScope = candidates[0] || '';
  const routeKey = candidates.find((candidate) => candidate !== displayScope) || displayScope;

  // requireMention 默认值为 false。
  // 设计目标：当它未来真正生效时，含义是“群消息只有在明确提到机器人时才允许进入处理链”。
  // 但当前 parse 层尚未稳定提取 mentions，上游客户端也未统一透传 mention 信号，
  // 因此现阶段即使配置为 true，也仍不做实际拦截，避免出现半实现状态。
  const resolved = await resolveOpenClawChannelMessageIngress({
    channelId: 'bncr',
    accountId,
    identity: bncrIngressIdentity,
    subject: {
      stableId: displayScope,
      aliases: { routeKey },
    },
    conversation: {
      kind: isGroup ? 'group' : 'direct',
      id: isGroup ? asString(route?.groupId) : asString(route?.userId || displayScope),
    },
    event: { kind: 'message', authMode: 'inbound', mayPair: !isGroup },
    policy: {
      dmPolicy: policy.dmPolicy,
      groupPolicy: policy.groupPolicy,
      groupAllowFromFallbackToAllowFrom: false,
    },
    allowFrom: policy.dmPolicy === 'open' ? ['*', ...policy.allowFrom] : policy.allowFrom,
    groupAllowFrom: policy.groupAllowFrom,
    accessGroups: cfg?.accessGroups,
  });

  if (resolved.ingress.admission === 'dispatch' || resolved.ingress.admission === 'observe') {
    return { allowed: true };
  }

  return { allowed: false, reason: gateReasonFromIngress(resolved.ingress.reasonCode) };
}
