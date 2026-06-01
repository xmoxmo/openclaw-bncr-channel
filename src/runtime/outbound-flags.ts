import { CHANNEL_ID, BNCR_DEFAULT_ACCOUNT_ID, normalizeAccountId } from '../core/accounts.ts';
import { getOpenClawRuntimeConfig } from '../openclaw/config-runtime.ts';

type RuntimeApiHolder = { api: unknown };

type ResolveOutboundAckRequiredArgs = RuntimeApiHolder & {
  accountId?: string;
};

export function resolveBncrOutboundAckRequired(args: ResolveOutboundAckRequiredArgs) {
  try {
    const cfg = getOpenClawRuntimeConfig(args.api as any);
    const channelCfg = (cfg as any)?.channels?.[CHANNEL_ID];
    const accountCfg =
      args.accountId && channelCfg?.accounts && typeof channelCfg.accounts === 'object'
        ? (channelCfg.accounts as Record<string, any>)[normalizeAccountId(args.accountId)]
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
  queueSnapshot: Record<string, any>;
  eventCounters: Record<string, any>;
  activitySnapshot: Record<string, any>;
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
    const cfg = getOpenClawRuntimeConfig(args.api as any);
    const global = (cfg as any)?.channels?.[CHANNEL_ID]?.outboundRequireAck;
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
