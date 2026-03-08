function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

function asList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x).trim()).filter(Boolean);
}

export function resolveBncrChannelPolicy(channelCfg: any) {
  return {
    enabled: channelCfg?.enabled !== false,
    dmPolicy: asString(channelCfg?.dmPolicy || 'open').toLowerCase(),
    groupPolicy: asString(channelCfg?.groupPolicy || 'open').toLowerCase(),
    allowFrom: asList(channelCfg?.allowFrom),
    groupAllowFrom: asList(channelCfg?.groupAllowFrom),
    requireMention: channelCfg?.requireMention === true,
  };
}
