import { CHANNEL_ID } from '../core/accounts.ts';
import { applyOpenClawAccountNameToChannelSection } from '../openclaw/sdk-helpers.ts';

export const BNCR_SETUP_SURFACE = {
  applyAccountName: ({ cfg, accountId, name }: any) =>
    applyOpenClawAccountNameToChannelSection({
      cfg,
      channelKey: CHANNEL_ID,
      accountId,
      name,
      alwaysUseAccounts: true,
    }),
  applyAccountConfig: ({ cfg, accountId }: any) => {
    const next = { ...(cfg || {}) } as any;
    next.channels = next.channels || {};
    next.channels[CHANNEL_ID] = next.channels[CHANNEL_ID] || {};
    next.channels[CHANNEL_ID].accounts = next.channels[CHANNEL_ID].accounts || {};
    next.channels[CHANNEL_ID].accounts[accountId] = {
      ...(next.channels[CHANNEL_ID].accounts[accountId] || {}),
      enabled: true,
    };
    return next;
  },
};
