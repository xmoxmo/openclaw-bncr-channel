import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { BncrRoute, OutboxEntry } from '../core/types.ts';
import type { BncrConversationHistoryMap } from '../messaging/inbound/conversation-history.ts';
import type { BncrOutboundReplayCache } from '../messaging/inbound/outbound-replay-cache.ts';
import type { parseBncrInboundParams } from '../messaging/inbound/parse.ts';
import type { ReplyPayloadInput } from '../messaging/outbound/reply-enqueue.ts';
import type { OutboundReplyTargetPolicy } from '../messaging/outbound/reply-target-policy.ts';
import type { createBncrInboundHandlersComponent } from './channel-components.ts';
import type {
  buildInboundAcceptedLifecycleDebugInfo as buildInboundAcceptedLifecycleDebugInfoFromRuntime,
  buildInboundResponsePayload as buildInboundResponsePayloadFromRuntime,
} from './channel-inbound-helpers.ts';
import type {
  BncrChannelConfigRoot,
  BncrSceneRecord,
  BncrVerifiedTarget,
} from './channel-runtime-types.ts';
import type { LeaseEventPayload } from './connection-handlers.ts';
import type { BncrActiveConnectionDebugEntry } from './connection-state.ts';
import type { createBncrFileInboundHandlers } from './file-inbound-handlers.ts';

// Delivery-side wiring catalog.
//
// Order is intentional:
// 1) gateway / connection entrypoints
// 2) outbound + file-transfer state machines
// 3) inbound/public send surfaces

export function buildBncrInboundSurfaceRuntime(deps: {
  getApi: Parameters<typeof createBncrInboundHandlersComponent>[0]['getApi'];
  channelId: string;
  bridgeId: string;
  pluginRoot: string;
  asString: (value: unknown, fallback?: string) => string;
  now: () => number;
  normalizeAccountId: (value: string) => string;
  finiteNonNegativeNumberOrNull: (value: unknown) => number | null;
  syncDebugFlag: () => Promise<void>;
  shouldIgnoreStaleEvent: (args: {
    kind:
      | 'activity'
      | 'ack'
      | 'file.init'
      | 'file.chunk'
      | 'file.complete'
      | 'file.abort'
      | 'inbound';
    payload: LeaseEventPayload;
    accountId: string;
    connId: string;
    clientId?: string;
  }) => boolean;
  observeLease: (
    kind:
      | 'connect'
      | 'inbound'
      | 'activity'
      | 'ack'
      | 'file.init'
      | 'file.chunk'
      | 'file.complete'
      | 'file.abort',
    payload: LeaseEventPayload,
  ) => { stale: boolean };
  matchesTransferOwner: (args: {
    ownerConnId?: string;
    ownerClientId?: string;
    connId: string;
    clientId?: string;
  }) => boolean;
  refreshAcceptedFileTransferLiveState: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    context: GatewayRequestHandlerOptions['context'];
  }) => void;
  refreshLiveConnectionState: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady: boolean;
    preferredForOutbound: boolean;
    inboundOnly: boolean;
    context: GatewayRequestHandlerOptions['context'];
  }) => void;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logError: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  buildInboundResponsePayload: typeof buildInboundResponsePayloadFromRuntime;
  buildInboundAcceptedLifecycleDebugInfo: typeof buildInboundAcceptedLifecycleDebugInfoFromRuntime;
  isOnline: (accountId: string) => boolean;
  hasRecentInboundReachability: (accountId: string) => boolean;
  getActiveConnectionKey: (accountId: string) => string | null;
  buildActiveConnectionDebugList: (accountId: string) => BncrActiveConnectionDebugEntry[];
  markLastInboundAt: (accountId: string) => void;
  ensureCanonicalAgentId: (args: {
    cfg: BncrChannelConfigRoot;
    accountId: string;
    peer?: unknown;
    channelId?: string;
  }) => string;
  defaultAdminAgentId: (args: {
    cfg: BncrChannelConfigRoot;
    accountId: string;
    peer?: unknown;
    channelId?: string;
  }) => string;
  defaultPublicAgentId: () => string;
  sceneRegistry: Map<string, BncrSceneRecord>;
  conversationHistories: BncrConversationHistoryMap;
  outboundReplayCache: BncrOutboundReplayCache;
  prepareInboundAcceptance: (args: {
    parsed: ReturnType<typeof parseBncrInboundParams>;
    canonicalAgentId: string;
  }) => Promise<
    | {
        ok: true;
        accountId: string;
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
      }
  >;
  logInboundSummary: (args: {
    accountId: string;
    route: BncrRoute;
    msgType: string;
    text: string;
    hasMedia: boolean;
  }) => void;
  flushPushQueueBestEffort: (args?: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }) => void;
  rememberSessionRoute: (sessionKey: string, accountId: string, route: BncrRoute) => void;
  enqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: ReplyPayloadInput;
    mediaLocalRoots?: readonly string[];
    replyTargetPolicy?: OutboundReplyTargetPolicy;
  }) => Promise<void>;
  setInboundActivity: (accountId: string, at: number) => void;
  scheduleSave: () => void;
  buildCanonicalSessionKey: (route: BncrRoute) => string;
  fileRecvTransfers: Parameters<typeof createBncrFileInboundHandlers>[0]['fileRecvTransfers'];
  inboundFileTransferMaxBytes: number;
  inboundFileTransferMaxChunks: number;
}) {
  return { ...deps };
}

export function buildBncrChannelSendRuntime(deps: {
  channelId: string;
  asString: (value: unknown, fallback?: string) => string;
  syncDebugFlag: () => Promise<void>;
  logInfo: (scope: string, message: string, options?: Record<string, unknown>) => void;
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
  listOutboxEntries: () => OutboxEntry[];
  resolveSceneDownloadMedia?: (to: string) => boolean | undefined;
}) {
  return { ...deps };
}
