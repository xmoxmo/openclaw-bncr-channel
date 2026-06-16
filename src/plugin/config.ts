import {
  CHANNEL_ID,
  listAccountIds,
  resolveAccount,
  resolveDefaultDisplayName,
} from '../core/accounts.ts';
import { resolveBncrChannelPolicy } from '../core/policy.ts';
import { setOpenClawAccountEnabledInConfigSection } from '../openclaw/sdk-helpers.ts';

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
};
