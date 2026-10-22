import { asBoolean, asString } from './value-sanitize.ts';

export type BncrChannelPolicyConfig = {
  enabled?: boolean;
  allowFrom?: unknown;
  allowBridgeCall?: unknown;
};

function asList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x).trim()).filter(Boolean);
}

export function resolveBncrChannelPolicy(channelCfg: BncrChannelPolicyConfig | null | undefined) {
  return {
    enabled: channelCfg?.enabled !== false,
    // Owner/pairing list consumed by the host surface. It is not an inbound
    // admission list; private-chat admission is owned by the scene registry.
    allowFrom: asList(channelCfg?.allowFrom),
    allowBridgeCall: asBoolean(channelCfg?.allowBridgeCall, true),
  };
}

export function resolveBncrConfigWarnings(
  channelCfg: BncrChannelPolicyConfig | null | undefined,
): string[] {
  const warnings: string[] = [];
  const raw = (channelCfg || {}) as Record<string, unknown>;
  const legacy = ['dmPolicy', 'groupPolicy', 'groupAllowFrom'].filter(
    (key) => raw[key] !== undefined,
  );
  if (legacy.length > 0) {
    warnings.push(
      `ignored legacy policy field(s): ${legacy.join(', ')}; Bncr admission uses scene status`,
    );
  }
  return warnings;
}
