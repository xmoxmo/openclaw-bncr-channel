import {
  CHANNEL_ID,
  listAccountIds,
  resolveAccount,
  resolveDefaultDisplayName,
} from '../core/accounts.ts';
import { resolveBncrChannelPolicy } from '../core/policy.ts';
import { setOpenClawAccountEnabledInConfigSection } from '../openclaw/sdk-helpers.ts';

// 临时提权集合：非管理员用户执行原生命令时动态注入，命令完成后移除
const pendingNativeElevation = new Set<string>();

export function addNativeElevation(senderId: string): void {
  if (senderId) pendingNativeElevation.add(senderId);
}

export function removeNativeElevation(senderId: string): void {
  if (senderId) pendingNativeElevation.delete(senderId);
}

type BncrConfigSurfaceRoot = {
  channels?: {
    [CHANNEL_ID]?: {
      enabled?: boolean;
      accounts?: Record<string, unknown>;
    } & Record<string, unknown>;
  } & Record<string, unknown>;
};

type BncrConfigSurfaceAccount = {
  accountId: string;
  name?: unknown;
  enabled?: boolean;
};

type BncrSetAccountEnabledArgs = {
  cfg: BncrConfigSurfaceRoot;
  accountId: string;
  enabled: boolean;
};

export const BNCR_CONFIG_SURFACE = {
  listAccountIds,
  resolveAccount,
  setAccountEnabled: ({ cfg, accountId, enabled }: BncrSetAccountEnabledArgs) =>
    setOpenClawAccountEnabledInConfigSection({
      cfg,
      sectionKey: CHANNEL_ID,
      accountId,
      enabled,
      allowTopLevel: true,
    }),
  isEnabled: (account: BncrConfigSurfaceAccount, cfg: BncrConfigSurfaceRoot) => {
    const policy = resolveBncrChannelPolicy(cfg?.channels?.[CHANNEL_ID] || {});
    return policy.enabled !== false && account?.enabled !== false;
  },
  isConfigured: () => true,
  describeAccount: (account: BncrConfigSurfaceAccount) => {
    const displayName = resolveDefaultDisplayName(account?.name, account?.accountId);
    return {
      accountId: account.accountId,
      name: displayName,
      enabled: account.enabled !== false,
      configured: true,
    };
  },
  resolveAllowFrom: ({ cfg }: { cfg: BncrConfigSurfaceRoot; accountId?: string | null }) => {
    const policy = resolveBncrChannelPolicy(cfg?.channels?.[CHANNEL_ID] || {});
    const base = policy.allowFrom;
    if (pendingNativeElevation.size === 0) return base.length ? base : undefined;
    const merged = [...base, ...pendingNativeElevation];
    return merged.length ? merged : undefined;
  },
};
