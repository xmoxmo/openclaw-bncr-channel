import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import { buildCanonicalBncrSessionKey } from '../core/targets.ts';
import type { BncrConnection, BncrRoute } from '../core/types.ts';
import type { BncrGroupHistoryMap } from '../messaging/inbound/group-history.ts';
import type { BncrOutboundReplayCache } from '../messaging/inbound/outbound-replay-cache.ts';
import type { parseBncrInboundParams } from '../messaging/inbound/parse.ts';
import type { ReplyPayloadInput } from '../messaging/outbound/reply-enqueue.ts';
import type {
  buildInboundResponsePayload,
  resolveInboundSessionContext,
} from './channel-inbound-helpers.ts';
import type { BncrChannelConfigRoot, BncrSceneRecord } from './channel-runtime-types.ts';
import { buildBncrGatewayEventContext } from './gateway-event-context.ts';

type InboundLifecycleStage = 'accepted';
type LeaseEventKind =
  | 'inbound'
  | 'activity'
  | 'ack'
  | 'file.init'
  | 'file.chunk'
  | 'file.complete'
  | 'file.abort';
type InboundResponseArgs =
  | { kind: 'stale-ignored'; accountId: string; msgId?: string | null }
  | {
      kind: 'accepted';
      accountId: string;
      sessionKey: string;
      msgId?: string | null;
      taskKey?: string | null;
    }
  | { kind: 'invalid-peer' }
  | { kind: 'invalid-session'; accountId: string; msgId?: string | null };

type ParsedInboundParams = ReturnType<typeof parseBncrInboundParams>;
type InboundResponsePayload = ReturnType<typeof buildInboundResponsePayload>;
type EnsureCanonicalAgentIdPeer = Parameters<typeof resolveInboundSessionContext>[0]['peer'];
type InboundAcceptanceResult =
  | {
      ok: true;
      accountId?: string;
      sessionKey: string;
      inboundText: string;
      hasMedia: boolean;
      resolvedAgentId: string;
      shouldDispatch: boolean;
      shouldAccumulate: boolean;
      dispatchBy: string;
    }
  | {
      ok: false;
      status: boolean;
      payload: Record<string, unknown>;
    };

function buildBncrPendingDirectApprovalNotice(args: {
  parsed: ParsedInboundParams;
  reason: string;
}): string | null {
  if (args.parsed.peer.kind !== 'direct') return null;
  if (args.reason !== 'scene pending approval') return null;
  return `This private chat is pending approval. Ask the administrator to allow your SceneId: ${args.parsed.platform}:${args.parsed.userId}`;
}

function buildBncrPendingDirectApprovalPayload(args: {
  msgId?: string;
  text: string;
}): ReplyPayloadInput {
  return {
    text: args.text,
    kind: 'final',
    ...(args.msgId ? { replyToId: args.msgId } : {}),
  };
}

export type BncrInboundHandlersRuntime = {
  channelId: string;
  bridgeId: string;
  asString: (value: unknown, fallback?: string) => string;
  now: () => number;
  syncDebugFlag: () => Promise<void>;
  parseInboundParams: (params: unknown) => ParsedInboundParams;
  shouldIgnoreStaleEvent: (args: {
    kind: LeaseEventKind;
    payload: { leaseId?: string; connectionEpoch?: number };
    accountId: string;
    connId: string;
    clientId?: string;
  }) => boolean;
  buildInboundResponsePayload: (args: InboundResponseArgs) => InboundResponsePayload;
  refreshLiveConnectionState: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady: boolean;
    preferredForOutbound: boolean;
    inboundOnly: boolean;
    context: GatewayRequestHandlerOptions['context'];
  }) => void;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logError: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  buildInboundAcceptedLifecycleDebugInfo: (args: {
    stage: InboundLifecycleStage;
    bridge: string;
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady: boolean;
    preferredForOutbound: boolean;
    inboundOnly: boolean;
    onlineAfterSeen: boolean;
    recentInboundReachable: boolean;
    activeConnectionKey: string | null;
    activeConnections: BncrConnection[];
  }) => Record<string, unknown>;
  isOnline: (accountId: string) => boolean;
  hasRecentInboundReachability: (accountId: string) => boolean;
  getActiveConnectionKey: (accountId: string) => string | null;
  buildActiveConnectionDebugList: (accountId: string) => BncrConnection[];
  markLastInboundAt: (accountId: string) => void;
  getConfig: () => BncrChannelConfigRoot;
  ensureCanonicalAgentId: (args: {
    cfg: BncrChannelConfigRoot;
    accountId: string;
    peer: EnsureCanonicalAgentIdPeer;
    channelId: string;
  }) => string;
  defaultAdminAgentId: (args: {
    cfg: BncrChannelConfigRoot;
    accountId: string;
    peer: EnsureCanonicalAgentIdPeer;
    channelId: string;
  }) => string;
  defaultPublicAgentId: () => string;
  sceneRegistry: Map<string, BncrSceneRecord>;
  groupHistories: BncrGroupHistoryMap;
  outboundReplayCache: BncrOutboundReplayCache;
  prepareInboundAcceptance: (args: {
    parsed: ParsedInboundParams;
    canonicalAgentId: string;
  }) => Promise<InboundAcceptanceResult>;
  formatDisplayScope: (route: BncrRoute) => string;
  logInboundSummary: (args: {
    accountId: string;
    route: BncrRoute;
    msgType: string;
    text: string;
    hasMedia: boolean;
  }) => void;
  enqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: ReplyPayloadInput;
    mediaLocalRoots?: readonly string[];
  }) => Promise<void>;
  respond: GatewayRequestHandlerOptions['respond'];
  flushOnInboundAccepted: (accountId: string) => void;
  dispatchInbound: (args: {
    cfg: BncrChannelConfigRoot;
    parsed: ParsedInboundParams;
    canonicalAgentId: string;
    resolvedAgentId: string;
    shouldDispatch: boolean;
    shouldAccumulate: boolean;
    sceneRegistry: Map<string, BncrSceneRecord>;
    groupHistories: BncrGroupHistoryMap;
    outboundReplayCache: BncrOutboundReplayCache;
    defaultAdminAgentId: string;
    defaultPublicAgentId: string;
    now: () => number;
  }) => Promise<unknown>;
};

export function createBncrInboundHandlers(runtime: Omit<BncrInboundHandlersRuntime, 'respond'>) {
  return {
    handleInbound: async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
      await runtime.syncDebugFlag();
      const parsed = runtime.parseInboundParams(params);
      const { accountId, platform, route, msgType, msgId, peer, extracted } = parsed;
      const gatewayContext = buildBncrGatewayEventContext({
        params,
        client,
        context,
        asString: runtime.asString,
        normalizeAccountId: (value) => value,
        now: runtime.now,
      });
      const { connId, clientId, outboundReady, preferredForOutbound, inboundOnly } = gatewayContext;
      if (
        runtime.shouldIgnoreStaleEvent({
          kind: 'inbound',
          payload: params ?? {},
          accountId,
          connId,
          clientId,
        })
      ) {
        respond(
          true,
          runtime.buildInboundResponsePayload({
            kind: 'stale-ignored',
            accountId,
            msgId: msgId ?? null,
          }),
        );
        return;
      }
      runtime.refreshLiveConnectionState({
        accountId,
        connId,
        clientId,
        outboundReady,
        preferredForOutbound,
        inboundOnly,
        context: gatewayContext.context,
      });
      runtime.logInfo(
        'inbound',
        `lifecycle ${JSON.stringify(
          runtime.buildInboundAcceptedLifecycleDebugInfo({
            stage: 'accepted',
            bridge: runtime.bridgeId,
            accountId,
            connId,
            clientId,
            outboundReady,
            preferredForOutbound,
            inboundOnly,
            onlineAfterSeen: runtime.isOnline(accountId),
            recentInboundReachable: runtime.hasRecentInboundReachability(accountId),
            activeConnectionKey: runtime.getActiveConnectionKey(accountId),
            activeConnections: runtime.buildActiveConnectionDebugList(accountId),
          }),
        )}`,
        { debugOnly: true },
      );
      runtime.markLastInboundAt(accountId);

      const cfg = runtime.getConfig();
      const canonicalAgentId = runtime.ensureCanonicalAgentId({
        cfg,
        accountId,
        peer,
        channelId: runtime.channelId,
      });
      const defaultAdminAgentId = runtime.defaultAdminAgentId({
        cfg,
        accountId,
        peer,
        channelId: runtime.channelId,
      });
      const acceptance = await runtime.prepareInboundAcceptance({ parsed, canonicalAgentId });
      if (!acceptance.ok) {
        const reason = runtime
          .asString((acceptance.payload as { reason?: unknown })?.reason || '')
          .trim();
        runtime.logInfo(
          'inbound',
          `accept reject|accountId=${accountId}|msgId=${msgId ?? '-'}|scope=${runtime.formatDisplayScope(route)}|chatType=${peer.kind}|msgType=${msgType}|status=${acceptance.status}|reason=${reason || '-'}|isAdmin=${parsed.isAdmin === true}|platformShouldRespond=${parsed.shouldRespond === true}`,
        );
        const pendingNotice = buildBncrPendingDirectApprovalNotice({ parsed, reason });
        if (pendingNotice) {
          const sessionKey = buildCanonicalBncrSessionKey(route, canonicalAgentId);
          await runtime.enqueueFromReply({
            accountId,
            sessionKey,
            route,
            payload: buildBncrPendingDirectApprovalPayload({
              msgId: msgId ?? undefined,
              text: pendingNotice,
            }),
          });
        }
        respond(acceptance.status, acceptance.payload);
        return;
      }

      const {
        sessionKey,
        inboundText,
        hasMedia,
        resolvedAgentId,
        shouldDispatch,
        shouldAccumulate,
        dispatchBy,
      } = acceptance;
      runtime.logInfo(
        'inbound',
        `accept ok|accountId=${accountId}|msgId=${msgId ?? '-'}|scope=${runtime.formatDisplayScope(route)}|chatType=${peer.kind}|msgType=${msgType}|sessionKey=${sessionKey}|agent=${resolvedAgentId}|dispatch=${shouldDispatch}|dispatchBy=${dispatchBy}|accumulate=${shouldAccumulate}|isAdmin=${parsed.isAdmin === true}|platformShouldRespond=${parsed.shouldRespond === true}`,
      );
      runtime.logInfo(
        'inbound',
        JSON.stringify({
          accountId,
          msgId: msgId ?? null,
          platform,
          chatType: peer.kind,
          scope: runtime.formatDisplayScope(route),
          sessionKey,
          msgType,
          textLen: inboundText.length,
          textPreview: inboundText.slice(0, 120),
          hasMedia,
        }),
        { debugOnly: true },
      );
      runtime.logInboundSummary({
        accountId,
        route,
        msgType,
        text: inboundText,
        hasMedia,
      });

      respond(
        true,
        runtime.buildInboundResponsePayload({
          kind: 'accepted',
          accountId,
          sessionKey,
          msgId: msgId ?? null,
          taskKey: extracted.taskKey ?? null,
        }),
      );
      runtime.flushOnInboundAccepted(accountId);

      void runtime
        .dispatchInbound({
          cfg,
          parsed,
          canonicalAgentId,
          resolvedAgentId,
          shouldDispatch,
          shouldAccumulate,
          sceneRegistry: runtime.sceneRegistry,
          groupHistories: runtime.groupHistories,
          outboundReplayCache: runtime.outboundReplayCache,
          defaultAdminAgentId,
          defaultPublicAgentId: runtime.defaultPublicAgentId(),
          now: runtime.now,
        })
        .catch((err) => {
          runtime.logError('inbound', `process failed: ${String(err)}`, { debugOnly: true });
        });
    },
  };
}
