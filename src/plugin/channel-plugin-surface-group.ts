import type { ChannelMessageSendResult } from 'openclaw/plugin-sdk/channel-message';
import { Type } from 'typebox';
import { listAccountIds, normalizeAccountId, resolveAccount } from '../core/accounts.ts';
import { BncrConfigSchema } from '../core/config-schema.ts';
import { resolveBncrChannelPolicy } from '../core/policy.ts';
import type { ReplyPayloadInput } from '../messaging/outbound/reply-enqueue.ts';
import type { OutboundReplyTargetPolicy } from '../messaging/outbound/reply-target-policy.ts';
import type { OpenClawChannelToolSend, openClawJsonResult } from '../openclaw/sdk-helpers.ts';
import { readOpenClawStringParam } from '../openclaw/sdk-helpers.ts';
import type { BncrBridgeCallBridge } from './bridge-call.ts';
import type {
  BncrChannelConfigRoot,
  BncrChannelSendContext,
  BncrMessageToolSchemaContribution,
  BncrSceneRecord,
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

const BNCR_MESSAGE_TOOL_SCHEMA: BncrMessageToolSchemaContribution = {
  visibility: 'current-channel',
  properties: {
    bridgeMethod: Type.Optional(
      Type.String({
        description:
          'Bncr-only bridge method forwarded to the OpenClawClient RPC bridge; use bncr.methods to list calls, or bncr.client.adapters.call to invoke a Bncr adapter method generically.',
      }),
    ),
    extra: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: 'Bncr-specific structured params merged into the unified outbound normalizer.',
      }),
    ),
    type: Type.Optional(
      Type.String({
        description: 'Explicit outbound type such as text, audio, video, voice, file, or appmsg.',
      }),
    ),
    downloadMedia: Type.Optional(
      Type.Boolean({
        description: 'Force URL media to be downloaded before sending.',
      }),
    ),
  },
};

export function createBncrChannelPluginSurfaceGroup(runtime: {
  channelId: string;
  sceneRegistry: Map<string, BncrSceneRecord>;
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
  getBridgeCallBridge: () => BncrBridgeCallBridge;
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
        actions: ['send', 'delete', 'unsend'] as const,
        capabilities: [] as const,
        schema: BNCR_MESSAGE_TOOL_SCHEMA,
      };
    },
    supportsAction: ({ action }) => action === 'send' || action === 'delete' || action === 'unsend',
    extractToolSend: ({ args }) =>
      runtime.extractToolSend(
        (args && typeof args === 'object' ? (args as Record<string, unknown>) : {}) as Record<
          string,
          unknown
        >,
        'sendMessage',
      ) || null,
    handleAction: async ({ action, params, accountId, mediaLocalRoots }) => {
      /* -- extract raw params (no normalization) ----------------------- */
      const paramsObj = (params && typeof params === 'object' ? params : {}) as Record<
        string,
        unknown
      >;
      const resolvedAccountId = normalizeAccountId(
        (readOpenClawStringParam(paramsObj, 'accountId') ?? accountId) || '',
      );
      if (action === 'delete' || action === 'unsend') {
        const to = readOpenClawStringParam(paramsObj, 'to', { required: true });
        const messageId =
          (typeof paramsObj.messageId === 'number'
            ? String(paramsObj.messageId)
            : readOpenClawStringParam(paramsObj, 'messageId')) ||
          readOpenClawStringParam(paramsObj, 'message_id');
        if (!messageId) {
          throw new Error(`${action} requires messageId`);
        }

        const verified = runtime.getToolActionBridge().resolveVerifiedTarget(to, resolvedAccountId);
        const bridgeResult = await runtime.getBridgeCallBridge().call(
          'bncr.client.adapters.call',
          {
            msgInfo: {
              groupId: verified.route.groupId || '0',
              userId: verified.route.userId || '0',
            },
            from: verified.route.platform,
            method: 'delMsg',
            messageId,
          },
          resolvedAccountId,
        );
        return runtime.openClawJsonResult({ ok: true, ...bridgeResult });
      }

      if (action !== 'send') {
        throw new Error(`Action ${action} is not supported for provider ${runtime.channelId}.`);
      }

      const bridgeMethod =
        typeof paramsObj.bridgeMethod === 'string' ? paramsObj.bridgeMethod.trim() : '';
      if (bridgeMethod) {
        const rawExtra = paramsObj.extra;
        const bridgeArgs =
          rawExtra && typeof rawExtra === 'object' && !Array.isArray(rawExtra)
            ? { ...(rawExtra as Record<string, unknown>) }
            : {};
        if (!('accountId' in bridgeArgs)) {
          bridgeArgs.accountId = resolvedAccountId || undefined;
        }
        const bridgeResult = await runtime.getBridgeCallBridge().call(bridgeMethod, bridgeArgs);
        return runtime.openClawJsonResult(bridgeResult);
      }

      const to = readOpenClawStringParam(paramsObj, 'to', { required: true });
      const toolMediaUrl =
        (typeof paramsObj.mediaUrl === 'string' ? paramsObj.mediaUrl : '') ||
        (typeof paramsObj.media === 'string' ? paramsObj.media : '') ||
        (typeof paramsObj.path === 'string' ? paramsObj.path : '') ||
        (typeof paramsObj.filePath === 'string' ? paramsObj.filePath : '');
      const rawExtra = paramsObj.extra;
      const extra =
        rawExtra && typeof rawExtra === 'object' && !Array.isArray(rawExtra)
          ? (rawExtra as Record<string, unknown>)
          : undefined;
      const rawMediaUrls = paramsObj.mediaUrls;
      const mediaUrls = Array.isArray(rawMediaUrls)
        ? rawMediaUrls.filter((u): u is string => typeof u === 'string')
        : undefined;

      const toolMessage = readOpenClawStringParam(paramsObj, 'message', { allowEmpty: true }) ?? '';
      const toolCaption = readOpenClawStringParam(paramsObj, 'caption', { allowEmpty: true }) ?? '';
      const text = toolCaption || toolMessage || '';
      const ctx: BncrChannelSendContext = {
        to,
        accountId: resolvedAccountId,
        text,
        mediaUrl: toolMediaUrl || undefined,
        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
        asVoice: paramsObj.asVoice === true,
        audioAsVoice: paramsObj.audioAsVoice === true,
        downloadMedia: paramsObj.downloadMedia as boolean | undefined,
        type: typeof paramsObj.type === 'string' ? paramsObj.type : undefined,
        extra,
        forceDocument: paramsObj.forceDocument === true,
        gifPlayback: paramsObj.gifPlayback === true,
        silent: paramsObj.silent === true,
        mediaLocalRoots,
      };

      const hasContent = Boolean(text?.trim() || toolMediaUrl || mediaUrls?.length || extra);
      if (!hasContent) {
        throw new Error('send requires message, media, or extra params');
      }

      /* -- bridge to sendDispatch (normalization + routing inside) ----- */
      const outboundBridge = runtime.getOutboundBridge();
      const result = await outboundBridge.channelSendText(ctx);

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
