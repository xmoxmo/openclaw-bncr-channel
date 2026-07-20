import type {
  BncrAccountConfig,
  BncrChannelConfigRoot,
  BncrChannelConfigSection,
} from '../plugin/channel-runtime-types.ts';
import { asString } from './value-sanitize.ts';

const CHANNEL_ID = 'bncr';
const BNCR_DEFAULT_ACCOUNT_ID = 'Primary';

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

function getChannelConfig(cfg: BncrChannelConfigRoot | null | undefined): BncrChannelConfigSection {
  return cfg?.channels?.[CHANNEL_ID] || {};
}

function getAccountsConfig(
  cfg: BncrChannelConfigRoot | null | undefined,
): Record<string, BncrAccountConfig | undefined> {
  return getChannelConfig(cfg).accounts || {};
}

export function resolveAccount(
  cfg: BncrChannelConfigRoot | null | undefined,
  accountId?: string | null,
) {
  const accounts = getAccountsConfig(cfg);
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

export function listAccountIds(cfg: BncrChannelConfigRoot | null | undefined): string[] {
  const ids = Object.keys(getAccountsConfig(cfg));
  return ids.length ? ids : [BNCR_DEFAULT_ACCOUNT_ID];
}

export { BNCR_DEFAULT_ACCOUNT_ID, CHANNEL_ID };
