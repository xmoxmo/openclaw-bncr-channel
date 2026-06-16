import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { BncrConnection, BncrRoute } from '../core/types.ts';
import type { parseBncrInboundParams } from '../messaging/inbound/parse.ts';
import type {
  buildInboundResponsePayload,
  resolveInboundSessionContext,
} from './channel-inbound-helpers.ts';
import type { BncrChannelConfigRoot } from './channel-runtime-types.ts';
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
    }
  | {
      ok: false;
      status: boolean;
      payload: Record<string, unknown>;
    };

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
  respond: GatewayRequestHandlerOptions['respond'];
  flushOnInboundAccepted: (accountId: string) => void;
  dispatchInbound: (args: {
    cfg: BncrChannelConfigRoot;
    parsed: ParsedInboundParams;
    canonicalAgentId: string;
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
      const acceptance = await runtime.prepareInboundAcceptance({ parsed, canonicalAgentId });
      if (!acceptance.ok) {
        respond(acceptance.status, acceptance.payload);
        return;
      }

      const { sessionKey, inboundText, hasMedia } = acceptance;
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
        })
        .catch((err) => {
          runtime.logError('inbound', `process failed: ${String(err)}`, { debugOnly: true });
        });
    },
  };
}
