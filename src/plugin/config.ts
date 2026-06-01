import {
  CHANNEL_ID,
  listAccountIds,
  resolveAccount,
  resolveDefaultDisplayName,
} from '../core/accounts.ts';
import { resolveBncrChannelPolicy } from '../core/policy.ts';
import { setOpenClawAccountEnabledInConfigSection } from '../openclaw/sdk-helpers.ts';

export const BNCR_CONFIG_SURFACE = {
  listAccountIds,
  resolveAccount,
  setAccountEnabled: ({ cfg, accountId, enabled }: any) =>
    setOpenClawAccountEnabledInConfigSection({
      cfg,
      sectionKey: CHANNEL_ID,
      accountId,
      enabled,
      allowTopLevel: true,
    }),
  isEnabled: (account: any, cfg: any) => {
    const policy = resolveBncrChannelPolicy(cfg?.channels?.[CHANNEL_ID] || {});
    return policy.enabled !== false && account?.enabled !== false;
  },
  isConfigured: () => true,
  describeAccount: (account: any) => {
    const displayName = resolveDefaultDisplayName(account?.name, account?.accountId);
    return {
      accountId: account.accountId,
      name: displayName,
      enabled: account.enabled !== false,
      configured: true,
    };
  },
};
