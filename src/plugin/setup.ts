import { CHANNEL_ID } from '../core/accounts.ts';
import { applyOpenClawAccountNameToChannelSection } from '../openclaw/sdk-helpers.ts';

type BncrSetupAccountConfig = {
  enabled?: boolean;
  name?: string;
} & Record<string, unknown>;

type BncrSetupChannelConfig = {
  accounts?: Record<string, BncrSetupAccountConfig>;
} & Record<string, unknown>;

type BncrSetupRootConfig = {
  channels?: Record<string, unknown> & {
    [CHANNEL_ID]?: BncrSetupChannelConfig;
  };
};

type BncrApplyAccountNameArgs = {
  cfg: BncrSetupRootConfig;
  accountId: string;
  name?: string;
};

type BncrApplyAccountConfigArgs = {
  cfg: BncrSetupRootConfig | null | undefined;
  accountId: string;
};

export const BNCR_SETUP_SURFACE = {
  applyAccountName: ({ cfg, accountId, name }: BncrApplyAccountNameArgs) =>
    applyOpenClawAccountNameToChannelSection({
      cfg,
      channelKey: CHANNEL_ID,
      accountId,
      name,
      alwaysUseAccounts: true,
    }),
  applyAccountConfig: ({ cfg, accountId }: BncrApplyAccountConfigArgs) => {
    const next: BncrSetupRootConfig = { ...(cfg || {}) };
    next.channels = next.channels || {};
    next.channels[CHANNEL_ID] = next.channels[CHANNEL_ID] || {};
    const channelCfg = next.channels[CHANNEL_ID] as BncrSetupChannelConfig;
    channelCfg.accounts = channelCfg.accounts || {};
    channelCfg.accounts[accountId] = {
      ...(channelCfg.accounts[accountId] || {}),
      enabled: true,
    };
    return next;
  },
};
