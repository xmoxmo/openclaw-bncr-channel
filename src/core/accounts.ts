const CHANNEL_ID = 'bncr';
const BNCR_DEFAULT_ACCOUNT_ID = 'Primary';

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

export function normalizeAccountId(accountId?: string | null): string {
  const v = asString(accountId || '').trim();
  if (!v) return BNCR_DEFAULT_ACCOUNT_ID;
  const lower = v.toLowerCase();
  if (lower === 'default' || lower === 'primary') return BNCR_DEFAULT_ACCOUNT_ID;
  return v;
}

export function resolveDefaultDisplayName(rawName: unknown, accountId: string): string {
  const raw = asString(rawName || '').trim();
  if (
    !raw ||
    raw === accountId ||
    /^bncr$/i.test(raw) ||
    /^status$/i.test(raw) ||
    /^runtime$/i.test(raw)
  ) {
    return 'Monitor';
  }
  return raw;
}

export function resolveAccount(cfg: any, accountId?: string | null) {
  const accounts = cfg?.channels?.[CHANNEL_ID]?.accounts || {};
  let key = normalizeAccountId(accountId);

  if (!accounts[key]) {
    const first = Object.keys(accounts)[0];
    if (first) key = first;
  }

  const account = accounts[key] || {};
  const displayName = resolveDefaultDisplayName(account?.name, key);

  return {
    accountId: key,
    name: displayName,
    enabled: account?.enabled !== false,
  };
}

export function listAccountIds(cfg: any): string[] {
  const ids = Object.keys(cfg?.channels?.[CHANNEL_ID]?.accounts || {});
  return ids.length ? ids : [BNCR_DEFAULT_ACCOUNT_ID];
}

export { CHANNEL_ID, BNCR_DEFAULT_ACCOUNT_ID };
