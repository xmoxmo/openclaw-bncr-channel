import {
  BNCR_DEFAULT_ACCOUNT_ID,
  resolveAccount,
  resolveDefaultDisplayName,
} from '../core/accounts.ts';
import { buildAccountStatusSnapshot } from '../core/status.ts';
import { createOpenClawDefaultChannelRuntimeState } from '../openclaw/sdk-helpers.ts';
import type { BncrChannelConfigRoot, BncrStatusRuntimeSnapshot } from './channel-runtime-types.ts';

type StatusSurfaceSummaryArgs = { defaultAccountId?: string };

type StatusSurfaceAccount = { accountId?: string; name?: string; enabled?: boolean };

type StatusSurfaceAccountSnapshotArgs = {
  account?: StatusSurfaceAccount;
  runtime?: BncrStatusRuntimeSnapshot;
};

type StatusSurfaceAccountStateArgs = {
  enabled?: boolean;
  configured?: boolean;
  account?: StatusSurfaceAccount;
  cfg: BncrChannelConfigRoot;
  runtime?: BncrStatusRuntimeSnapshot;
};

export type BncrStatusBridge = {
  getChannelSummary: (
    defaultAccountId: string,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  getAccountRuntimeSnapshot: (accountId?: string) => BncrStatusRuntimeSnapshot;
  getStatusHeadline: (accountId?: string) => string;
};

export function createBncrStatusSurface(getBridge: () => BncrStatusBridge) {
  return {
    defaultRuntime: createOpenClawDefaultChannelRuntimeState(BNCR_DEFAULT_ACCOUNT_ID, {
      mode: 'ws-offline',
    }),
    buildChannelSummary: async ({ defaultAccountId }: StatusSurfaceSummaryArgs) => {
      return getBridge().getChannelSummary(defaultAccountId || BNCR_DEFAULT_ACCOUNT_ID);
    },
    buildAccountSnapshot: async ({ account, runtime }: StatusSurfaceAccountSnapshotArgs) => {
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
    resolveAccountState: ({
      enabled,
      configured,
      account,
      cfg,
      runtime,
    }: StatusSurfaceAccountStateArgs) => {
      if (!enabled) return 'disabled';
      const resolved = resolveAccount(cfg, account?.accountId);
      if (!(resolved.enabled && configured)) return 'not configured';
      const rt = runtime || getBridge().getAccountRuntimeSnapshot(account?.accountId);
      return rt?.connected ? 'linked' : 'configured';
    },
  };
}
