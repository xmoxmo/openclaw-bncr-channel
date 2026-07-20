import { asBoolean, asString } from './value-sanitize.ts';

export type BncrChannelPolicyConfig = {
  enabled?: boolean;
  dmPolicy?: unknown;
  groupPolicy?: unknown;
  allowFrom?: unknown;
  groupAllowFrom?: unknown;
  requireMention?: unknown;
};

export type BncrDmPolicy = 'open' | 'allowlist' | 'disabled' | 'pairing';
export type BncrGroupPolicy = 'open' | 'allowlist' | 'disabled';

function asList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x).trim()).filter(Boolean);
}

function normalizeDmPolicy(value: unknown): BncrDmPolicy {
  const normalized = asString(value || 'open')
    .trim()
    .toLowerCase();
  switch (normalized) {
    case 'allowlist':
    case 'disabled':
    case 'pairing':
      return normalized;
    default:
      return 'open';
  }
}

function normalizeGroupPolicy(value: unknown): BncrGroupPolicy {
  const normalized = asString(value || 'open')
    .trim()
    .toLowerCase();
  switch (normalized) {
    case 'allowlist':
    case 'disabled':
      return normalized;
    default:
      return 'open';
  }
}

export function resolveBncrChannelPolicy(channelCfg: BncrChannelPolicyConfig | null | undefined) {
  return {
    enabled: channelCfg?.enabled !== false,
    dmPolicy: normalizeDmPolicy(channelCfg?.dmPolicy),
    groupPolicy: normalizeGroupPolicy(channelCfg?.groupPolicy),
    allowFrom: asList(channelCfg?.allowFrom),
    groupAllowFrom: asList(channelCfg?.groupAllowFrom),
    requireMention: asBoolean(channelCfg?.requireMention, false),
  };
}

export function resolveBncrConfigWarnings(
  channelCfg: BncrChannelPolicyConfig | null | undefined,
): string[] {
  const policy = resolveBncrChannelPolicy(channelCfg || {});
  const warnings: string[] = [];
  if (policy.requireMention) {
    warnings.push('requireMention configured but not enforced yet');
  }
  return warnings;
}
