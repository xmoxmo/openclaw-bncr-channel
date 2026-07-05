import { normalizeAccountId } from '../../core/accounts.ts';
import type { BncrInboundConfig, BncrInboundParamsInput } from './contracts.ts';

export type BncrGateResult = { allowed: true } | { allowed: false; reason: string };

const REQUIRED_PROTOCOL_VERSION = 'scene-routing-v1';
const REQUIRED_CAPABILITY = 'scene-routing-v1';

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

function asBoolean(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const raw = v.trim().toLowerCase();
    if (!raw) return fallback;
    if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;
  }
  return fallback;
}

function asCapabilities(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((item) => asString(item).trim()).filter(Boolean);
  }
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export async function checkBncrMessageGate(params: {
  parsed: BncrInboundParamsInput & {
    route?: Partial<{ groupId: string; userId: string; platform: string }>;
  };
  cfg: BncrInboundConfig;
  account: { accountId: string; enabled?: boolean };
}): Promise<BncrGateResult> {
  const { parsed, cfg, account } = params;
  const accountId = normalizeAccountId(account?.accountId);
  const channelCfg = cfg?.channels?.bncr || {};
  const accountCfg = channelCfg?.accounts?.[accountId] || {};
  if (
    channelCfg?.enabled === false ||
    account?.enabled === false ||
    accountCfg?.enabled === false
  ) {
    return { allowed: false, reason: 'account disabled' };
  }

  const protocolVersion = asString(parsed?.protocolVersion || '').trim();
  const capabilities = asCapabilities(parsed?.capabilities);
  if (
    protocolVersion !== REQUIRED_PROTOCOL_VERSION ||
    !capabilities.includes(REQUIRED_CAPABILITY)
  ) {
    return { allowed: false, reason: 'client protocol outdated' };
  }

  const platform = asString(parsed?.platform || '').trim();
  const userId = asString(parsed?.userId || '').trim();
  const clientId = asString(parsed?.clientId || '').trim();
  const groupId = asString(parsed?.groupId || '').trim();
  const isGroupProvided = parsed && Object.hasOwn(parsed, 'isGroup');
  const isAdminProvided = parsed && Object.hasOwn(parsed, 'isAdmin');
  const isGroup = asBoolean(parsed?.isGroup, false);
  if (!platform || !userId || !clientId || !isGroupProvided || !isAdminProvided) {
    return { allowed: false, reason: 'inbound schema incomplete' };
  }
  if (isGroup && !groupId) {
    return { allowed: false, reason: 'inbound schema incomplete' };
  }

  const route = parsed?.route;
  if (!route?.platform || !route?.groupId || !route?.userId) {
    return { allowed: false, reason: 'invalid route' };
  }
  return { allowed: true };
}
