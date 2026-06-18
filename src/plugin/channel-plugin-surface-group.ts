import { randomUUID } from 'node:crypto';
import type { ChannelMessageSendResult } from 'openclaw/plugin-sdk/channel-message';
import { listAccountIds, resolveAccount } from '../core/accounts.ts';
import { BncrConfigSchema } from '../core/config-schema.ts';
import { resolveBncrChannelPolicy } from '../core/policy.ts';
import type { ReplyPayloadInput } from '../messaging/outbound/reply-enqueue.ts';
import type { OutboundReplyTargetPolicy } from '../messaging/outbound/reply-target-policy.ts';
import { sendBncrMedia, sendBncrText } from '../messaging/outbound/send.ts';
import { normalizeBncrSendParams } from '../messaging/outbound/send-params.ts';
import type { OpenClawChannelToolSend, openClawJsonResult } from '../openclaw/sdk-helpers.ts';
import type {
  BncrChannelConfigRoot,
  BncrStatusRuntimeSnapshot,
  BncrVerifiedTarget,
  ChannelMessageActionAdapter,
} from './channel-runtime-types.ts';
import type { BNCR_CONFIG_SURFACE } from './config.ts';
import type { BncrGatewayAccountBridge } from './gateway-runtime.ts';
import { createBncrGatewayRuntime } from './gateway-runtime.ts';
import { BNCR_MESSAGE_RECEIVE_POLICY } from './message-policy.ts';
import { createBncrMessageSend } from './message-send.ts';
import { createBncrMessagingSurface } from './messaging.ts';
import { type BncrOutboundBridge, createBncrOutboundRuntime } from './outbound.ts';
import type { BNCR_SETUP_SURFACE } from './setup.ts';
import { createBncrStatusSurface } from './status.ts';

type BncrChannelMeta = {
  id: string;
  label: string;
  selectionLabel: string;
  docsPath: string;
  blurb: string;
  [key: string]: unknown;
};

type PluginSurfaceResult = ReturnType<typeof openClawJsonResult>;

export function createBncrChannelPluginSurfaceGroup(runtime: {
  channelId: string;
  getMessageSendBridge: () => {
    channelMessageSendText: (
      ctx: Record<string, unknown>,
    ) => ChannelMessageSendResult | Promise<ChannelMessageSendResult>;
    channelMessageSendMedia: (
      ctx: Record<string, unknown>,
    ) => ChannelMessageSendResult | Promise<ChannelMessageSendResult>;
    channelMessageSendPayload: (
      ctx: Record<string, unknown>,
    ) => ChannelMessageSendResult | Promise<ChannelMessageSendResult>;
  };
  getOutboundBridge: () => BncrOutboundBridge;
  getMessagingBridge: () => {
    canonicalAgentId: undefined;
    ensureCanonicalAgentId: (params: { cfg: BncrChannelConfigRoot; accountId: string }) => string;
    resolveRouteBySession: (raw: string, accountId: string) => BncrVerifiedTarget['route'] | null;
  };
  getStatusBridge: () => {
    getChannelSummary: (defaultAccountId: string) => Record<string, unknown>;
    getAccountRuntimeSnapshot: (accountId?: string) => BncrStatusRuntimeSnapshot;
    getStatusHeadline: (accountId?: string) => string;
  };
  getToolActionBridge: () => {
    resolveVerifiedTarget: (to: string, accountId: string) => BncrVerifiedTarget;
    rememberSessionRoute: (
      sessionKey: string,
      accountId: string,
      route: BncrVerifiedTarget['route'],
    ) => void;
    enqueueFromReply: (args: {
      accountId: string;
      sessionKey: string;
      route: BncrVerifiedTarget['route'];
      payload: ReplyPayloadInput;
      mediaLocalRoots?: readonly string[];
      replyTargetPolicy?: OutboundReplyTargetPolicy;
    }) => Promise<void>;
  };
  getGatewayBridge: () => {
    channelStartAccount: BncrGatewayAccountBridge['channelStartAccount'];
    channelStopAccount: BncrGatewayAccountBridge['channelStopAccount'];
  };
  channelMeta: BncrChannelMeta;
  channelCapabilities: {
    chatTypes: Array<'direct' | 'group' | 'thread'>;
    media: boolean;
    reply: boolean;
    nativeCommands: boolean;
    [key: string]: unknown;
  };
  gatewayMethods: string[];
  configSurface: typeof BNCR_CONFIG_SURFACE;
  setupSurface: typeof BNCR_SETUP_SURFACE;
  extractToolSend: (
    args: Record<string, unknown>,
    action: string,
  ) => OpenClawChannelToolSend | null;
  openClawJsonResult: (payload: Record<string, unknown>) => PluginSurfaceResult;
}) {
  const messageActions: ChannelMessageActionAdapter = {
    describeMessageTool: ({ cfg }) => {
      const channelCfg = cfg?.channels?.[runtime.channelId];
      const accounts = channelCfg?.accounts;
      const hasExplicitConfiguredAccount =
        Boolean(channelCfg && typeof channelCfg === 'object') &&
        resolveBncrChannelPolicy(channelCfg).enabled !== false &&
        Boolean(accounts && typeof accounts === 'object') &&
        Object.keys(accounts || {}).some(
          (accountId) => resolveAccount(cfg, accountId).enabled !== false,
        );

      const runtimeBridge = runtime.getStatusBridge();
      const hasConnectedRuntime = listAccountIds(cfg).some((accountId) => {
        const resolved = resolveAccount(cfg, accountId);
        const runtimeSnapshot = runtimeBridge.getAccountRuntimeSnapshot(resolved.accountId);
        return Boolean(runtimeSnapshot?.connected);
      });

      if (!hasExplicitConfiguredAccount && !hasConnectedRuntime) {
        return null;
      }

      return {
        actions: ['send'] as const,
        capabilities: [] as const,
      };
    },
    supportsAction: ({ action }) => action === 'send',
    extractToolSend: ({ args }) =>
      runtime.extractToolSend(
        (args && typeof args === 'object' ? (args as Record<string, unknown>) : {}) as Record<
          string,
          unknown
        >,
        'sendMessage',
      ) || null,
    handleAction: async ({ action, params, accountId, mediaLocalRoots }) => {
      if (action !== 'send') {
        throw new Error(`Action ${action} is not supported for provider ${runtime.channelId}.`);
      }
      const normalized = normalizeBncrSendParams({ params, accountId: accountId || '' });

      const toolActionBridge = runtime.getToolActionBridge();
      const result =
        normalized.mediaUrl || normalized.mediaUrls?.length
          ? await sendBncrMedia({
              channelId: runtime.channelId,
              accountId: normalized.accountId,
              to: normalized.to,
              text: normalized.caption,
              mediaUrl: normalized.mediaUrl,
              mediaUrls: normalized.mediaUrls,
              asVoice: normalized.asVoice,
              audioAsVoice: normalized.audioAsVoice,
              type: normalized.type,
              mediaLocalRoots,
              resolveVerifiedTarget: (to, accountId) =>
                toolActionBridge.resolveVerifiedTarget(to, accountId),
              rememberSessionRoute: (sessionKey, accountId, route) =>
                toolActionBridge.rememberSessionRoute(sessionKey, accountId, route),
              enqueueFromReply: (args) => toolActionBridge.enqueueFromReply(args),
              createMessageId: () => randomUUID(),
            })
          : await sendBncrText({
              channelId: runtime.channelId,
              accountId: normalized.accountId,
              to: normalized.to,
              text: normalized.message,
              mediaLocalRoots,
              resolveVerifiedTarget: (to, accountId) =>
                toolActionBridge.resolveVerifiedTarget(to, accountId),
              rememberSessionRoute: (sessionKey, accountId, route) =>
                toolActionBridge.rememberSessionRoute(sessionKey, accountId, route),
              enqueueFromReply: (args) => toolActionBridge.enqueueFromReply(args),
              createMessageId: () => randomUUID(),
            });

      return runtime.openClawJsonResult({ ok: true, ...result });
    },
  };

  const plugin = {
    id: runtime.channelId,
    meta: runtime.channelMeta,
    actions: messageActions,
    message: {
      receive: BNCR_MESSAGE_RECEIVE_POLICY,
      send: createBncrMessageSend(runtime.getMessageSendBridge),
    },
    capabilities: runtime.channelCapabilities,
    messaging: createBncrMessagingSurface(runtime.getMessagingBridge),
    configSchema: BncrConfigSchema,
    config: runtime.configSurface,
    setup: runtime.setupSurface,
    outbound: createBncrOutboundRuntime(runtime.getOutboundBridge),
    status: createBncrStatusSurface(runtime.getStatusBridge),
    gatewayMethods: runtime.gatewayMethods,
    gateway: createBncrGatewayRuntime(runtime.getGatewayBridge),
  };

  return {
    messageActions,
    plugin,
  };
}
