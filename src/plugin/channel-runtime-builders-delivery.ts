import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { RegisterDriftSnapshot } from '../core/register-trace.ts';
import type { normalizeStoredSessionKey as normalizeStoredSessionKeyFromRuntime } from '../core/targets.ts';
import type {
  BncrConnection,
  BncrRoute,
  FileSendTransferState,
  OutboxEntry,
} from '../core/types.ts';
import type { BncrGroupHistoryMap } from '../messaging/inbound/group-history.ts';
import type { parseBncrInboundParams } from '../messaging/inbound/parse.ts';
import type {
  NormalizedReplyPayload,
  ReplyPayloadInput,
} from '../messaging/outbound/reply-enqueue.ts';
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
import type { FileAckPayloadState, FileAckWaiter } from './file-ack-runtime.ts';
import type { createBncrFileInboundHandlers } from './file-inbound-handlers.ts';
import type { BncrFileTransferOrchestratorRuntime } from './file-transfer-orchestrator.ts';
import type { BncrFileTransferRouteDiagnostics } from './file-transfer-setup.ts';
import type { MessageAckWaiter } from './message-ack-runtime.ts';

type StoredRouteRecord = { accountId: string; route: BncrRoute; updatedAt: number };
type StoredLastSessionRecord = { sessionKey: string; scope: string; updatedAt: number };

// Delivery-side wiring catalog.
//
// Order is intentional:
// 1) gateway / connection entrypoints
// 2) outbound + file-transfer state machines
// 3) inbound/public send surfaces

export function buildBncrConnectionStateRuntime(deps: {
  bridgeId: string;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  connectTtlMs: number;
  recentInboundSendWindowMs: number;
  outboundReadyTtlMs: number;
  preferredOutboundTtlMs: number;
  connections: Map<string, BncrConnection>;
  activeConnectionByAccount: Map<string, string>;
  lastInboundByAccount: Map<string, number>;
  lastActivityByAccount: Map<string, number>;
  gcTransientState: () => void;
  connectionKey: (accountId: string, clientId?: string) => string;
  buildActiveConnectionDebugList: (
    accountId: string,
    options?: { includeOutboundState?: boolean },
  ) => BncrActiveConnectionDebugEntry[];
  rememberGatewayContext: (context: GatewayRequestHandlerOptions['context']) => void;
  markActivity: (accountId: string, at?: number) => void;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logInfoDedupJson: (
    scope: string,
    label: string,
    payload: unknown,
    options?: { key?: string; sig?: string; debugOnly?: boolean },
  ) => void;
}) {
  return { ...deps };
}

export function buildBncrFileTransferRuntime(deps: {
  bridgeId: string;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  clampFiniteNumber: (value: unknown, fallback: number, min?: number, max?: number) => number;
  fileAckTimeoutMs: number;
  maxEarlyFileAcks: number;
  fileAckWaiters: Map<string, FileAckWaiter>;
  earlyFileAcks: Map<string, FileAckPayloadState>;
  getFileAckOwnerInfo: (transferId: string) => Record<string, unknown>;
  fileForceChunk: boolean;
  fileInlineThreshold: number;
  normalizeAccountId: (accountId: string) => string;
  loadOutboundTransferMedia: (args: {
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
  }) => Promise<{ loaded: { buffer: Buffer }; size: number; mimeType?: string; fileName: string }>;
  resolveOutboxPushOwner: (accountId: string) => { connId?: string; clientId?: string } | null;
  hasRecentInboundReachability: (accountId: string) => boolean;
  buildTransferRouteDiagnostics: (args: {
    accountId: string;
    recentInboundReachable: boolean;
  }) => BncrFileTransferRouteDiagnostics;
  selectTransferConnIds: (args: {
    directConnIds: Set<string>;
    recentConnIds: Set<string>;
    recentInboundReachable: boolean;
  }) => Set<string>;
  broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => void;
  chunkEvent: string;
  completeEvent: string;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
}) {
  return { ...deps };
}

export function buildBncrStateTransientRuntime(deps: {
  bridgeId: string;
  getStatePath: () => string | null;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  finiteNumberOr: (value: unknown, fallback: number) => number;
  normalizeAccountId: (accountId: string) => string;
  normalizeStoredSessionKey: typeof normalizeStoredSessionKeyFromRuntime;
  parseRouteLike: (value: unknown) => BncrRoute | null;
  routeKey: (accountId: string, route: BncrRoute) => string;
  formatDisplayScope: (route: BncrRoute) => string;
  canonicalAgentId: () => string;
  normalizePersistedOutboxEntry: (entry: unknown) => OutboxEntry | null;
  maxDeadLetterEntries: number;
  maxSessionRouteEntries: number;
  maxAccountActivityEntries: number;
  sceneRegistry: Map<string, BncrSceneRecord>;
  groupHistories: Map<
    string,
    import('./channel-runtime-types.ts').BncrPersistedGroupHistoryEntry[]
  >;
  outbox: Map<string, OutboxEntry>;
  getDeadLetter: () => OutboxEntry[];
  setDeadLetter: (entries: OutboxEntry[]) => void;
  sessionRoutes: Map<string, StoredRouteRecord>;
  routeAliases: Map<string, StoredRouteRecord>;
  lastSessionByAccount: Map<string, StoredLastSessionRecord>;
  lastActivityByAccount: Map<string, number>;
  lastInboundByAccount: Map<string, number>;
  lastOutboundByAccount: Map<string, number>;
  getLastDriftSnapshot: () => RegisterDriftSnapshot | null;
  setLastDriftSnapshot: (value: RegisterDriftSnapshot | null) => void;
  connectTtlMs: number;
  fileTransferKeepMs: number;
  fileTransferTerminalKeepMs: number;
  fileTransferAckTtlMs: number;
  connections: Map<string, BncrConnection>;
  activeConnectionByAccount: Map<string, string>;
  recentInbound: Map<string, number>;
  fileSendTransfers: Map<string, { status: string; startedAt: number; terminalAt?: number }>;
  fileRecvTransfers: Map<string, { status: string; startedAt: number; terminalAt?: number }>;
  earlyFileAcks: Map<string, { at: number }>;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
}) {
  return { ...deps };
}

export function buildBncrAckOutboxRuntime(deps: {
  bridgeId: string;
  pushEvent: string;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  backoffMs: (retryCount: number) => number;
  isPlainObject: (value: unknown) => value is Record<string, unknown>;
  clampFiniteNumber: (value: unknown, fallback: number, min?: number, max?: number) => number;
  normalizeAccountId: (accountId: string) => string;
  formatDisplayScope: (route: BncrRoute) => string;
  isFileTransferEntry: (entry: OutboxEntry) => boolean;
  recommendedAckTimeoutMaxMs: number;
  adaptiveAckTimeoutEnabled: boolean;
  defaultAckTimeoutMs: number;
  stopped: () => boolean;
  outbox: Map<string, OutboxEntry>;
  deadLetter: () => OutboxEntry[];
  connectionsValues: () => IterableIterator<BncrConnection>;
  gatewayContextAvailable: () => boolean;
  messageAckWaiters: Map<string, MessageAckWaiter>;
  fileAckWaiterCount: () => number;
  activeConnectionCount: (accountId: string) => number;
  getAccountPendingOutboxEntries: (accountId: string) => OutboxEntry[];
  pushDrainRunningAccounts: Set<string>;
  pushDrainRunningSinceByAccount: Map<string, number>;
  pushDrainStuckWarnedAtByAccount: Map<string, number>;
  isOnline: (accountId: string) => boolean;
  hasRecentInboundReachability: (accountId: string) => boolean;
  isOutboundAckRequired: (accountId?: string) => boolean;
  resolveMessageAckTimeoutMs: (accountId: string) => number;
  waitForMessageAck: (messageId: string, waitMs: number) => Promise<'acked' | 'timeout'>;
  resolvePushConnIds: (accountId: string) => Iterable<string>;
  sleepMs: (ms: number) => Promise<void>;
  schedulePushDrain: (delayMs: number) => void;
  tryPushEntry: (entry: OutboxEntry) => Promise<boolean>;
  handleFileTransferPushFailure: (args: { entry: OutboxEntry; error: unknown }) => void;
  handleTextPushFailure: (args: { entry: OutboxEntry; error: unknown }) => void;
  isPrePushGuardDeferral: (entry: OutboxEntry) => boolean;
  scheduleSave: () => void;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logError: (scope: string, message: string) => void;
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
    payload: Record<string, unknown>,
  ) => { stale: boolean };
  rememberGatewayContext: (context: GatewayRequestHandlerOptions['context']) => void;
  markSeen: (accountId: string, connId: string, clientId?: string) => void;
  markOutboundCapability: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady: boolean;
    preferredForOutbound: boolean;
  }) => void;
  recordAckOkTelemetry: (args: {
    accountId: string;
    entry: OutboxEntry;
    telemetryPatch: { queueLatencyMs?: number; pushLatencyMs?: number; lateAfterTimeout?: boolean };
  }) => void;
  deleteOutboxEntry: (messageId: string) => void;
  setOutboxEntry: (messageId: string, entry: OutboxEntry) => void;
  resolveMessageAck: (messageId: string, result: 'acked' | 'timeout') => boolean;
  moveToDeadLetter: (entry: OutboxEntry, reason: string) => void;
  recordAckTimeoutTelemetry: (accountId: string) => void;
  degradeOutboundCapability: (args: {
    accountId: string;
    connId?: string;
    clientId?: string;
    reason: string;
  }) => void;
  flushPushQueueBestEffort: (args?: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }) => void;
  flushTriggerTimer: string;
  flushReasonScheduledDrain: string;
  outboundFlushTriggerAckOk: string;
  outboundFlushReasonMessageAcked: string;
  pushDrainExceptionRetryLimit: number;
  pushDrainExceptionRetryDelayMs: number;
  pushDrainStuckWarnMs: number;
  pushDrainIntervalMs: number;
  pushDrainAccountTimeBudgetMs: number;
  pushDrainAccountBudget: number;
  pushAckTimeoutMs: number;
  maxRetry: number;
  prePushGuardRetryDelayMs: number;
}) {
  return { ...deps };
}

export function buildBncrOutboxPushRouteRuntime(deps: {
  bridgeId: string;
  pushEvent: string;
  now: () => number;
  connectTtlMs: number;
  finiteNumberOr: (value: unknown, fallback: number) => number;
  outboxSize: () => number;
  gatewayBroadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
  ) => void;
  recordOutboxPushSuccess: (args: {
    entry: OutboxEntry;
    connIds: Iterable<string>;
    ownerConnId?: string;
    ownerClientId?: string;
    clearLastError?: boolean;
  }) => void;
  recordOutboxPushFailure: (args: {
    entry: OutboxEntry;
    error: unknown;
    fallbackError: string;
    persist?: boolean;
  }) => void;
  recordOutboxPrePushFailure: (args: {
    entry: OutboxEntry;
    lastError: string;
    persist?: boolean;
  }) => void;
  recordPrePushGuardSkip: (args: { accountId: string; reason: string }) => void;
  moveToDeadLetter: (entry: OutboxEntry, reason: string) => void;
  activeConnectionCount: (accountId: string) => number;
  connections: Map<string, BncrConnection>;
  connectionsValues: () => Iterable<BncrConnection>;
  activeConnectionByAccount: Map<string, string>;
  resolveRecentInboundConnIds: (accountId: string) => Set<string>;
  connectionKey: (accountId: string, clientId?: string) => string;
  isRetryableFileTransferError: (value: unknown) => boolean;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  buildActiveConnectionDebugList: (
    accountId: string,
    options?: { includeOutboundState?: boolean },
  ) => BncrActiveConnectionDebugEntry[];
}) {
  return { ...deps };
}

export function buildBncrMediaOrchestratorsRuntime(deps: {
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  fileSendTransfers: Map<string, FileSendTransferState>;
  getGatewayContext: () => GatewayRequestHandlerOptions['context'] | null;
  fileInitEvent: string;
  fileAbortEvent: string;
  prepareOutboundTransfer: BncrFileTransferOrchestratorRuntime['prepareOutboundTransfer'];
  sendChunk: BncrFileTransferOrchestratorRuntime['sendChunk'];
  sendComplete: BncrFileTransferOrchestratorRuntime['sendComplete'];
  waitForFileAck: BncrFileTransferOrchestratorRuntime['waitForFileAck'];
  logFileTransferChunkAck: BncrFileTransferOrchestratorRuntime['logFileTransferChunkAck'];
  logFileTransferChunkAckFail: BncrFileTransferOrchestratorRuntime['logFileTransferChunkAckFail'];
  logFileTransferCompleteAck: BncrFileTransferOrchestratorRuntime['logFileTransferCompleteAck'];
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logEnqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: NormalizedReplyPayload;
  }) => void;
  enqueueOutbound: (entry: OutboxEntry) => void;
  buildTextOutboxEntry: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    text: string;
    extra?: Record<string, unknown>;
    kind?: 'tool' | 'block' | 'final';
    replyToId?: string;
    replyTargetPolicy?: OutboundReplyTargetPolicy;
  }) => OutboxEntry;
  buildFileTransferOutboxEntry: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
    text: string;
    asVoice: boolean;
    audioAsVoice: boolean;
    type?: string;
    extra?: Record<string, unknown>;
    kind?: 'tool' | 'block' | 'final';
    replyToId?: string;
    replyTargetPolicy?: OutboundReplyTargetPolicy;
    downloadMedia?: boolean;
  }) => OutboxEntry;
  rememberRecentMediaSend: (args: {
    sessionKey: string;
    mediaUrl: string;
    text: string;
    replyToId: string;
    createdAt: number;
  }) => void;
  tryBuildMediaDedupeFallback: (args: {
    sessionKey: string;
    mediaUrl: string;
    text: string;
    replyToId: string;
    currentTime: number;
  }) => {
    text: string;
    reason: 'same-text-sent-checkmark' | 'text-changed-downgrade';
  } | null;
}) {
  return {
    ...deps,
    getGatewayContext: () => {
      const context = deps.getGatewayContext();
      if (!context) return null;
      return {
        broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) =>
          context.broadcastToConnIds(event, payload, connIds),
      };
    },
  };
}

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
  groupHistories: BncrGroupHistoryMap;
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
}) {
  return { ...deps };
}
