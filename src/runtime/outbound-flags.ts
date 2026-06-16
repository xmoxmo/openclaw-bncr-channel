import { BNCR_DEFAULT_ACCOUNT_ID, CHANNEL_ID, normalizeAccountId } from '../core/accounts.ts';
import { getOpenClawRuntimeConfig } from '../openclaw/config-runtime.ts';
import type {
  BncrChannelConfigRoot,
  BncrChannelConfigSection,
  BncrStatusRuntimeSnapshot,
} from '../plugin/channel-runtime-types.ts';

type RuntimeApiHolder = { api: unknown };
type BncrAckConfigAccount = { outboundRequireAck?: boolean };
type BncrAckConfigChannel = BncrChannelConfigSection & {
  accounts?: Record<string, BncrAckConfigAccount | undefined>;
};

type OpenClawConfigApi = Parameters<typeof getOpenClawRuntimeConfig>[0];

function resolveBncrAckConfigChannel(api: unknown): BncrAckConfigChannel | undefined {
  const cfg = getOpenClawRuntimeConfig(api as OpenClawConfigApi) as BncrChannelConfigRoot;
  return cfg?.channels?.[CHANNEL_ID] as BncrAckConfigChannel | undefined;
}

type ResolveOutboundAckRequiredArgs = RuntimeApiHolder & {
  accountId?: string;
};

export function resolveBncrOutboundAckRequired(args: ResolveOutboundAckRequiredArgs) {
  try {
    const channelCfg = resolveBncrAckConfigChannel(args.api);
    const accountCfg =
      args.accountId && channelCfg?.accounts && typeof channelCfg.accounts === 'object'
        ? channelCfg.accounts[normalizeAccountId(args.accountId)]
        : null;
    const scoped = accountCfg?.outboundRequireAck;
    const global = channelCfg?.outboundRequireAck;
    if (typeof scoped === 'boolean') return scoped;
    if (typeof global === 'boolean') return global;
    return true;
  } catch {
    return true;
  }
}

type BuildBncrRuntimeFlagsArgs = RuntimeApiHolder & {
  accountId?: string;
  resolveMessageAckTimeoutMs: (accountId?: string) => number;
  adaptiveAckTimeoutEnabled: boolean;
  defaultMessageAckTimeoutMs: number;
  fileAckTimeoutMs: number;
  debugVerbose: boolean;
};

export function buildBncrRuntimeStatusInput(args: {
  accountId: string;
  connected: boolean;
  queueSnapshot: BncrStatusRuntimeSnapshot;
  eventCounters: BncrStatusRuntimeSnapshot;
  activitySnapshot: BncrStatusRuntimeSnapshot;
  startedAt: number | null;
  running?: boolean;
  channelRoot: string;
}) {
  return {
    accountId: args.accountId,
    connected: args.connected,
    ...args.queueSnapshot,
    ...args.eventCounters,
    ...args.activitySnapshot,
    startedAt: args.startedAt,
    running: args.running,
    channelRoot: args.channelRoot,
  };
}

export function buildBncrRuntimeFlags(args: BuildBncrRuntimeFlagsArgs) {
  let ackPolicySource: 'channel' | 'default' = 'default';
  try {
    const global = resolveBncrAckConfigChannel(args.api)?.outboundRequireAck;
    if (typeof global === 'boolean') ackPolicySource = 'channel';
  } catch {
    // keep default source
  }
  const accountId = args.accountId ? normalizeAccountId(args.accountId) : BNCR_DEFAULT_ACCOUNT_ID;
  return {
    outboundRequireAck: resolveBncrOutboundAckRequired({
      api: args.api,
      accountId,
    }),
    ackPolicySource,
    messageAckTimeoutMs: args.resolveMessageAckTimeoutMs(accountId),
    adaptiveAckTimeoutEnabled: args.adaptiveAckTimeoutEnabled,
    defaultMessageAckTimeoutMs: args.defaultMessageAckTimeoutMs,
    fileAckTimeoutMs: args.fileAckTimeoutMs,
    debugVerbose: args.debugVerbose,
  };
}

export type BncrRuntimeFlags = ReturnType<typeof buildBncrRuntimeFlags>;
