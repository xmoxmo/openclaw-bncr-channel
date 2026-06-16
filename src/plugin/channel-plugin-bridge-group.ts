import type { ChannelMessageSendResult } from 'openclaw/plugin-sdk/channel-message';
import type { BncrRoute } from '../core/types.ts';
import type { ReplyPayloadInput } from '../messaging/outbound/reply-enqueue.ts';
import type { OutboundReplyTargetPolicy } from '../messaging/outbound/reply-target-policy.ts';
import type {
  BncrChannelConfigRoot,
  BncrChannelSendContext,
  BncrStatusRuntimeSnapshot,
  BncrVerifiedTarget,
} from './channel-runtime-types.ts';
import type { BncrOutboundBridge } from './outbound.ts';

export type BncrChannelPluginBridge = {
  channelMessageSendText: (
    ctx: BncrChannelSendContext,
  ) => ChannelMessageSendResult | Promise<ChannelMessageSendResult>;
  channelMessageSendMedia: (
    ctx: BncrChannelSendContext,
  ) => ChannelMessageSendResult | Promise<ChannelMessageSendResult>;
  channelMessageSendPayload: (
    ctx: BncrChannelSendContext,
  ) => ChannelMessageSendResult | Promise<ChannelMessageSendResult>;
  channelSendText: BncrOutboundBridge['channelSendText'];
  channelSendMedia: BncrOutboundBridge['channelSendMedia'];
  ensureCanonicalAgentId: (args: {
    cfg: BncrChannelConfigRoot;
    accountId: string;
    channelId: string;
    peer: { kind: 'direct'; id: string };
  }) => string;
  resolveRouteBySession: (raw: string, accountId: string) => BncrRoute | null;
  getChannelSummary: (defaultAccountId: string) => Record<string, unknown>;
  getAccountRuntimeSnapshot: (accountId: string) => BncrStatusRuntimeSnapshot;
  getStatusHeadline: (accountId: string) => string;
  resolveVerifiedTarget: (to: string, accountId: string) => BncrVerifiedTarget;
  rememberSessionRoute: (sessionKey: string, accountId: string, route: BncrRoute) => void;
  enqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: ReplyPayloadInput;
    mediaLocalRoots?: readonly string[];
    replyTargetPolicy?: OutboundReplyTargetPolicy;
  }) => Promise<void>;
  channelStartAccount: (ctx: unknown) => void | Promise<void>;
  channelStopAccount: (ctx: unknown) => void | Promise<void>;
};

export function createBncrChannelPluginBridgeGroup(runtime: {
  channelId: string;
  defaultAccountId: string;
  getBridge: () => BncrChannelPluginBridge;
}) {
  const getMessageSendBridge = () => {
    const bridge = runtime.getBridge();
    return {
      channelMessageSendText: (ctx: BncrChannelSendContext) => bridge.channelMessageSendText(ctx),
      channelMessageSendMedia: (ctx: BncrChannelSendContext) => bridge.channelMessageSendMedia(ctx),
      channelMessageSendPayload: (ctx: BncrChannelSendContext) =>
        bridge.channelMessageSendPayload(ctx),
    };
  };

  const getOutboundBridge = () => {
    const bridge = runtime.getBridge();
    return {
      channelSendText: (ctx: Parameters<BncrOutboundBridge['channelSendText']>[0]) =>
        bridge.channelSendText(ctx),
      channelSendMedia: (ctx: Parameters<BncrOutboundBridge['channelSendMedia']>[0]) =>
        bridge.channelSendMedia(ctx),
    };
  };

  const getMessagingBridge = () => {
    const bridge = runtime.getBridge();
    return {
      canonicalAgentId: undefined,
      ensureCanonicalAgentId: (params: { cfg: BncrChannelConfigRoot; accountId: string }) =>
        bridge.ensureCanonicalAgentId({
          cfg: params.cfg,
          accountId: params.accountId,
          channelId: runtime.channelId,
          peer: { kind: 'direct', id: params.accountId },
        }),
      resolveRouteBySession: (raw: string, accountId: string) =>
        bridge.resolveRouteBySession(raw, accountId),
    };
  };

  const getStatusBridge = () => {
    const bridge = runtime.getBridge();
    return {
      getChannelSummary: (defaultAccountId: string) => bridge.getChannelSummary(defaultAccountId),
      getAccountRuntimeSnapshot: (accountId?: string) =>
        bridge.getAccountRuntimeSnapshot(accountId || runtime.defaultAccountId),
      getStatusHeadline: (accountId?: string) =>
        bridge.getStatusHeadline(accountId || runtime.defaultAccountId),
    };
  };

  const getToolActionBridge = () => {
    const bridge = runtime.getBridge();
    return {
      resolveVerifiedTarget: (to: string, accountId: string) =>
        bridge.resolveVerifiedTarget(to, accountId),
      rememberSessionRoute: (sessionKey: string, accountId: string, route: BncrRoute) =>
        bridge.rememberSessionRoute(sessionKey, accountId, route),
      enqueueFromReply: (args: Parameters<BncrChannelPluginBridge['enqueueFromReply']>[0]) =>
        bridge.enqueueFromReply(args),
    };
  };

  const getGatewayBridge = () => {
    const bridge = runtime.getBridge();
    return {
      channelStartAccount: (ctx: unknown) => bridge.channelStartAccount(ctx),
      channelStopAccount: (ctx: unknown) => bridge.channelStopAccount(ctx),
    };
  };

  return {
    getMessageSendBridge,
    getOutboundBridge,
    getMessagingBridge,
    getStatusBridge,
    getToolActionBridge,
    getGatewayBridge,
  };
}
