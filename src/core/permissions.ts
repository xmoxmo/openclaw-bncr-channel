function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

export function getBncrElevatedConfig(rootCfg: any) {
  const elevated = rootCfg?.tools?.elevated || {};
  const allowFrom = elevated?.allowFrom || {};
  const bncrRules = Array.isArray(allowFrom?.bncr)
    ? allowFrom.bncr.map((x: unknown) => asString(x).trim()).filter(Boolean)
    : [];

  return {
    enabled: elevated?.enabled === true,
    bncrAllowed: bncrRules.length > 0,
    bncrRules,
  };
}

export function buildBncrPermissionSummary(rootCfg: any) {
  const elevated = getBncrElevatedConfig(rootCfg);
  return {
    elevatedEnabled: elevated.enabled,
    bncrElevatedAllowed: elevated.bncrAllowed,
    bncrElevatedRules: elevated.bncrRules,
    note: elevated.bncrAllowed
      ? 'bncr can request elevated operations; final execution may still be gated by approvals policy'
      : 'bncr elevated not explicitly allowed',
  };
}
