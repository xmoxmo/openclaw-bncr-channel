import {
  BNCR_DEFAULT_ACCOUNT_ID,
  resolveAccount,
  resolveDefaultDisplayName,
} from '../core/accounts.ts';
import { buildAccountStatusSnapshot } from '../core/status.ts';
import { createOpenClawDefaultChannelRuntimeState } from '../openclaw/sdk-helpers.ts';

export type BncrStatusBridge = {
  getChannelSummary: (defaultAccountId: string) => unknown | Promise<unknown>;
  getAccountRuntimeSnapshot: (accountId?: string) => unknown;
  getStatusHeadline: (accountId?: string) => unknown;
};

export function createBncrStatusSurface(getBridge: () => BncrStatusBridge) {
  return {
    defaultRuntime: createOpenClawDefaultChannelRuntimeState(BNCR_DEFAULT_ACCOUNT_ID, {
      mode: 'ws-offline',
    }),
    buildChannelSummary: async ({ defaultAccountId }: any) => {
      return getBridge().getChannelSummary(defaultAccountId || BNCR_DEFAULT_ACCOUNT_ID);
    },
    buildAccountSnapshot: async ({ account, runtime }: any) => {
      const runtimeBridge = getBridge();
      const accountId = account?.accountId || BNCR_DEFAULT_ACCOUNT_ID;
      const snapshotAccount = {
        accountId,
        name: account?.name,
        enabled: account?.enabled,
      };
      const rt = runtime || runtimeBridge.getAccountRuntimeSnapshot(accountId);
      return buildAccountStatusSnapshot({
        account: snapshotAccount,
        runtime: rt,
        healthSummary: runtimeBridge.getStatusHeadline(accountId),
        // default 名不可隐藏时，统一展示稳定默认值
        displayName: resolveDefaultDisplayName(account?.name, accountId),
      });
    },
    resolveAccountState: ({ enabled, configured, account, cfg, runtime }: any) => {
      if (!enabled) return 'disabled';
      const resolved = resolveAccount(cfg, account?.accountId);
      if (!(resolved.enabled && configured)) return 'not configured';
      const rt = runtime || getBridge().getAccountRuntimeSnapshot(account?.accountId);
      return (rt as any)?.connected ? 'linked' : 'configured';
    },
  };
}
