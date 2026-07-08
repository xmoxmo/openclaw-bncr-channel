import { randomUUID } from 'node:crypto';
import type {
  GatewayRequestHandlerOptions,
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from 'openclaw/plugin-sdk/core';
import { BNCR_DEFAULT_ACCOUNT_ID, CHANNEL_ID, normalizeAccountId } from './core/accounts.ts';
import {
  countInvalidOutboxSessionKeys as countInvalidOutboxSessionKeysFromRuntime,
  countLegacyAccountResidue as countLegacyAccountResidueFromRuntime,
} from './core/diagnostic-counters.ts';
import type { BncrExtendedDiagnostics } from './core/extended-diagnostics.ts';
import {
  matchesTransferOwner as matchesTransferOwnerFromRuntime,
  observeLeaseState,
} from './core/lease-state.ts';
import {
  buildBncrDebugJsonMessage,
  emitBncrLog,
  summarizeBncrTextPreview,
} from './core/logging.ts';
import {
  buildFileTransferOutboxEntry as buildFileTransferOutboxEntryFromRuntime,
  buildTextOutboxEntry as buildTextOutboxEntryFromRuntime,
} from './core/outbox-entry-builders.ts';
import { summarizeOutboxEntry } from './core/outbox-summary.ts';
import { normalizePersistedOutboxEntry as normalizePersistedOutboxEntryFromRuntime } from './core/persisted-outbox-entry.ts';
import {
  buildCanonicalBncrSessionKey,
  formatDisplayScope,
  normalizeStoredSessionKey,
  parseRouteLike,
  routeKey,
} from './core/targets.ts';
import type {
  BncrAckObservability,
  BncrConnection,
  BncrDiagnosticsSummary,
  BncrRoute,
  FileRecvTransferState,
  FileSendTransferState,
  OutboxEntry,
} from './core/types.ts';
import type { BncrGroupHistoryMap } from './messaging/inbound/group-history.ts';
import type { parseBncrInboundParams } from './messaging/inbound/parse.ts';
import { buildEnqueueFromReplyDebugInfo } from './messaging/outbound/diagnostics.ts';
import { buildBncrMediaOutboundFrame } from './messaging/outbound/media.ts';
import {
  type MediaDedupeCacheEntry,
  normalizeReplyToId,
} from './messaging/outbound/media-dedupe.ts';
import { OUTBOUND_FLUSH_REASON, OUTBOUND_FLUSH_TRIGGER } from './messaging/outbound/reasons.ts';
import type {
  NormalizedReplyPayload,
  OutboundReplyTargetPolicy,
  ReplyMediaEntriesParams,
  ReplyPayloadInput,
} from './messaging/outbound/reply-enqueue.ts';
import type { OpenClawChannelRuntimeApiHolder } from './openclaw/channel-runtime-contracts.ts';
import { getOpenClawRuntimeConfig } from './openclaw/config-runtime.ts';
import type { OpenClawLoadedMedia } from './openclaw/media-runtime.ts';
import { resolveOpenClawAgentRoute } from './openclaw/routing-runtime.ts';
import { extractOpenClawToolSend, openClawJsonResult } from './openclaw/sdk-helpers.ts';
import { createBncrAckOutboxRuntimeGroup } from './plugin/ack-outbox-runtime-group.ts';
import { createBncrBridgeAckFacade } from './plugin/bridge-ack-facade.ts';
import { createBncrBridgeConnectionFacade } from './plugin/bridge-connection-facade.ts';
import { createBncrBridgeDiagnosticsFacade } from './plugin/bridge-diagnostics-facade.ts';
import { createBncrBridgeDrainFacade } from './plugin/bridge-drain-facade.ts';
import { createBncrBridgeExtendedDiagnosticsFacade } from './plugin/bridge-extended-diagnostics-facade.ts';
import { createBncrBridgeFileTransferPushFacade } from './plugin/bridge-file-transfer-push-facade.ts';
import {
  cleanupBncrBridgeRuntime,
  shutdownBncrBridgeService,
  startBncrBridgeService,
  stopBncrBridgeService,
} from './plugin/bridge-lifecycle.ts';
import { createBncrBridgeMediaFacade } from './plugin/bridge-media-facade.ts';
import { createBncrBridgeOutboxFacade } from './plugin/bridge-outbox-facade.ts';
import { createBncrBridgeRuntimeSurfaceFacade } from './plugin/bridge-runtime-surface-facade.ts';
import {
  buildBncrAckDiagnosticsRuntime,
  buildBncrStatusProjectionRuntime,
  createBncrBridgeStatusFacade,
} from './plugin/bridge-status-facade.ts';
import { createBncrBridgeStatusWorkerFacade } from './plugin/bridge-status-worker-facade.ts';
import { createBncrBridgeSurfaceHandlersGroup } from './plugin/bridge-surface-handlers-group.ts';
import {
  buildBridgeDrainTriggers,
  buildBridgeLifecycleMarkers,
  buildBridgeStatusProjectionRuntime,
  buildChannelSendTargetRuntime,
  buildInboundSurfaceActivityRuntime,
  buildInboundSurfaceConnectionRuntime,
  createBridgeSupportRuntime,
} from './plugin/bridge-surface-helpers.ts';
import { BNCR_CHANNEL_CAPABILITIES } from './plugin/capabilities.ts';
import { resolveBncrChannelRoot } from './plugin/channel-components.ts';
import {
  buildInboundAcceptedLifecycleDebugInfo,
  buildInboundResponsePayload,
} from './plugin/channel-inbound-helpers.ts';
import type { BncrChannelPluginBridge } from './plugin/channel-plugin-bridge-group.ts';
import { createBncrChannelPluginBridgeGroup } from './plugin/channel-plugin-bridge-group.ts';
import { createBncrChannelPluginSurfaceGroup } from './plugin/channel-plugin-surface-group.ts';
import {
  buildBncrBridgeSurfaceHandlersRuntime,
  buildBncrChannelSendRuntime,
  buildBncrInboundSurfaceRuntime,
} from './plugin/channel-runtime-builders.ts';
import {
  ADAPTIVE_ACK_TIMEOUT_DEFAULT_ENABLED,
  ADAPTIVE_ACK_TIMEOUT_LOG_THROTTLE_MS,
  ADAPTIVE_ACK_TIMEOUT_OBSERVATION_TTL_MS,
  ADAPTIVE_ACK_TIMEOUT_RECOVERY_OK_THRESHOLD,
  BNCR_FILE_ABORT_EVENT,
  BNCR_FILE_CHUNK_EVENT,
  BNCR_FILE_COMPLETE_EVENT,
  BNCR_FILE_INIT_EVENT,
  BNCR_PUSH_EVENT,
  BRIDGE_VERSION,
  CONNECT_TTL_MS,
  FILE_ACK_TIMEOUT_MS,
  FILE_FORCE_CHUNK,
  FILE_INLINE_THRESHOLD,
  FILE_TRANSFER_ACK_TTL_MS,
  FILE_TRANSFER_KEEP_MS,
  FILE_TRANSFER_TERMINAL_KEEP_MS,
  INBOUND_FILE_TRANSFER_MAX_BYTES,
  INBOUND_FILE_TRANSFER_MAX_CHUNKS,
  MAX_ACCOUNT_ACTIVITY_ENTRIES,
  MAX_DEAD_LETTER_ENTRIES,
  MAX_EARLY_FILE_ACKS,
  MAX_RETRY,
  MAX_SESSION_ROUTE_ENTRIES,
  OUTBOUND_READY_TTL_MS,
  PRE_PUSH_GUARD_RETRY_DELAY_MS,
  PREFERRED_OUTBOUND_TTL_MS,
  PUSH_ACK_TIMEOUT_MS,
  PUSH_DRAIN_ACCOUNT_BUDGET,
  PUSH_DRAIN_ACCOUNT_TIME_BUDGET_MS,
  PUSH_DRAIN_EXCEPTION_RETRY_DELAY_MS,
  PUSH_DRAIN_EXCEPTION_RETRY_LIMIT,
  PUSH_DRAIN_INTERVAL_MS,
  PUSH_DRAIN_STUCK_WARN_MS,
  RECENT_INBOUND_SEND_WINDOW_MS,
  RECOMMENDED_ACK_TIMEOUT_MAX_MS,
  RECOMMENDED_ACK_TIMEOUT_MIN_MS,
  REGISTER_WARMUP_WINDOW_MS,
} from './plugin/channel-runtime-constants.ts';
import type {
  BncrBridgeRuntimePaths,
  BncrChannelConfigRoot,
  BncrChannelSendContext,
  BncrSceneRecord,
  FileAckPayloadState,
  PersistedState,
} from './plugin/channel-runtime-types.ts';
import { createBncrChannelSendRuntimeGroup } from './plugin/channel-send-runtime-group.ts';
import {
  asString,
  backoffMs,
  clampFiniteNumber,
  finiteNonNegativeNumberOrNull,
  finiteNumberOr,
  isPlainObject,
  now,
  resolveOutboundFileName,
} from './plugin/channel-utils.ts';
import { BNCR_CONFIG_SURFACE } from './plugin/config.ts';
import { createBncrConnectionStateRuntimeGroup } from './plugin/connection-state-runtime-group.ts';
import { createBncrFileTransferRuntimeGroup } from './plugin/file-transfer-runtime-group.ts';
import { BNCR_GATEWAY_METHODS } from './plugin/gateway-methods.ts';
import { prepareBncrInboundAcceptance } from './plugin/inbound-acceptance.ts';
import { createBncrInboundSurfaceHandlersGroup } from './plugin/inbound-surface-handlers-group.ts';
import { createBncrMediaOrchestratorsRuntimeGroup } from './plugin/media-orchestrators-runtime-group.ts';
import { BNCR_CHANNEL_META } from './plugin/meta.ts';
import type { BncrOutboxAckOkTelemetryPatch } from './plugin/outbox-ack-outcome.ts';
import { runBncrFileTransferOutboxPush } from './plugin/outbox-file-push-flow.ts';
import { createBncrOutboxPushRouteRuntimeGroup } from './plugin/outbox-push-route-runtime-group.ts';
import { runBncrTextOutboxPush } from './plugin/outbox-text-push-flow.ts';
import {
  createBncrDeadLetterDiagnosticsHelpers,
  createBncrDiagnosticsSelectionHelpers,
  createBncrOutboxDiagnosticsHelpers,
  createBncrRuntimeAckObservabilityBuilder,
} from './plugin/runtime-diagnostics-snapshot.ts';
import { BNCR_SETUP_SURFACE } from './plugin/setup.ts';
import { createBncrStateTransientRuntimeGroup } from './plugin/state-transient-runtime-group.ts';
import { createBncrTargetStatusRuntimeGroup } from './plugin/target-status-runtime-group.ts';
import { shouldEmitDedupLog as shouldEmitDedupLogFromRuntime } from './runtime/log-dedupe.ts';
import { buildBncrRuntimeAckStrategy } from './runtime/outbound-ack-timeout.ts';
import { resolveBncrOutboundAckRequired } from './runtime/outbound-flags.ts';
import type { RegisterTraceRuntimeState } from './runtime/register-trace-runtime.ts';
import {
  buildRegisterTraceRuntimeSummary,
  noteRegisterTraceRuntime,
} from './runtime/register-trace-runtime.ts';
import {
  type ChannelAccountWorkerHandle,
  clearAllBncrStatusWorkers,
  startBncrStatusWorker,
  stopBncrStatusWorker,
} from './runtime/status-worker.ts';

type BncrRuntimeStatusInput = Parameters<BncrBridgeRuntime['buildIntegratedDiagnostics']>[1];

let BNCR_DEBUG_VERBOSE = false; // 全局调试日志开关（默认关闭）

type BncrStatusWorkerContext = Parameters<typeof startBncrStatusWorker>[1];

class BncrBridgeRuntime {
  // Identity / lifecycle ----------------------------------------------------
  private api: OpenClawPluginApi;

  private get runtimeApi(): OpenClawPluginApi {
    return this.api;
  }
  private statePath: string | null = null;
  private bridgeId = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  private recentMediaDedupeBySession = new Map<string, Map<string, MediaDedupeCacheEntry>>();
  private gatewayPid = process.pid;
  private registerCount = 0;
  private apiGeneration = 0;
  private firstRegisterAt: number | null = null;
  private lastRegisterAt: number | null = null;
  private lastApiRebindAt: number | null = null;
  private pluginSource: string | null = null;
  private pluginVersion: string | null = null;
  private connectionEpoch = 0;
  private primaryLeaseId: string | null = null;
  private acceptedConnections = 0;
  private lastConnectAt: number | null = null;
  private lastDisconnectAt: number | null = null;
  private lastInboundAtGlobal: number | null = null;
  private lastActivityAtGlobal: number | null = null;
  private lastAckAtGlobal: number | null = null;
  private recentConnections = new Map<
    string,
    {
      epoch: number;
      connectedAt: number;
      lastActivityAt: number | null;
      isPrimary: boolean;
    }
  >();

  // Register trace / drift diagnostics --------------------------------------
  private staleCounters = {
    staleConnect: 0,
    staleInbound: 0,
    staleActivity: 0,
    staleAck: 0,
    staleFileInit: 0,
    staleFileChunk: 0,
    staleFileComplete: 0,
    staleFileAbort: 0,
    lastStaleAt: null as number | null,
  };
  private lastApiInstanceId: string | null = null;
  private lastRegistryFingerprint: string | null = null;
  private lastDriftSnapshot: PersistedState['lastDriftSnapshot'] = null;
  private pluginRoot: string | null = null;
  private pluginFile: string | null = null;
  private registerTraceRecent: Array<{
    ts: number;
    bridgeId: string;
    gatewayPid: number;
    registerCount: number;
    apiGeneration: number;
    apiRebound: boolean;
    apiInstanceId: string | null;
    registryFingerprint: string | null;
    source: string | null;
    pluginVersion: string | null;
    stack: string;
    stackBucket: string;
  }> = [];

  // Connection / outbound ownership -----------------------------------------
  private connections = new Map<string, BncrConnection>(); // connectionKey -> connection
  private activeConnectionByAccount = new Map<string, string>(); // accountId -> connectionKey
  private outbox = new Map<string, OutboxEntry>(); // messageId -> entry
  private deadLetter: OutboxEntry[] = [];

  // Session routing / account activity -------------------------------------
  private sessionRoutes = new Map<
    string,
    { accountId: string; route: BncrRoute; updatedAt: number }
  >();
  private sceneRegistry = new Map<string, BncrSceneRecord>();
  private groupHistories: BncrGroupHistoryMap = new Map();
  private routeAliases = new Map<
    string,
    { accountId: string; route: BncrRoute; updatedAt: number }
  >();

  private recentInbound = new Map<string, number>();
  private lastSessionByAccount = new Map<
    string,
    { sessionKey: string; scope: string; updatedAt: number }
  >();
  private lastActivityByAccount = new Map<string, number>();
  private lastInboundByAccount = new Map<string, number>();
  private lastOutboundByAccount = new Map<string, number>();
  private lastAckOkByAccount = new Map<string, number>();
  private lastAckTimeoutByAccount = new Map<string, number>();
  private ackTimeoutCountByAccount = new Map<string, number>();
  private lateAckOkCountByAccount = new Map<string, number>();
  private lastLateAckOkByAccount = new Map<string, number>();
  private lastAckQueueLatencyMsByAccount = new Map<string, number>();
  private lastAckPushLatencyMsByAccount = new Map<string, number>();
  private lastLateAckQueueLatencyMsByAccount = new Map<string, number>();
  private lastLateAckPushLatencyMsByAccount = new Map<string, number>();

  // Adaptive ACK telemetry ---------------------------------------------------
  private adaptiveAckRecoveryOkCountByAccount = new Map<string, number>();
  private adaptiveAckTimeoutLogStateByAccount = new Map<
    string,
    { at: number; timeoutMs: number; reason: string }
  >();
  private channelAccountWorkers = new Map<string, ChannelAccountWorkerHandle>();
  private logDedupeState = new Map<string, { at: number; sig: string }>();
  private canonicalAgentId: string | null = null;

  // Health / status counters ------------------------------------------------
  // 内置健康/回归计数（替代独立脚本）
  private startedAt = now();
  private stopped = false;
  private connectEventsByAccount = new Map<string, number>();
  private inboundEventsByAccount = new Map<string, number>();
  private activityEventsByAccount = new Map<string, number>();
  private ackEventsByAccount = new Map<string, number>();

  // Timers / background workers ---------------------------------------------
  private saveTimer: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private pushDrainRunningAccounts = new Set<string>();
  private pushDrainRunningSinceByAccount = new Map<string, number>();
  private pushDrainStuckWarnedAtByAccount = new Map<string, number>();
  private pushDrainExceptionRetryCount = 0;
  private lastGatewayContextAt: number | null = null;
  private outboundEnqueueCountByAccount = new Map<string, number>();
  private lastOutboundEnqueueAtByAccount = new Map<string, number>();
  private prePushGuardSkipCountByAccount = new Map<string, number>();
  private lastPrePushGuardSkipAtByAccount = new Map<string, number>();
  private lastPrePushGuardSkipReasonByAccount = new Map<string, string>();
  private deadLetterSinceStartByAccount = new Map<string, number>();
  private messageAckWaiters = new Map<
    // Refactor boundary note (message ACK runtime):
    // These waiters are part of the outbound message-ack lifecycle, not just a utility map.
    // They are coupled to shutdown cleanup, resolveMessageAck, waitForMessageAck, outbox retry
    // decisions, and diagnostics counts. Any future extraction should move lifecycle tests first,
    // then move storage + resolver/wait APIs together rather than partially splitting the map only.
    string,
    {
      promise: Promise<'acked' | 'timeout'>;
      resolve: (result: 'acked' | 'timeout') => void;
      timer: NodeJS.Timeout;
    }
  >();
  private gatewayContext: GatewayRequestHandlerOptions['context'] | null = null;

  // File transfer runtime ----------------------------------------------------
  // 文件互传状态（V1：尽力而为，重连不续传）
  private fileSendTransfers = new Map<string, FileSendTransferState>(); // OpenClaw -> Bncr（服务端发起）
  private fileRecvTransfers = new Map<string, FileRecvTransferState>(); // Bncr -> OpenClaw（客户端发起）
  private fileAckWaiters = new Map<
    string,
    {
      promise: Promise<Record<string, unknown>>;
      resolve: (payload: Record<string, unknown>) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private earlyFileAcks = new Map<string, FileAckPayloadState>();

  private readonly bridgeSupportRuntime = createBridgeSupportRuntime({
    isStopped: () => this.stopped,
    hasSaveTimer: () => Boolean(this.saveTimer),
    setSaveTimer: (timer) => {
      this.saveTimer = timer;
    },
    flushState: () => this.flushState(),
    normalizeAccountId,
    getCounterValue: (map, accountId) => map.get(accountId) || 0,
    getRuntimeConfig: () => getOpenClawRuntimeConfig(this.api),
    channelId: CHANNEL_ID,
    readCurrentCanonicalAgentId: () => this.canonicalAgentId,
    resolveAgentRoute: (args) =>
      resolveOpenClawAgentRoute(this.api as OpenClawChannelRuntimeApiHolder, {
        ...args,
        peer: args.peer as unknown,
      }),
    readCachedCanonicalAgentId: () => this.canonicalAgentId,
    writeCachedCanonicalAgentId: (agentId) => {
      this.canonicalAgentId = agentId;
    },
    logInfo: (scope, message, options) => this.logInfo(scope, message, options),
    logWarn: (scope, message, options) => this.logWarn(scope, message, options),
    readDebugVerbose: () => BNCR_DEBUG_VERBOSE,
    writeDebugVerbose: (value) => {
      BNCR_DEBUG_VERBOSE = value;
    },
  });

  constructor(api: OpenClawPluginApi, runtimePaths: BncrBridgeRuntimePaths = {}) {
    this.api = api;
    this.bindRuntimePaths(runtimePaths);
  }

  // Lifecycle / logging / register tracing ---------------------------------
  // Read this block first: it establishes bridge identity, logging, status
  // worker wiring, and register-trace state before the message/runtime flows.

  // Basic bridge identity / binding ----------------------------------------

  bindApi(api: OpenClawPluginApi) {
    this.api = api;
  }

  bindRuntimePaths(runtimePaths: BncrBridgeRuntimePaths = {}) {
    if (typeof runtimePaths.pluginRoot === 'string' && runtimePaths.pluginRoot.trim()) {
      this.pluginRoot = runtimePaths.pluginRoot;
    }
    if (typeof runtimePaths.pluginFile === 'string' && runtimePaths.pluginFile.trim()) {
      this.pluginFile = runtimePaths.pluginFile;
    }
  }

  getBridgeId() {
    return this.bridgeId;
  }

  // Logging helpers ---------------------------------------------------------

  private logInfo(scope: string | undefined, message: string, options?: { debugOnly?: boolean }) {
    emitBncrLog('info', scope, message, options, () => this.isDebugEnabled());
  }

  private logWarn(scope: string | undefined, message: string, options?: { debugOnly?: boolean }) {
    emitBncrLog('warn', scope, message, options, () => this.isDebugEnabled());
  }

  private logError(scope: string | undefined, message: string, options?: { debugOnly?: boolean }) {
    emitBncrLog('error', scope, message, options, () => this.isDebugEnabled());
  }

  private logInfoJson(
    scope: string | undefined,
    event: string,
    payload: Record<string, unknown>,
    options?: { debugOnly?: boolean },
  ) {
    this.logInfo(scope, buildBncrDebugJsonMessage(event, payload), options);
  }

  private shouldEmitDedupLog(key: string, sig: string, windowMs = 5 * 60 * 1000) {
    return shouldEmitDedupLogFromRuntime({
      state: this.logDedupeState,
      key,
      sig,
      nowMs: now(),
      windowMs,
    });
  }

  private logInfoDedup(
    scope: string | undefined,
    message: string,
    options: { key: string; sig: string; debugOnly?: boolean; windowMs?: number },
  ) {
    if (!this.shouldEmitDedupLog(options.key, options.sig, options.windowMs)) return;
    this.logInfo(scope, message, { debugOnly: options.debugOnly });
  }

  private logInfoDedupJson(
    scope: string | undefined,
    event: string,
    payload: Record<string, unknown>,
    options: { key: string; sig: string; debugOnly?: boolean; windowMs?: number },
  ) {
    if (!this.shouldEmitDedupLog(options.key, options.sig, options.windowMs)) return;
    this.logInfoJson(scope, event, payload, { debugOnly: options.debugOnly });
  }

  private summarizeTextPreview(raw: string, limit = 8) {
    return summarizeBncrTextPreview(raw, limit);
  }

  private summarizeScope(route: BncrRoute) {
    return formatDisplayScope(route);
  }

  // Inbound / outbound summary logs ----------------------------------------

  private logInboundSummary(params: {
    accountId: string;
    route: BncrRoute;
    msgType: string;
    text: string;
    hasMedia: boolean;
  }) {
    const type = params.msgType;
    const preview = this.summarizeTextPreview(params.text);
    this.logInfo('inbound', [type, this.summarizeScope(params.route), preview].join('|'));
  }

  private logOutboundSummary(entry: OutboxEntry) {
    this.logInfo(
      'outbound',
      summarizeOutboxEntry({
        entry,
        asString,
        formatDisplayScope,
        summarizeTextPreview: (raw, limit) => this.summarizeTextPreview(raw, limit),
      }),
    );
  }

  private buildStatusWorkerRuntime() {
    return this.bridgeStatusWorkerFacade;
  }

  // Status-worker lifecycle -------------------------------------------------

  private clearAllChannelAccountWorkers(reason: string) {
    clearAllBncrStatusWorkers(this.buildStatusWorkerRuntime(), reason);
  }

  // Register trace state bridges -------------------------------------------

  private getRegisterTraceRuntimeState(): RegisterTraceRuntimeState {
    return {
      registerCount: this.registerCount,
      apiGeneration: this.apiGeneration,
      firstRegisterAt: this.firstRegisterAt,
      lastRegisterAt: this.lastRegisterAt,
      lastApiRebindAt: this.lastApiRebindAt,
      pluginSource: this.pluginSource,
      pluginVersion: this.pluginVersion,
      lastApiInstanceId: this.lastApiInstanceId,
      lastRegistryFingerprint: this.lastRegistryFingerprint,
      lastDriftSnapshot: this.lastDriftSnapshot ?? null,
      registerTraceRecent: this.registerTraceRecent,
    };
  }

  private applyRegisterTraceRuntimeState(state: RegisterTraceRuntimeState) {
    this.registerCount = state.registerCount;
    this.apiGeneration = state.apiGeneration;
    this.firstRegisterAt = state.firstRegisterAt;
    this.lastRegisterAt = state.lastRegisterAt;
    this.lastApiRebindAt = state.lastApiRebindAt;
    this.pluginSource = state.pluginSource;
    this.pluginVersion = state.pluginVersion;
    this.lastApiInstanceId = state.lastApiInstanceId;
    this.lastRegistryFingerprint = state.lastRegistryFingerprint;
    this.lastDriftSnapshot = state.lastDriftSnapshot;
    this.registerTraceRecent = state.registerTraceRecent;
  }

  private buildRegisterTraceSummary() {
    return buildRegisterTraceRuntimeSummary({
      state: this.getRegisterTraceRuntimeState(),
      warmupWindowMs: REGISTER_WARMUP_WINDOW_MS,
    });
  }

  // Register observation / lease bookkeeping -------------------------------

  noteRegister(meta: {
    source?: string;
    pluginVersion?: string;
    apiRebound?: boolean;
    apiInstanceId?: string;
    registryFingerprint?: string;
  }) {
    const ts = now();
    const stack = String(new Error().stack || '')
      .split('\n')
      .slice(2, 7)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' <- ');
    const state = this.getRegisterTraceRuntimeState();
    const { trace, capturedDriftSnapshot } = noteRegisterTraceRuntime({
      state,
      meta,
      ts,
      stack,
      bridgeId: this.bridgeId,
      gatewayPid: this.gatewayPid,
      warmupWindowMs: REGISTER_WARMUP_WINDOW_MS,
      maxTraceEntries: 12,
    });
    this.applyRegisterTraceRuntimeState(state);
    if (capturedDriftSnapshot) this.scheduleSave();

    this.logInfo('debug', `register-trace ${JSON.stringify(trace)}`, { debugOnly: true });
  }

  private createLeaseId() {
    return typeof crypto?.randomUUID === 'function'
      ? `lease_${crypto.randomUUID()}`
      : `lease_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  }

  private acceptConnection() {
    const ts = now();
    const leaseId = this.createLeaseId();
    const connectionEpoch = ++this.connectionEpoch;
    this.primaryLeaseId = leaseId;
    this.acceptedConnections += 1;
    this.lastConnectAt = ts;
    this.recentConnections.set(leaseId, {
      epoch: connectionEpoch,
      connectedAt: ts,
      lastActivityAt: null,
      isPrimary: true,
    });
    for (const [id, entry] of this.recentConnections.entries()) {
      if (id !== leaseId) entry.isPrimary = false;
    }
    while (this.recentConnections.size > 8) {
      const oldest = this.recentConnections.keys().next().value;
      if (!oldest) break;
      this.recentConnections.delete(oldest);
    }
    return { leaseId, connectionEpoch, acceptedAt: ts };
  }

  private observeLease(
    kind:
      | 'connect'
      | 'inbound'
      | 'activity'
      | 'ack'
      | 'file.init'
      | 'file.chunk'
      | 'file.complete'
      | 'file.abort',
    params: { leaseId?: string; connectionEpoch?: number },
  ) {
    const leaseId = typeof params.leaseId === 'string' ? params.leaseId.trim() : '';
    const connectionEpoch =
      typeof params.connectionEpoch === 'number' ? params.connectionEpoch : undefined;
    const observed = observeLeaseState({
      kind,
      params,
      currentLeaseId: this.primaryLeaseId,
      currentConnectionEpoch: this.connectionEpoch,
      now: now(),
      staleCounters: this.staleCounters,
    });
    if (!observed.stale) return observed;
    this.logWarn(
      'stale',
      `observed kind=${kind} lease=${leaseId || '-'} epoch=${connectionEpoch ?? '-'} currentLease=${this.primaryLeaseId || '-'} currentEpoch=${this.connectionEpoch}`,
      { debugOnly: true },
    );
    return observed;
  }

  private shouldIgnoreStaleEvent(params: {
    kind:
      | 'inbound'
      | 'activity'
      | 'ack'
      | 'file.init'
      | 'file.chunk'
      | 'file.complete'
      | 'file.abort';
    payload: { leaseId?: string; connectionEpoch?: number };
    accountId: string;
    connId: string;
    clientId?: string;
  }) {
    const observed = this.observeLease(params.kind, params.payload);
    if (!observed.stale) return false;
    this.logWarn(
      'stale',
      `ignore kind=${params.kind} accountId=${params.accountId} connId=${params.connId} clientId=${params.clientId || '-'} reason=${observed.reason}`,
      { debugOnly: true },
    );
    return true;
  }

  private matchesTransferOwner(params: {
    ownerConnId?: string;
    ownerClientId?: string;
    connId: string;
    clientId?: string;
  }) {
    return matchesTransferOwnerFromRuntime(params);
  }

  private buildRuntimeSurfaceDiagnostics() {
    return this.bridgeRuntimeSurfaceFacade.buildRuntimeSurfaceDiagnostics();
  }

  private buildBridgeStatusProjectionRuntime() {
    return buildBridgeStatusProjectionRuntime({
      buildAccountQueueCounters: (accountId: string) => this.buildAccountQueueCounters(accountId),
      buildExtendedDiagnostics: (
        accountId: string,
        args?: Parameters<typeof this.buildExtendedDiagnostics>[1],
      ) => this.buildExtendedDiagnostics(accountId, args),
      buildRuntimeFlags: (accountId?: string) => this.buildRuntimeFlags(accountId),
      buildRuntimeStatusInput: (
        accountId: string,
        overrides: Parameters<typeof this.buildRuntimeStatusInput>[1],
      ) => this.buildRuntimeStatusInput(accountId, overrides),
      getAccountRuntimeSnapshot: (
        accountId: string,
        runtimeStatusInput: Parameters<typeof this.getAccountRuntimeSnapshot>[1],
      ) => this.getAccountRuntimeSnapshot(accountId, runtimeStatusInput),
      buildIntegratedDiagnostics: (
        accountId: string,
        runtimeStatusInput: Parameters<typeof this.buildIntegratedDiagnostics>[1],
      ) => this.buildIntegratedDiagnostics(accountId, runtimeStatusInput),
      buildDownlinkHealth: (accountId: string) => this.buildDownlinkHealth(accountId),
      resolveChannelRoot: () => resolveBncrChannelRoot(this.pluginRoot || ''),
    });
  }

  private buildBridgeDrainTriggers() {
    return buildBridgeDrainTriggers({
      flushPushQueueBestEffort: (args) => this.flushPushQueueBestEffort(args),
    });
  }

  private buildBridgeLifecycleMarkers() {
    return buildBridgeLifecycleMarkers({
      markLastActivityAt: () => {
        this.lastActivityAtGlobal = now();
      },
      markLastAckAt: () => {
        this.lastAckAtGlobal = now();
      },
    });
  }

  private buildInboundSurfaceActivityRuntime() {
    return buildInboundSurfaceActivityRuntime({
      markInboundGlobalActivity: () => {
        this.lastInboundAtGlobal = now();
      },
      incrementInboundEvents: (accountId: string) => {
        this.incrementCounter(this.inboundEventsByAccount, accountId);
      },
      setLastInboundByAccount: (accountId: string, at: number) => {
        this.lastInboundByAccount.set(accountId, at);
      },
      markActivity: (accountId: string, at: number) => {
        this.markActivity(accountId, at);
      },
    });
  }

  private buildInboundSurfaceConnectionRuntime() {
    return buildInboundSurfaceConnectionRuntime({
      shouldIgnoreStaleEvent: (args: Parameters<typeof this.shouldIgnoreStaleEvent>[0]) =>
        this.shouldIgnoreStaleEvent(args),
      observeLease: (
        kind: Parameters<typeof this.observeLease>[0],
        payload: Parameters<typeof this.observeLease>[1],
      ) => this.observeLease(kind, payload),
      matchesTransferOwner: (args: Parameters<typeof this.matchesTransferOwner>[0]) =>
        this.matchesTransferOwner(args),
      refreshAcceptedFileTransferLiveState: (
        args: Parameters<typeof this.refreshAcceptedFileTransferLiveState>[0],
      ) => this.refreshAcceptedFileTransferLiveState(args),
      refreshLiveConnectionState: (args: Parameters<typeof this.refreshLiveConnectionState>[0]) =>
        this.refreshLiveConnectionState(args),
      isOnline: (accountId: string) => this.isOnline(accountId),
      hasRecentInboundReachability: (accountId: string) =>
        this.hasRecentInboundReachability(accountId),
      getActiveConnectionKey: (accountId: string) =>
        this.activeConnectionByAccount.get(accountId) || null,
      buildActiveConnectionDebugList: (accountId: string) =>
        this.buildActiveConnectionDebugList(accountId),
    });
  }

  private buildChannelSendTargetRuntime() {
    return buildChannelSendTargetRuntime({
      resolveVerifiedTarget: (to: string, accountId: string) =>
        this.resolveVerifiedTarget(to, accountId),
      rememberSessionRoute: (sessionKey: string, accountId: string, route: BncrRoute) =>
        this.rememberSessionRoute(sessionKey, accountId, route),
      enqueueFromReply: (args: Parameters<BncrBridgeRuntime['enqueueFromReply']>[0]) =>
        this.enqueueFromReply(args),
    });
  }

  private buildExtendedDiagnostics(
    accountId: string,
    options: {
      runtimeStatusInput?: BncrRuntimeStatusInput;
      integratedDiagnostics?: BncrDiagnosticsSummary;
    } = {},
  ): BncrExtendedDiagnostics {
    return this.bridgeExtendedDiagnosticsFacade.buildExtendedDiagnostics(accountId, options);
  }

  isDebugEnabled(): boolean {
    return BNCR_DEBUG_VERBOSE;
  }

  startService = async (ctx: OpenClawPluginServiceContext, debug?: boolean) => {
    await startBncrBridgeService(
      {
        bridgeId: this.bridgeId,
        setStopped: (value) => {
          this.stopped = value;
        },
        setStatePath: (value) => {
          this.statePath = value;
        },
        getRuntimeConfig: () => getOpenClawRuntimeConfig(this.api),
        initializeCanonicalAgentId: (cfg) => this.initializeCanonicalAgentId(cfg),
        logWarn: (scope, message, options) => this.logWarn(scope, message, options),
        loadState: () => this.loadState(),
        setDebugFlag: (value) => {
          BNCR_DEBUG_VERBOSE = value;
        },
        refreshDebugFlagFromConfig: (options) => this.refreshDebugFlagFromConfig(options),
        buildIntegratedDiagnostics: (accountId) => this.buildIntegratedDiagnostics(accountId),
        logInfo: (scope, message, options) => this.logInfo(scope, message, options),
        getChannelConfigRoot: (cfg) =>
          (((cfg as BncrChannelConfigRoot | null | undefined)?.channels || null)?.[CHANNEL_ID] as
            | Record<string, unknown>
            | undefined) || {},
      },
      ctx,
      debug,
    );
  };

  stopService = async () => {
    await stopBncrBridgeService({
      cleanupRuntime: (reason) => this.cleanupRuntimeWaitersAndTimers(reason),
      flushState: () => this.flushState(),
      logInfo: (scope, message, options) => this.logInfo(scope, message, options),
    });
  };

  shutdown() {
    shutdownBncrBridgeService({
      cleanupRuntime: (reason) => this.cleanupRuntimeWaitersAndTimers(reason),
    });
  }

  private cleanupRuntimeWaitersAndTimers(reason: string) {
    cleanupBncrBridgeRuntime(
      {
        bridgeId: this.bridgeId,
        logInfo: (scope, message, options) => this.logInfo(scope, message, options),
        setStopped: (value) => {
          this.stopped = value;
        },
        clearAllChannelAccountWorkers: (cleanupReason) =>
          this.clearAllChannelAccountWorkers(cleanupReason),
        getMessageAckWaiterCount: () => this.messageAckWaiters.size,
        getFileAckWaiterCount: () => this.fileAckWaiters.size,
        getEarlyFileAckCount: () => this.earlyFileAcks.size,
        getOutboxCount: () => this.outbox.size,
        getRunningDrainAccountCount: () => this.pushDrainRunningAccounts.size,
        getChannelAccountWorkerCount: () => this.channelAccountWorkers.size,
        hasSaveTimer: () => Boolean(this.saveTimer),
        hasPushTimer: () => Boolean(this.pushTimer),
        clearSaveTimer: () => {
          if (!this.saveTimer) return;
          clearTimeout(this.saveTimer);
          this.saveTimer = null;
        },
        clearPushTimer: () => {
          if (!this.pushTimer) return;
          clearTimeout(this.pushTimer);
          this.pushTimer = null;
        },
        clearAllMessageAckWaiters: (result) =>
          this.messageAckRuntime.clearAllMessageAckWaiters(result),
        clearAllFileAckWaiters: (cleanupReason) =>
          this.fileAckRuntime.clearAllFileAckWaiters(cleanupReason),
      },
      reason,
    );
  }

  // Persistence / counters / lightweight bookkeeping -----------------------
  // These helpers manage bounded maps, persistence timers, dead-letter summary
  // helpers, and configuration-derived diagnostics flags shared by later flows.

  private scheduleSave() {
    this.bridgeSupportRuntime.scheduleSave();
  }

  private incrementCounter(map: Map<string, number>, accountId: string) {
    this.bridgeSupportRuntime.incrementCounter(map, accountId);
  }

  private getCounter(map: Map<string, number>, accountId: string): number {
    return this.bridgeSupportRuntime.getCounter(map, accountId);
  }

  private buildDeadLetterDiagnostics(accountId: string) {
    return this.deadLetterDiagnosticsHelpers.buildDeadLetterDiagnostics(accountId);
  }

  // Dead-letter / outbox diagnostics helpers -------------------------------

  private logDeadLetterSummary(accountId: string, options?: { force?: boolean; source?: string }) {
    this.deadLetterDiagnosticsHelpers.logDeadLetterSummary(accountId, options);
  }

  private buildOutboxDiagnostics(accountId: string) {
    return this.outboxDiagnosticsHelpers.buildOutboxDiagnostics(accountId);
  }

  private readonly outboxDiagnosticsHelpers = createBncrOutboxDiagnosticsHelpers({
    normalizeAccountId,
    outboxValues: () => this.outbox.values(),
    pendingAllAccounts: () => this.outbox.size,
    resolvePushConnIds: (accountId) => this.resolvePushConnIds(accountId),
  });

  private readonly deadLetterDiagnosticsHelpers = createBncrDeadLetterDiagnosticsHelpers({
    normalizeAccountId,
    getDeadLetterEntries: () => this.deadLetter,
    maxDeadLetterEntries: MAX_DEAD_LETTER_ENTRIES,
    getCounter: (map, accountId) => this.getCounter(map, accountId),
    deadLetterSinceStartByAccount: this.deadLetterSinceStartByAccount,
    getAccountDeadLetterEntries: (accountId) => this.getAccountDeadLetterEntries(accountId),
    logInfo: (scope, message, options) => this.logInfo(scope, message, options),
    logInfoDedup: (scope, message, options) => this.logInfoDedup(scope, message, options),
  });

  private filterDeadLetterEntries(params: {
    accountId: string;
    reason?: string | null;
    olderThan?: number | null;
  }) {
    return this.deadLetterDiagnosticsHelpers.filterDeadLetterEntries(params);
  }

  // Debug flag / canonical agent resolution --------------------------------

  private async refreshDebugFlagFromConfig(options?: { forceLog?: boolean }) {
    await this.bridgeSupportRuntime.refreshDebugFlagFromConfig(options);
  }

  private async syncDebugFlag() {
    await this.bridgeSupportRuntime.syncDebugFlag();
  }

  private tryResolveBindingAgentId(args: {
    cfg: BncrChannelConfigRoot;
    accountId: string;
    peer?: unknown;
    channelId?: string;
  }): string | null {
    return this.bridgeSupportRuntime.tryResolveBindingAgentId(args);
  }

  private initializeCanonicalAgentId(cfg: BncrChannelConfigRoot) {
    this.bridgeSupportRuntime.initializeCanonicalAgentId(cfg);
  }

  ensureCanonicalAgentId(args: {
    cfg: BncrChannelConfigRoot;
    accountId: string;
    peer?: unknown;
    channelId?: string;
  }): string {
    return this.bridgeSupportRuntime.ensureCanonicalAgentId(args);
  }

  private defaultAdminAgentId(args: {
    cfg: BncrChannelConfigRoot;
    accountId: string;
    peer?: unknown;
    channelId?: string;
  }): string {
    return this.ensureCanonicalAgentId(args);
  }

  private defaultPublicAgentId(): string {
    return 'public';
  }

  private countInvalidOutboxSessionKeys(accountId: string): number {
    return countInvalidOutboxSessionKeysFromRuntime({
      accountId,
      outboxEntries: this.outbox.values(),
    });
  }

  private countLegacyAccountResidue(accountId: string): number {
    return countLegacyAccountResidueFromRuntime({
      accountId,
      outboxEntries: this.outbox.values(),
      deadLetterEntries: this.deadLetter,
      sessionRoutes: this.sessionRoutes.values(),
      lastSessionAccountIds: this.lastSessionByAccount.keys(),
      lastActivityAccountIds: this.lastActivityByAccount.keys(),
      lastInboundAccountIds: this.lastInboundByAccount.keys(),
      lastOutboundAccountIds: this.lastOutboundByAccount.keys(),
    });
  }

  private buildIntegratedDiagnostics(
    accountId: string,
    runtimeStatusInput?: NonNullable<typeof this.runtimeStatusInputType>,
  ) {
    return this.bridgeDiagnosticsFacade.buildIntegratedDiagnostics(accountId, runtimeStatusInput);
  }

  private buildDownlinkHealth(accountId: string) {
    return this.bridgeDiagnosticsFacade.buildDownlinkHealth(accountId);
  }

  // Persistence facade ------------------------------------------------------
  // These methods keep bridge-owned load/dump call sites readable while the
  // actual bounded-state normalization lives in the transient runtime group.

  private normalizePersistedOutboxEntry(entry: unknown): OutboxEntry | null {
    return normalizePersistedOutboxEntryFromRuntime({
      entry: entry as Parameters<typeof normalizePersistedOutboxEntryFromRuntime>[0]['entry'],
      canonicalAgentId: this.canonicalAgentId || '',
      now,
    });
  }

  private loadPersistedAccountTimestampMap(target: Map<string, number>, persisted: unknown): void {
    this.stateStore.loadPersistedAccountTimestampMap(target, persisted);
  }

  private dumpPersistedAccountTimestampMap(source: Map<string, number>) {
    return this.stateStore.dumpPersistedAccountTimestampMap(source);
  }

  private loadPersistedLastSessionMap(persisted: unknown): void {
    this.stateStore.loadPersistedLastSessionMap(persisted);
  }

  private dumpPersistedLastSessionMap() {
    return this.stateStore.dumpPersistedLastSessionMap();
  }

  private loadPersistedSessionRoutes(persisted: unknown): void {
    this.stateStore.loadPersistedSessionRoutes(persisted);
  }

  private dumpPersistedSessionRoutes() {
    return this.stateStore.dumpPersistedSessionRoutes();
  }

  private backfillAccountActivityFromSessionRoutes(): void {
    this.stateStore.backfillAccountActivityFromSessionRoutes();
  }

  private async loadState() {
    await this.stateStore.loadState();
  }

  private async flushState() {
    await this.stateStore.flushState();
  }

  private resolveMessageAck(messageId: string, result: 'acked' | 'timeout' = 'acked') {
    return this.messageAckRuntime.resolveMessageAck(messageId, result);
  }

  // Connection / reachability / transfer-owner facades ---------------------
  // This section bridges high-level runtime callers into the connection-state
  // and outbox-route models that decide current owner/reachability state.

  // Gateway context bookkeeping --------------------------------------------

  private rememberGatewayContext(context: GatewayRequestHandlerOptions['context']) {
    this.bridgeConnectionFacade.rememberGatewayContext(context);
  }

  // Outbound route/owner facades -------------------------------------------
  // These are the narrow bridge-owned entrypoints that ask the route model for
  // current push ownership and recent inbound reachability facts.

  private resolveOutboxPushOwner(accountId: string): BncrConnection | null {
    return this.bridgeConnectionFacade.resolveOutboxPushOwner(accountId);
  }

  private resolvePushConnIds(accountId: string): Set<string> {
    return this.bridgeConnectionFacade.resolvePushConnIds(accountId);
  }

  private hasRecentInboundReachability(accountId: string): boolean {
    return this.bridgeConnectionFacade.hasRecentInboundReachability(accountId);
  }

  private resolveRecentInboundConnIds(accountId: string): Set<string> {
    return this.bridgeConnectionFacade.resolveRecentInboundConnIds(accountId);
  }

  private isRecentlyReachableConn(accountId: string, connId?: string, clientId?: string): boolean {
    return this.bridgeConnectionFacade.isRecentlyReachableConn(accountId, connId, clientId);
  }

  private isRevalidatedAttemptedConn(entry: OutboxEntry, connId: string): boolean {
    return this.bridgeConnectionFacade.isRevalidatedAttemptedConn(entry, connId);
  }

  private tryAdoptTransferOwner(args: {
    accountId: string;
    transfer: FileSendTransferState | FileRecvTransferState | undefined;
    connId: string;
    clientId?: string;
  }): boolean {
    return this.bridgeConnectionFacade.tryAdoptTransferOwner(args);
  }

  private isRetryableFileTransferError(error: unknown): boolean {
    return this.bridgeConnectionFacade.isRetryableFileTransferError(error);
  }

  // File-transfer outbound flow --------------------------------------------
  // This block prepares media, chooses transfer mode, sends chunk/complete
  // frames, and feeds successful media pushes back into the shared outbox path.

  private async pushFileTransferSuccessPath(args: {
    entry: OutboxEntry;
    meta: Record<string, unknown>;
    owner: ReturnType<BncrBridgeRuntime['resolveOutboxPushOwner']>;
    connIds: Iterable<string>;
    recentInboundReachable: boolean;
    routeReason: string;
    mediaUrl: string;
  }): Promise<void> {
    await this.fileTransferPushFacade.pushFileTransferSuccessPath(args);
  }

  private handleFileTransferPushFailure(args: { entry: OutboxEntry; error: unknown }) {
    this.fileTransferPushFacade.handleFileTransferPushFailure(args);
  }

  private handleFileTransferPushGuardFailure(
    args: Parameters<typeof this.fileTransferPushFacade.handleFileTransferPushGuardFailure>[0],
  ) {
    this.fileTransferPushFacade.handleFileTransferPushGuardFailure(args);
  }

  // File-transfer outbound entry builders / dedupe -------------------------

  private async tryPushFileTransferEntry(
    entry: OutboxEntry,
    meta: Record<string, unknown>,
  ): Promise<boolean> {
    return await runBncrFileTransferOutboxPush({
      entry,
      meta,
      gatewayContext: this.gatewayContext,
      owner: this.resolveOutboxPushOwner(entry.accountId),
      resolvePushConnIds: (accountId) => this.resolvePushConnIds(accountId),
      resolveRecentInboundConnIds: (accountId) => this.resolveRecentInboundConnIds(accountId),
      hasRecentInboundReachability: (accountId) => this.hasRecentInboundReachability(accountId),
      isRevalidatedAttemptedConn: (connId) => this.isRevalidatedAttemptedConn(entry, connId),
      handleFileTransferPushGuardFailure: (flowArgs) =>
        this.handleFileTransferPushGuardFailure(flowArgs),
      pushFileTransferSuccessPath: (flowArgs) => this.pushFileTransferSuccessPath(flowArgs),
      handleFileTransferPushFailure: (flowArgs) => this.handleFileTransferPushFailure(flowArgs),
    });
  }

  private buildFileTransferOutboxEntry(params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
    text?: string;
    asVoice?: boolean;
    audioAsVoice?: boolean;
    type?: string;
    extra?: Record<string, unknown>;
    kind?: 'tool' | 'block' | 'final';
    replyToId?: string;
    replyTargetPolicy?: OutboundReplyTargetPolicy;
  }): OutboxEntry {
    return buildFileTransferOutboxEntryFromRuntime({
      createMessageId: () => randomUUID(),
      now,
      normalizeAccountId,
      pushEvent: BNCR_PUSH_EVENT,
      accountId: params.accountId,
      sessionKey: params.sessionKey,
      route: params.route,
      mediaUrl: params.mediaUrl,
      mediaLocalRoots: params.mediaLocalRoots,
      text: asString(params.text || ''),
      asVoice: params.asVoice,
      audioAsVoice: params.audioAsVoice,
      type: params.type,
      extra: params.extra,
      kind: params.kind,
      replyToId: asString(params.replyToId || '').trim() || undefined,
      replyTargetPolicy: params.replyTargetPolicy,
    });
  }

  private pruneMediaDedupeCache(sessionKey: string, currentTime = now()) {
    this.mediaDedupeRuntime.pruneMediaDedupeCache(sessionKey, currentTime);
  }

  private rememberRecentMediaSend(params: {
    sessionKey: string;
    mediaUrl: string;
    text: string;
    replyToId: string;
    createdAt?: number;
  }) {
    this.mediaDedupeRuntime.rememberRecentMediaSend(params);
  }

  private tryBuildMediaDedupeFallback(params: {
    sessionKey: string;
    mediaUrl: string;
    text: string;
    replyToId: string;
    currentTime?: number;
  }): { text: string; reason: 'same-text-sent-checkmark' | 'text-changed-downgrade' } | null {
    return this.mediaDedupeRuntime.tryBuildMediaDedupeFallback(params);
  }

  private buildFileTransferOutboundFrame(params: {
    entry: OutboxEntry;
    meta: Record<string, unknown>;
    media: { fileName?: string; mimeType?: string; path?: string; base64?: string; type?: string };
    mediaUrl: string;
  }) {
    const wantsVoice = params.meta.asVoice === true || params.meta.audioAsVoice === true;
    const messageKind =
      params.meta.messageKind === 'tool' ||
      params.meta.messageKind === 'block' ||
      params.meta.messageKind === 'final'
        ? params.meta.messageKind
        : undefined;

    return buildBncrMediaOutboundFrame({
      messageId: params.entry.messageId,
      sessionKey: params.entry.sessionKey,
      route: params.entry.route,
      media: {
        mode: params.media.path ? 'chunk' : 'base64',
        mimeType: params.media.mimeType,
        fileName: params.media.fileName,
        mediaBase64: params.media.base64,
        path: params.media.path,
      },
      mediaUrl: params.mediaUrl,
      mediaMsg: asString(params.meta.text || ''),
      fileName: resolveOutboundFileName({
        mediaUrl: params.mediaUrl,
        fileName: params.media.fileName,
        mimeType: params.media.mimeType,
      }),
      hintedType: wantsVoice ? 'voice' : asString(params.meta.type || '') || undefined,
      extra: params.meta.extra as Record<string, unknown> | undefined,
      kind: messageKind,
      replyToId: normalizeReplyToId(params.meta.replyToId) || undefined,
      now: now(),
    });
  }

  // Outbound enqueue / push / ACK / retry flow -----------------------------
  // This is the core outbound state machine: build entries, enqueue them,
  // push them, observe ACK outcomes, and terminate in retry or dead-letter.

  private buildTextOutboxEntry(params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    text: string;
    kind?: 'tool' | 'block' | 'final';
    replyToId?: string;
    replyTargetPolicy?: OutboundReplyTargetPolicy;
  }): OutboxEntry {
    return buildTextOutboxEntryFromRuntime({
      createMessageId: () => randomUUID(),
      now,
      normalizeAccountId,
      normalizeReplyToId,
      accountId: params.accountId,
      sessionKey: params.sessionKey,
      route: params.route,
      text: params.text,
      kind: params.kind,
      replyToId: params.replyToId,
      replyTargetPolicy: params.replyTargetPolicy,
    });
  }

  private async tryPushEntry(entry: OutboxEntry): Promise<boolean> {
    const meta = isPlainObject(entry.payload?._meta) ? entry.payload._meta : null;
    if (meta?.kind === 'file-transfer') {
      return this.tryPushFileTransferEntry(entry, meta);
    }

    return this.tryPushTextEntry(entry);
  }

  private pushTextSuccessPath(args: {
    entry: OutboxEntry;
    owner: ReturnType<BncrBridgeRuntime['resolveOutboxPushOwner']>;
    connIds: Iterable<string>;
    recentInboundReachable: boolean;
    routeReason: string;
    ownerConnId?: string;
  }) {
    this.outboxPush.pushTextSuccessPath(args);
  }

  private handleTextPushFailure(args: { entry: OutboxEntry; error: unknown }) {
    this.outboxPush.handleTextPushFailure(args);
  }

  // Text outbound push runtime bridge --------------------------------------

  // Outbound diagnostics/logging helpers -----------------------------------
  // Keep the compact logging helpers adjacent to the outbound state machine so
  // queue transitions and emitted diagnostics remain easy to correlate.

  private async tryPushTextEntry(entry: OutboxEntry): Promise<boolean> {
    return await runBncrTextOutboxPush({
      entry,
      gatewayContext: this.gatewayContext,
      owner: this.resolveOutboxPushOwner(entry.accountId),
      resolvePushConnIds: (accountId) => this.resolvePushConnIds(accountId),
      resolveRecentInboundConnIds: (accountId) => this.resolveRecentInboundConnIds(accountId),
      hasRecentInboundReachability: (accountId) => this.hasRecentInboundReachability(accountId),
      isRevalidatedAttemptedConn: (connId) => this.isRevalidatedAttemptedConn(entry, connId),
      recordOutboxPrePushFailure: (flowArgs) => this.recordOutboxPrePushFailure(flowArgs),
      logOutboxPushSkip: (flowArgs) => this.logOutboxPushSkip(flowArgs),
      pushTextSuccessPath: (flowArgs) => this.pushTextSuccessPath(flowArgs),
      handleTextPushFailure: (flowArgs) => this.handleTextPushFailure(flowArgs),
    });
  }

  private logOutboxPushSkip(args: {
    messageId: string;
    accountId: string;
    kind?: 'file-transfer';
    reason: string;
    recentInboundReachable?: boolean;
    routeReason?: string;
    connIds?: Iterable<string>;
    ownerConnId?: string;
    ownerClientId?: string;
  }) {
    this.outboxPush.logOutboxPushSkip(args);
  }

  private logOutboxRouteSelect(args: {
    messageId: string;
    accountId: string;
    kind?: 'file-transfer';
    routeReason: string;
    connIds: Iterable<string>;
    ownerConnId: string;
    ownerClientId: string;
    recentInboundReachable: boolean;
    event: string;
  }) {
    this.outboxPush.logOutboxRouteSelect(args);
  }

  private logOutboxPushFailure(args: {
    messageId: string;
    accountId: string;
    retryCount: number;
    kind?: 'file-transfer';
    retryable?: boolean;
    lastError?: string;
  }) {
    this.outboxPush.logOutboxPushFailure(args);
  }

  private logOutboxPushOkSummary(messageId: string) {
    this.outboxPush.logOutboxPushOkSummary(messageId);
  }

  private logOutboxPushFailureSummary(messageId: string, lastError?: string) {
    this.outboxPush.logOutboxPushFailureSummary(messageId, lastError);
  }

  private logOutboxAckSummary(
    scope:
      | 'outbox ack ok'
      | 'outbox ack ok late'
      | 'outbox ack retry'
      | 'outbox ack timeout'
      | 'outbox ack fatal',
    args: {
      messageId: string;
      connId?: string;
      clientId?: string;
      err?: string;
      queueMs?: number | null;
      pushMs?: number | null;
      waitMs?: number | null;
    },
  ) {
    this.outboxAckLogs.logOutboxAckSummary(scope, args);
  }

  private logOutboxAckWait(args: {
    entry: OutboxEntry;
    requireAck: boolean;
    ackResult: 'acked' | 'timeout';
    onlineNow: boolean;
    recentInboundReachable: boolean;
    ackTimeoutMs?: number | null;
  }) {
    this.outboxAckLogs.logOutboxAckWait(args);
  }

  private logOutboxAckReroute(args: Parameters<typeof this.outboxAckLogs.logOutboxAckReroute>[0]) {
    this.outboxAckLogs.logOutboxAckReroute(args);
  }

  private prepareAckHandling(args: {
    params: GatewayRequestHandlerOptions['params'];
    respond: GatewayRequestHandlerOptions['respond'];
    client: GatewayRequestHandlerOptions['client'];
    context: GatewayRequestHandlerOptions['context'];
  }): {
    accountId: string;
    connId: string;
    clientId?: string;
    messageId: string;
    entry: OutboxEntry;
    staleObserved: { stale: boolean };
  } | null {
    return this.messageAckRuntime.prepareAckHandling(args);
  }

  // ACK telemetry and queue outcome transitions ----------------------------
  // This section records account-scoped ACK observability and delegates the
  // concrete queue transition to the dedicated ACK outcome runtime.

  private recordAckOkTelemetry(args: {
    accountId: string;
    entry: OutboxEntry;
    telemetryPatch: BncrOutboxAckOkTelemetryPatch;
  }) {
    const { accountId, entry, telemetryPatch } = args;
    const { ackAt, ackQueueLatencyMs, ackPushLatencyMs } = telemetryPatch;
    this.lastAckOkByAccount.set(accountId, ackAt);
    this.lastAckQueueLatencyMsByAccount.set(accountId, ackQueueLatencyMs);
    if (typeof ackPushLatencyMs === 'number') {
      this.lastAckPushLatencyMsByAccount.set(accountId, ackPushLatencyMs);
    }
    if (telemetryPatch.shouldResetAdaptiveAckRecovery) {
      this.adaptiveAckRecoveryOkCountByAccount.set(accountId, 0);
      this.lateAckOkCountByAccount.set(
        accountId,
        this.getCounter(this.lateAckOkCountByAccount, accountId) + 1,
      );
      this.lastLateAckOkByAccount.set(accountId, ackAt);
      this.lastLateAckQueueLatencyMsByAccount.set(accountId, ackQueueLatencyMs);
      if (typeof ackPushLatencyMs === 'number') {
        this.lastLateAckPushLatencyMsByAccount.set(accountId, ackPushLatencyMs);
      }
      entry.awaitingRetryPush = false;
      entry.lastError = undefined;
    } else if (telemetryPatch.shouldIncrementAdaptiveAckRecovery) {
      this.adaptiveAckRecoveryOkCountByAccount.set(
        accountId,
        this.getCounter(this.adaptiveAckRecoveryOkCountByAccount, accountId) + 1,
      );
    }
  }

  private recordAckTimeoutTelemetry(accountId: string) {
    this.lastAckTimeoutByAccount.set(accountId, now());
    this.ackTimeoutCountByAccount.set(
      accountId,
      this.getCounter(this.ackTimeoutCountByAccount, accountId) + 1,
    );
    this.adaptiveAckRecoveryOkCountByAccount.set(accountId, 0);
  }

  private handleAckOk(args: {
    accountId: string;
    messageId: string;
    connId: string;
    clientId?: string;
    stale: boolean;
    entry: OutboxEntry;
  }) {
    this.outboxAckOutcome.handleAckOk(args);
  }

  private handleAckFatal(args: {
    entry: OutboxEntry;
    messageId: string;
    connId: string;
    clientId?: string;
    error: string;
  }) {
    this.outboxAckOutcome.handleAckFatal(args);
  }

  private handleAckRetry(args: {
    entry: OutboxEntry;
    messageId: string;
    connId: string;
    clientId?: string;
    error: string;
  }) {
    this.outboxAckOutcome.handleAckRetry(args);
  }

  private handleAckOutcome(args: {
    params: GatewayRequestHandlerOptions['params'];
    respond: GatewayRequestHandlerOptions['respond'];
    accountId: string;
    connId: string;
    clientId?: string;
    messageId: string;
    entry: OutboxEntry;
    staleObserved: { stale: boolean };
  }) {
    this.messageAckRuntime.handleAckOutcome(args);
  }

  // Inbound acceptance bridge ----------------------------------------------
  // Keep this handoff near ACK/outbound flow because inbound acceptance feeds
  // reply enqueue and dedupe state that later re-enters the same outbox path.

  private async prepareInboundAcceptance(args: {
    parsed: ReturnType<typeof parseBncrInboundParams>;
    canonicalAgentId: string;
  }): Promise<
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
        payload: ReturnType<typeof buildInboundResponsePayload>;
      }
  > {
    return await prepareBncrInboundAcceptance({
      api: this.api,
      parsed: args.parsed,
      canonicalAgentId: args.canonicalAgentId,
      asString,
      now,
      getRuntimeConfig: (api) => getOpenClawRuntimeConfig(api as OpenClawChannelRuntimeApiHolder),
      resolveAgentRoute: (params) =>
        resolveOpenClawAgentRoute(this.api as OpenClawChannelRuntimeApiHolder, params),
      buildInboundResponsePayload,
      markInboundDedupSeen: (key) => this.markInboundDedupSeen(key),
      sceneRegistry: this.sceneRegistry,
      defaultAdminAgentId: this.defaultAdminAgentId({
        cfg: getOpenClawRuntimeConfig(this.api as OpenClawChannelRuntimeApiHolder),
        accountId: args.parsed.accountId,
        peer: args.parsed.peer,
        channelId: CHANNEL_ID,
      }),
      defaultPublicAgentId: this.defaultPublicAgentId(),
    });
  }

  // Live connection refresh after outbound/inbound events ------------------
  // ACK/push/inbound outcomes may refresh or degrade live connection state.
  // Keep these bridge facades near the outbound flow so causal review stays local.

  private refreshLiveConnectionState(args: {
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady: boolean;
    preferredForOutbound: boolean;
    inboundOnly: boolean;
    context: GatewayRequestHandlerOptions['context'];
  }) {
    this.bridgeConnectionFacade.refreshLiveConnectionState(args);
  }

  private refreshAcceptedFileTransferLiveState(args: {
    accountId: string;
    connId: string;
    clientId?: string;
    context: GatewayRequestHandlerOptions['context'];
  }) {
    this.bridgeConnectionFacade.refreshAcceptedFileTransferLiveState(args);
  }

  private logOutboxPushOk(args: {
    messageId: string;
    accountId: string;
    kind?: 'file-transfer';
    connIds: Iterable<string>;
    ownerConnId: string;
    ownerClientId: string;
    recentInboundReachable: boolean;
    event: string;
  }) {
    this.outboxPush.logOutboxPushOk(args);
  }

  // Outbox mutation / scheduler helpers ------------------------------------

  private recordOutboxPrePushFailure(args: {
    entry: OutboxEntry;
    lastError: string;
    persist?: boolean;
  }) {
    this.bridgeOutboxFacade.recordOutboxPrePushFailure(args);
  }

  private recordPrePushGuardSkip(args: { accountId: string; reason: string }) {
    this.bridgeOutboxFacade.recordPrePushGuardSkip(args);
  }

  private isPrePushGuardDeferral(entry: OutboxEntry) {
    return this.bridgeOutboxFacade.isPrePushGuardDeferral(entry);
  }

  private recordOutboxPushFailure(args: {
    entry: OutboxEntry;
    error: unknown;
    fallbackError: string;
    persist?: boolean;
  }) {
    this.bridgeOutboxFacade.recordOutboxPushFailure(args);
  }

  private recordOutboxPushSuccess(args: {
    entry: OutboxEntry;
    connIds: Iterable<string>;
    ownerConnId?: string;
    ownerClientId?: string;
    clearLastError?: boolean;
  }) {
    this.bridgeOutboxFacade.recordOutboxPushSuccess(args);
  }

  private schedulePushDrain(delayMs = 0) {
    this.bridgeDrainFacade.schedulePushDrain(delayMs);
  }

  private flushPushQueueBestEffort(args?: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }) {
    this.bridgeDrainFacade.flushPushQueueBestEffort(args);
  }

  private isOutboundAckRequired(accountId?: string) {
    return this.bridgeDrainFacade.isOutboundAckRequired(accountId);
  }

  // Runtime group assembly --------------------------------------------------

  // Runtime group assembly --------------------------------------------------
  // Read this block top-to-bottom as the bridge composition root:
  // 1) connection / lease ownership
  // 2) outbound ACK + drain state machine
  // 3) file-transfer lifecycle
  // 4) route / outbox push selection
  // 5) persistence + status projections
  // 6) bridge-owned facades and host surfaces
  //
  // Wiring rule: once a runtime slice grows, prefer grouped dependencies
  // (state / io / policy / helpers) over widening one anonymous callback bag.
  // The bridge owns composition; leaf runtimes should receive focused slices.

  // Phase 1: connection / lease / reachability ------------------------------
  private readonly connectionStateRuntimeGroup = createBncrConnectionStateRuntimeGroup({
    bridgeId: this.bridgeId,
    now,
    asString,
    connectTtlMs: CONNECT_TTL_MS,
    recentInboundSendWindowMs: RECENT_INBOUND_SEND_WINDOW_MS,
    outboundReadyTtlMs: OUTBOUND_READY_TTL_MS,
    preferredOutboundTtlMs: PREFERRED_OUTBOUND_TTL_MS,
    connections: this.connections,
    activeConnectionByAccount: this.activeConnectionByAccount,
    lastInboundByAccount: this.lastInboundByAccount,
    lastActivityByAccount: this.lastActivityByAccount,
    gcTransientState: () => this.gcTransientState(),
    connectionKey: (accountId, clientId) => this.connectionKey(accountId, clientId),
    buildActiveConnectionDebugList: (accountId, options) =>
      this.buildActiveConnectionDebugList(accountId, options),
    rememberGatewayContext: (context) => this.rememberGatewayContext(context),
    markActivity: (accountId, at) => this.markActivity(accountId, at),
    logInfo: (scope, message, options) => this.logInfo(scope, message, options),
    logInfoDedupJson: (scope, label, payload, options) =>
      this.logInfoDedupJson(scope, label, isPlainObject(payload) ? payload : { payload }, {
        key: options?.key || label,
        sig: options?.sig || JSON.stringify(payload),
        debugOnly: options?.debugOnly,
      }),
  });

  private readonly connectionState = this.connectionStateRuntimeGroup.connectionState;

  // Phase 2: outbound ACK / drain -------------------------------------------
  private readonly ackOutboxRuntimeGroup = createBncrAckOutboxRuntimeGroup({
    bridgeId: this.bridgeId,
    pushEvent: BNCR_PUSH_EVENT,
    now,
    asString,
    backoffMs,
    isPlainObject,
    clampFiniteNumber: (value, fallback, min, max) =>
      clampFiniteNumber(value, fallback, min ?? fallback, max ?? fallback),
    normalizeAccountId,
    formatDisplayScope,
    isFileTransferEntry: (entry) =>
      isPlainObject(entry.payload?._meta) && entry.payload?._meta?.kind === 'file-transfer',
    recommendedAckTimeoutMaxMs: RECOMMENDED_ACK_TIMEOUT_MAX_MS,
    adaptiveAckTimeoutEnabled: ADAPTIVE_ACK_TIMEOUT_DEFAULT_ENABLED,
    defaultAckTimeoutMs: PUSH_ACK_TIMEOUT_MS,
    stopped: () => this.stopped,
    outbox: this.outbox,
    deadLetter: () => this.deadLetter,
    connectionsValues: () => this.connections.values(),
    gatewayContextAvailable: () => Boolean(this.gatewayContext),
    messageAckWaiters: this.messageAckWaiters,
    fileAckWaiterCount: () => this.fileAckWaiters.size,
    activeConnectionCount: (accountId) => this.activeConnectionCount(accountId),
    getAccountPendingOutboxEntries: (accountId) => this.getAccountPendingOutboxEntries(accountId),
    pushDrainRunningAccounts: this.pushDrainRunningAccounts,
    pushDrainRunningSinceByAccount: this.pushDrainRunningSinceByAccount,
    pushDrainStuckWarnedAtByAccount: this.pushDrainStuckWarnedAtByAccount,
    isOnline: (accountId) => this.isOnline(accountId),
    hasRecentInboundReachability: (accountId) => this.hasRecentInboundReachability(accountId),
    isOutboundAckRequired: (accountId) => this.isOutboundAckRequired(accountId),
    resolveMessageAckTimeoutMs: (accountId) => this.resolveMessageAckTimeoutMs(accountId),
    waitForMessageAck: (messageId, waitMs) => this.waitForMessageAck(messageId, waitMs),
    resolvePushConnIds: (accountId) => this.resolvePushConnIds(accountId),
    sleepMs: (ms) => this.sleepMs(ms),
    schedulePushDrain: (delayMs) => this.schedulePushDrain(delayMs),
    tryPushEntry: (entry) => this.tryPushEntry(entry),
    handleFileTransferPushFailure: (args) => this.handleFileTransferPushFailure(args),
    handleTextPushFailure: (args) => this.handleTextPushFailure(args),
    isPrePushGuardDeferral: (entry) => this.isPrePushGuardDeferral(entry),
    resolveAccountIdForSession: (sessionKey) => {
      const hit = this.sessionRoutes.get(sessionKey);
      return hit ? hit.accountId : BNCR_DEFAULT_ACCOUNT_ID;
    },
    scheduleSave: () => this.scheduleSave(),
    logInfo: (scope, message, options) => this.logInfo(scope, message, options),
    logWarn: (scope, message, options) => this.logWarn(scope, message, options),
    logError: (scope, message) => this.logError(scope, message),
    observeLease: (kind, payload) => this.observeLease(kind, payload),
    rememberGatewayContext: (context) => this.rememberGatewayContext(context),
    markSeen: (accountId, connId, clientId) => this.markSeen(accountId, connId, clientId),
    markOutboundCapability: (args) => this.markOutboundCapability(args),
    recordAckOkTelemetry: (args) => this.recordAckOkTelemetry(args),
    deleteOutboxEntry: (messageId) => this.outbox.delete(messageId),
    setOutboxEntry: (messageId, entry) => this.outbox.set(messageId, entry),
    resolveMessageAck: (messageId, result) => this.resolveMessageAck(messageId, result),
    moveToDeadLetter: (entry, reason) => this.moveToDeadLetter(entry, reason),
    recordAckTimeoutTelemetry: (accountId) => this.recordAckTimeoutTelemetry(accountId),
    degradeOutboundCapability: (args) => this.degradeOutboundCapability(args),
    flushPushQueueBestEffort: (args) => this.flushPushQueueBestEffort(args),
    flushTriggerTimer: OUTBOUND_FLUSH_TRIGGER.TIMER,
    flushReasonScheduledDrain: OUTBOUND_FLUSH_REASON.SCHEDULED_DRAIN,
    outboundFlushTriggerAckOk: OUTBOUND_FLUSH_TRIGGER.ACK_OK,
    outboundFlushReasonMessageAcked: OUTBOUND_FLUSH_REASON.MESSAGE_ACKED,
    pushDrainExceptionRetryLimit: PUSH_DRAIN_EXCEPTION_RETRY_LIMIT,
    pushDrainExceptionRetryDelayMs: PUSH_DRAIN_EXCEPTION_RETRY_DELAY_MS,
    pushDrainStuckWarnMs: PUSH_DRAIN_STUCK_WARN_MS,
    pushDrainIntervalMs: PUSH_DRAIN_INTERVAL_MS,
    pushDrainAccountTimeBudgetMs: PUSH_DRAIN_ACCOUNT_TIME_BUDGET_MS,
    pushDrainAccountBudget: PUSH_DRAIN_ACCOUNT_BUDGET,
    pushAckTimeoutMs: PUSH_ACK_TIMEOUT_MS,
    maxRetry: MAX_RETRY,
    prePushGuardRetryDelayMs: PRE_PUSH_GUARD_RETRY_DELAY_MS,
  });

  private readonly outboxAckLogs = this.ackOutboxRuntimeGroup.outboxAckLogs;
  private readonly outboxAckOutcome = this.ackOutboxRuntimeGroup.outboxAckOutcome;
  private readonly messageAckRuntime = this.ackOutboxRuntimeGroup.messageAckRuntime;
  private readonly outboxDrainAck = this.ackOutboxRuntimeGroup.outboxDrainAck;
  private readonly outboxDrainSchedule = this.ackOutboxRuntimeGroup.outboxDrainSchedule;
  private readonly outboxDrainRuntime = this.ackOutboxRuntimeGroup.outboxDrainRuntime;

  // Phase 3: file transfer --------------------------------------------------
  // Keep file-transfer wiring adjacent to ACK/outbox wiring because chunk
  // waits, waiter cleanup, and outbound delivery all share the same queue
  // lifecycle and shutdown boundaries.

  private readonly fileTransferRuntimeGroup = createBncrFileTransferRuntimeGroup({
    bridgeId: this.bridgeId,
    now,
    asString,
    clampFiniteNumber: (value, fallback, min, max) =>
      clampFiniteNumber(value, fallback, min ?? fallback, max ?? fallback),
    fileAckTimeoutMs: FILE_ACK_TIMEOUT_MS,
    maxEarlyFileAcks: MAX_EARLY_FILE_ACKS,
    fileAckWaiters: this.fileAckWaiters,
    earlyFileAcks: this.earlyFileAcks,
    getFileAckOwnerInfo: (transferId) => this.fileAckOwnerInfo(transferId),
    fileForceChunk: FILE_FORCE_CHUNK,
    fileInlineThreshold: FILE_INLINE_THRESHOLD,
    normalizeAccountId,
    loadOutboundTransferMedia: (args) => this.loadOutboundTransferMedia(args),
    resolveOutboxPushOwner: (accountId) => this.resolveOutboxPushOwner(accountId),
    hasRecentInboundReachability: (accountId) => this.hasRecentInboundReachability(accountId),
    buildTransferRouteDiagnostics: (args) =>
      this.buildTransferRouteDiagnostics(args) as {
        activeConnectionKey: string | null;
        directConnIds: Set<string>;
        recentConnIds: Set<string>;
        accountConnections: Array<{
          connId: string;
          clientId?: string;
          connectedAt: number;
          lastSeenAt: number;
        }>;
      },
    selectTransferConnIds: (args) => new Set(this.selectTransferConnIds(args)),
    broadcastToConnIds: (event, payload, connIds) =>
      this.gatewayContext!.broadcastToConnIds(event, payload, connIds),
    chunkEvent: BNCR_FILE_CHUNK_EVENT,
    completeEvent: BNCR_FILE_COMPLETE_EVENT,
    logInfo: (scope, message, options) => this.logInfo(scope, message, options),
    logWarn: (scope, message, options) => this.logWarn(scope, message, options),
  });

  private readonly fileAckRuntime = this.fileTransferRuntimeGroup.fileAckRuntime;
  private readonly fileTransferLogs = this.fileTransferRuntimeGroup.fileTransferLogs;
  private readonly fileTransferSetup = this.fileTransferRuntimeGroup.fileTransferSetup;
  private readonly fileTransferSend = this.fileTransferRuntimeGroup.fileTransferSend;

  // Runtime wiring: route selection / push bookkeeping ----------------------

  // Phase 4: route / push selection ----------------------------------------
  private readonly outboxPushRouteRuntimeGroup = createBncrOutboxPushRouteRuntimeGroup({
    bridgeId: this.bridgeId,
    pushEvent: BNCR_PUSH_EVENT,
    now,
    connectTtlMs: CONNECT_TTL_MS,
    finiteNumberOr,
    outboxSize: () => this.outbox.size,
    gatewayBroadcastToConnIds: (event, payload, connIds) =>
      this.gatewayContext!.broadcastToConnIds(event, payload, connIds),
    recordOutboxPushSuccess: (args) => this.recordOutboxPushSuccess(args),
    recordOutboxPushFailure: (args) => this.recordOutboxPushFailure(args),
    recordOutboxPrePushFailure: (args) => this.recordOutboxPrePushFailure(args),
    recordPrePushGuardSkip: (args) => this.recordPrePushGuardSkip(args),
    moveToDeadLetter: (entry, reason) => this.moveToDeadLetter(entry, reason),
    activeConnectionCount: (accountId) => this.activeConnectionCount(accountId),
    connections: this.connections,
    connectionsValues: () => this.connections.values(),
    activeConnectionByAccount: this.activeConnectionByAccount,
    resolveRecentInboundConnIds: (accountId) => this.resolveRecentInboundConnIds(accountId),
    connectionKey: (accountId, clientId) => this.connectionKey(accountId, clientId),
    isRetryableFileTransferError: (value) => this.isRetryableFileTransferError(value),
    logInfo: (scope, message, options) => this.logInfo(scope, message, options),
    buildActiveConnectionDebugList: (accountId, options) =>
      this.buildActiveConnectionDebugList(accountId, options),
  });

  private readonly outboxPush = this.outboxPushRouteRuntimeGroup.outboxPush;
  private readonly outboxRoute = this.outboxPushRouteRuntimeGroup.outboxRoute;

  // Runtime wiring: persistence / transient cleanup -------------------------
  // Phase 5: persistence / transient state ---------------------------------
  private readonly stateTransientRuntimeGroup = createBncrStateTransientRuntimeGroup({
    bridgeId: this.bridgeId,
    getStatePath: () => this.statePath,
    now,
    asString,
    finiteNumberOr,
    normalizeAccountId,
    normalizeStoredSessionKey,
    parseRouteLike,
    routeKey,
    formatDisplayScope,
    canonicalAgentId: () => this.canonicalAgentId || '',
    normalizePersistedOutboxEntry: (entry) => this.normalizePersistedOutboxEntry(entry),
    maxDeadLetterEntries: MAX_DEAD_LETTER_ENTRIES,
    maxSessionRouteEntries: MAX_SESSION_ROUTE_ENTRIES,
    maxAccountActivityEntries: MAX_ACCOUNT_ACTIVITY_ENTRIES,
    sceneRegistry: this.sceneRegistry,
    groupHistories: this.groupHistories,
    outbox: this.outbox,
    getDeadLetter: () => this.deadLetter,
    setDeadLetter: (entries) => {
      this.deadLetter = entries;
    },
    sessionRoutes: this.sessionRoutes,
    routeAliases: this.routeAliases,
    lastSessionByAccount: this.lastSessionByAccount,
    lastActivityByAccount: this.lastActivityByAccount,
    lastInboundByAccount: this.lastInboundByAccount,
    lastOutboundByAccount: this.lastOutboundByAccount,
    getLastDriftSnapshot: () => this.lastDriftSnapshot,
    setLastDriftSnapshot: (value) => {
      this.lastDriftSnapshot = value;
    },
    connectTtlMs: CONNECT_TTL_MS,
    fileTransferKeepMs: FILE_TRANSFER_KEEP_MS,
    fileTransferTerminalKeepMs: FILE_TRANSFER_TERMINAL_KEEP_MS,
    fileTransferAckTtlMs: FILE_TRANSFER_ACK_TTL_MS,
    connections: this.connections,
    activeConnectionByAccount: this.activeConnectionByAccount,
    recentInbound: this.recentInbound,
    fileSendTransfers: this.fileSendTransfers,
    fileRecvTransfers: this.fileRecvTransfers,
    earlyFileAcks: this.earlyFileAcks,
    logInfo: (scope, message, options) => this.logInfo(scope, message, options),
  });

  private readonly stateStore = this.stateTransientRuntimeGroup.stateStore;
  private readonly transientStateRuntime = this.stateTransientRuntimeGroup.transientStateRuntime;

  // Runtime wiring: session routing / target / media dedupe -----------------
  // Phase 6: status / target projections -----------------------------------
  private readonly targetStatusRuntimeGroup = createBncrTargetStatusRuntimeGroup({
    api: this.runtimeApi,
    channelId: CHANNEL_ID,
    canonicalAgentId: this.canonicalAgentId,
    getPluginRoot: () => this.pluginRoot,
    startedAt: this.startedAt,
    debugVerbose: BNCR_DEBUG_VERBOSE,
    adaptiveAckTimeoutEnabled: ADAPTIVE_ACK_TIMEOUT_DEFAULT_ENABLED,
    defaultMessageAckTimeoutMs: PUSH_ACK_TIMEOUT_MS,
    fileAckTimeoutMs: FILE_ACK_TIMEOUT_MS,
    maxAckTimeoutMs: RECOMMENDED_ACK_TIMEOUT_MAX_MS,
    now,
    normalizeAccountId,
    sessionRoutes: this.sessionRoutes,
    routeAliases: this.routeAliases,
    lastSessionByAccount: this.lastSessionByAccount,
    markActivity: (accountId, at) => this.markActivity(accountId, at),
    scheduleSave: () => this.scheduleSave(),
    logInfo: (scope, message, options) => this.logInfo(scope, message, options),
    logWarn: (scope, message, options) => this.logWarn(scope, message, options),
    ensureCanonicalAgentId: (args) => this.ensureCanonicalAgentId(args),
    recentMediaDedupeBySession: this.recentMediaDedupeBySession,
    resolveMessageAckTimeoutMs: (accountId) => this.resolveMessageAckTimeoutMs(accountId),
    isOnline: (accountId) => this.isOnline(accountId),
    outboxValues: () => this.outbox.values(),
    deadLetterEntries: () => this.deadLetter,
    sessionRouteValues: () => this.sessionRoutes.values(),
    countInvalidOutboxSessionKeys: (accountId) => this.countInvalidOutboxSessionKeys(accountId),
    countLegacyAccountResidue: (accountId) => this.countLegacyAccountResidue(accountId),
    connectEventsByAccount: this.connectEventsByAccount,
    inboundEventsByAccount: this.inboundEventsByAccount,
    activityEventsByAccount: this.activityEventsByAccount,
    ackEventsByAccount: this.ackEventsByAccount,
    activeConnectionCount: (accountId) => this.activeConnectionCount(accountId),
    lastActivityByAccount: this.lastActivityByAccount,
    lastInboundByAccount: this.lastInboundByAccount,
    lastOutboundByAccount: this.lastOutboundByAccount,
    buildRuntimeAckObservability: (accountId) => this.buildRuntimeAckObservability(accountId),
    buildRuntimeAckStrategy: (ackObservability) => this.buildRuntimeAckStrategy(ackObservability),
    lastAckOkByAccount: this.lastAckOkByAccount,
    lastAckTimeoutByAccount: this.lastAckTimeoutByAccount,
    getAckTimeoutCount: (accountId) => this.getCounter(this.ackTimeoutCountByAccount, accountId),
    getAccountPendingOutboxEntries: (accountId) => this.getAccountPendingOutboxEntries(accountId),
    getAccountDeadLetterEntries: (accountId) => this.getAccountDeadLetterEntries(accountId),
    connectionsValues: () => this.connections.values(),
    connectTtlMs: CONNECT_TTL_MS,
  });

  private readonly targetRuntime = this.targetStatusRuntimeGroup.targetRuntime;
  private readonly mediaDedupeRuntime = this.targetStatusRuntimeGroup.mediaDedupeRuntime;

  // Runtime wiring: status / diagnostics ------------------------------------
  private readonly statusRuntime = this.targetStatusRuntimeGroup.statusRuntime;
  private declare readonly runtimeStatusInputType?: Parameters<
    typeof this.statusRuntime.buildIntegratedDiagnostics
  >[1];

  // Phase 7: bridge-owned facades ------------------------------------------
  // These facades expose stable replacement points for lifecycle, status,
  // diagnostics, drain, and media behavior without leaking the bridge's full
  // internal state surface into every caller.
  private readonly bridgeStatusFacade = createBncrBridgeStatusFacade({
    statusProjection: buildBncrStatusProjectionRuntime({
      buildRuntimeStatusInput: (accountId, overrides) =>
        this.statusRuntime.buildRuntimeStatusInput(accountId, overrides),
      buildStatusMeta: (accountId) => this.statusRuntime.buildStatusMeta(accountId),
      getAccountRuntimeSnapshot: (accountId, runtimeStatusInput) =>
        this.statusRuntime.getAccountRuntimeSnapshot(accountId, runtimeStatusInput),
      buildStatusHeadline: (accountId) => this.statusRuntime.buildStatusHeadline(accountId),
      getStatusHeadline: (accountId) => this.statusRuntime.getStatusHeadline(accountId),
      getChannelSummary: (defaultAccountId) =>
        this.statusRuntime.getChannelSummary(defaultAccountId),
    }),
    ackDiagnostics: buildBncrAckDiagnosticsRuntime({
      buildRuntimeAckObservability: (accountId) => this.runtimeAckObservabilityBuilder(accountId),
      buildRuntimeAckStrategy: (ackObservability) =>
        buildBncrRuntimeAckStrategy({
          ackObservability,
          defaultAckTimeoutMs: PUSH_ACK_TIMEOUT_MS,
          maxAckTimeoutMs: RECOMMENDED_ACK_TIMEOUT_MAX_MS,
        }),
    }),
  });

  private readonly bridgeDiagnosticsFacade = createBncrBridgeDiagnosticsFacade({
    buildRuntimeFlags: (accountId) => this.statusRuntime.buildRuntimeFlags(accountId),
    buildAccountQueueCounters: (accountId) =>
      this.statusRuntime.buildAccountQueueCounters(accountId),
    buildIntegratedDiagnostics: (accountId, runtimeStatusInput?: BncrRuntimeStatusInput) =>
      this.statusRuntime.buildIntegratedDiagnostics(accountId, runtimeStatusInput),
    buildDownlinkHealth: (accountId) => this.statusRuntime.buildDownlinkHealth(accountId),
  });

  private readonly bridgeRuntimeSurfaceFacade = createBncrBridgeRuntimeSurfaceFacade({
    getApi: () => this.api,
  });

  private readonly bridgeStatusWorkerFacade = createBncrBridgeStatusWorkerFacade({
    workers: this.channelAccountWorkers,
    bridgeId: this.bridgeId,
    isOnline: (accountId) => this.isOnline(accountId),
    hasRecentInboundReachability: (accountId) => this.hasRecentInboundReachability(accountId),
    lastActivityByAccount: this.lastActivityByAccount,
    lastInboundByAccount: this.lastInboundByAccount,
    lastOutboundByAccount: this.lastOutboundByAccount,
    getActiveConnectionKey: (accountId) => this.activeConnectionByAccount.get(accountId) || null,
    connectionsValues: () => this.connections.values(),
    buildStatusMeta: (accountId) => this.buildStatusMeta(accountId),
    logInfo: (scope, message, options) => this.logInfo(scope, message, options),
    logInfoDedup: (scope, message, options) => this.logInfoDedup(scope, message, options),
  });

  private readonly bridgeExtendedDiagnosticsFacade = createBncrBridgeExtendedDiagnosticsFacade({
    normalizeAccountId,
    buildIntegratedDiagnostics: (accountId, runtimeStatusInput) =>
      this.buildIntegratedDiagnostics(accountId, runtimeStatusInput),
    buildOutboxDiagnostics: (accountId) => this.buildOutboxDiagnostics(accountId),
    buildRuntimeAckObservability: (accountId) => this.buildRuntimeAckObservability(accountId),
    getCounter: (map, accountId) => this.getCounter(map, accountId),
    prePushGuardSkipCountByAccount: this.prePushGuardSkipCountByAccount,
    lastPrePushGuardSkipAtByAccount: this.lastPrePushGuardSkipAtByAccount,
    lastPrePushGuardSkipReasonByAccount: this.lastPrePushGuardSkipReasonByAccount,
    hasGatewayContext: () => Boolean(this.gatewayContext),
    buildRuntimeSurfaceDiagnostics: () => this.buildRuntimeSurfaceDiagnostics(),
    getRegisterState: () => ({
      bridgeId: this.bridgeId,
      gatewayPid: this.gatewayPid,
      pluginVersion: this.pluginVersion,
      pluginSource: this.pluginSource,
      lastApiInstanceId: this.lastApiInstanceId,
      lastRegistryFingerprint: this.lastRegistryFingerprint,
      registerCount: this.registerCount,
      firstRegisterAt: this.firstRegisterAt,
      lastRegisterAt: this.lastRegisterAt,
      lastApiRebindAt: this.lastApiRebindAt,
      apiGeneration: this.apiGeneration,
      registerTraceRecent: this.registerTraceRecent,
      lastDriftSnapshot: this.lastDriftSnapshot ?? null,
    }),
    buildRegisterTraceSummary: () => this.buildRegisterTraceSummary(),
    activeConnectionCount: (accountId) => this.activeConnectionCount(accountId),
    getConnectionState: () => ({
      lastGatewayContextAt: this.lastGatewayContextAt,
      primaryLeaseId: this.primaryLeaseId,
      connectionEpoch: this.connectionEpoch,
      acceptedConnections: this.acceptedConnections,
      lastConnectAt: this.lastConnectAt,
      lastDisconnectAt: this.lastDisconnectAt,
      lastActivityAtGlobal: this.lastActivityAtGlobal,
      lastInboundAtGlobal: this.lastInboundAtGlobal,
      lastAckAtGlobal: this.lastAckAtGlobal,
      recentConnections: this.recentConnections,
    }),
    getOutboundState: () => ({
      outboundEnqueueCountByAccount: this.outboundEnqueueCountByAccount,
      lastOutboundEnqueueAtByAccount: this.lastOutboundEnqueueAtByAccount,
    }),
    buildDeadLetterDiagnostics: (accountId) => this.buildDeadLetterDiagnostics(accountId),
    bridgeVersion: BRIDGE_VERSION,
    staleCounters: this.staleCounters,
    now,
  });

  private readonly bridgeAckFacade = createBncrBridgeAckFacade({
    normalizeAccountId,
    now,
    pushAckTimeoutMs: PUSH_ACK_TIMEOUT_MS,
    adaptiveAckTimeoutDefaultEnabled: ADAPTIVE_ACK_TIMEOUT_DEFAULT_ENABLED,
    adaptiveAckTimeoutLogThrottleMs: ADAPTIVE_ACK_TIMEOUT_LOG_THROTTLE_MS,
    adaptiveAckTimeoutObservationTtlMs: ADAPTIVE_ACK_TIMEOUT_OBSERVATION_TTL_MS,
    adaptiveAckTimeoutRecoveryOkThreshold: ADAPTIVE_ACK_TIMEOUT_RECOVERY_OK_THRESHOLD,
    recommendedAckTimeoutMinMs: RECOMMENDED_ACK_TIMEOUT_MIN_MS,
    recommendedAckTimeoutMaxMs: RECOMMENDED_ACK_TIMEOUT_MAX_MS,
    getCounter: (map, accountId) => this.getCounter(map, accountId),
    ackTimeoutCountByAccount: this.ackTimeoutCountByAccount,
    lateAckOkCountByAccount: this.lateAckOkCountByAccount,
    lastLateAckPushLatencyMsByAccount: this.lastLateAckPushLatencyMsByAccount,
    lastLateAckOkByAccount: this.lastLateAckOkByAccount,
    adaptiveAckRecoveryOkCountByAccount: this.adaptiveAckRecoveryOkCountByAccount,
    adaptiveAckTimeoutLogStateByAccount: this.adaptiveAckTimeoutLogStateByAccount,
    logInfo: (scope, message, options) => this.logInfo(scope, message, options),
    buildRuntimeAckObservability: (accountId) =>
      this.bridgeStatusFacade.buildRuntimeAckObservability(accountId),
    buildRuntimeAckStrategy: (ackObservability) =>
      this.bridgeStatusFacade.buildRuntimeAckStrategy(ackObservability),
    waitForMessageAck: (messageId, waitMs) =>
      this.messageAckRuntime.waitForMessageAck(messageId, waitMs),
    resolveMessageAck: (messageId, result) =>
      this.messageAckRuntime.resolveMessageAck(messageId, result),
    fileAckKey: (transferId, stage, chunkIndex) =>
      this.fileAckRuntime.fileAckKey(transferId, stage, chunkIndex),
    waitForFileAck: (params) => this.fileAckRuntime.waitForFileAck(params),
    resolveFileAck: (params) => this.fileAckRuntime.resolveFileAck(params),
  });

  private readonly bridgeConnectionFacade = createBncrBridgeConnectionFacade({
    now,
    asString,
    normalizeAccountId,
    connectionState: this.connectionState,
    outboxRoute: this.outboxRoute,
    rememberGatewayContext: (context) => {
      this.gatewayContext = context;
      this.lastGatewayContextAt = now();
    },
    markActivity: (accountId, at) => {
      this.lastActivityByAccount.set(normalizeAccountId(accountId), at ?? now());
    },
  });

  private readonly bridgeOutboxFacade = createBncrBridgeOutboxFacade({
    bridgeId: this.bridgeId,
    normalizeAccountId,
    asString,
    now,
    backoffMs,
    maxRetry: MAX_RETRY,
    maxDeadLetterEntries: MAX_DEAD_LETTER_ENTRIES,
    outbox: this.outbox,
    getDeadLetter: () => this.deadLetter,
    setDeadLetter: (entries) => {
      this.deadLetter = entries;
    },
    incrementCounter: (map, accountId) => this.incrementCounter(map, accountId),
    outboundEnqueueCountByAccount: this.outboundEnqueueCountByAccount,
    lastOutboundEnqueueAtByAccount: this.lastOutboundEnqueueAtByAccount,
    prePushGuardSkipCountByAccount: this.prePushGuardSkipCountByAccount,
    lastPrePushGuardSkipAtByAccount: this.lastPrePushGuardSkipAtByAccount,
    lastPrePushGuardSkipReasonByAccount: this.lastPrePushGuardSkipReasonByAccount,
    deadLetterSinceStartByAccount: this.deadLetterSinceStartByAccount,
    lastOutboundByAccount: this.lastOutboundByAccount,
    scheduleSave: () => this.scheduleSave(),
    flushPushQueueBestEffort: (args) => this.flushPushQueueBestEffort(args),
    logInfo: (scope, message, options) => this.logInfo(scope, message, options),
    logOutboundSummary: (entry) => this.logOutboundSummary(entry),
    logDeadLetterSummary: (accountId, options) => this.logDeadLetterSummary(accountId, options),
    resolveMessageAck: (messageId, result) =>
      this.messageAckRuntime.resolveMessageAck(messageId, result),
    markActivity: (accountId, at) => this.markActivity(accountId, at),
  });

  private readonly bridgeDrainFacade = createBncrBridgeDrainFacade({
    bridgeId: this.bridgeId,
    asString,
    normalizeAccountId,
    getApi: () => this.api,
    getStopped: () => this.stopped,
    getPushTimer: () => this.pushTimer,
    setPushTimer: (timer) => {
      this.pushTimer = timer;
    },
    getRetryCount: () => this.pushDrainExceptionRetryCount,
    setRetryCount: (count) => {
      this.pushDrainExceptionRetryCount = count;
    },
    logInfo: (scope, message, options) => this.logInfo(scope, message, options),
    logError: (scope, message) => this.logError(scope, message),
    flushPushQueue: (args) => this.flushPushQueue(args),
    schedulePushDrain: (delayMs = 0) => this.schedulePushDrain(delayMs),
    resolveOutboundAckRequired: (args) => resolveBncrOutboundAckRequired(args),
    retryLimit: PUSH_DRAIN_EXCEPTION_RETRY_LIMIT,
    retryDelayMs: PUSH_DRAIN_EXCEPTION_RETRY_DELAY_MS,
  });

  // Runtime-backed bridge facades ------------------------------------------
  // These methods sit after the runtime groups so the bridge-owned public and
  // semi-public helpers still read as one contiguous facade layer.

  private buildRuntimeFlags(accountId?: string) {
    return this.bridgeDiagnosticsFacade.buildRuntimeFlags(accountId);
  }

  private getAccountPendingOutboxEntries(accountId: string) {
    return this.diagnosticsSelectionHelpers.getAccountPendingOutboxEntries(accountId);
  }

  private getAccountDeadLetterEntries(accountId: string) {
    return this.diagnosticsSelectionHelpers.getAccountDeadLetterEntries(accountId);
  }

  private buildAccountQueueCounters(accountId: string) {
    return this.bridgeDiagnosticsFacade.buildAccountQueueCounters(accountId);
  }

  private buildActiveConnectionDebugList(
    accountId: string,
    options?: { includeOutboundState?: boolean },
  ) {
    return this.diagnosticsSelectionHelpers.buildActiveConnectionDebugList(accountId, options);
  }

  private readonly diagnosticsSelectionHelpers = createBncrDiagnosticsSelectionHelpers({
    normalizeAccountId,
    outboxValues: () => this.outbox.values(),
    getDeadLetterEntries: () => this.deadLetter,
    connectionsValues: () => this.connections.values(),
  });

  // Outbox drain/runtime bridges -------------------------------------------

  private maybeLogOutboxDrainStuck(args: { accountId: string; trigger: string; reason: string }) {
    this.outboxDrainRuntime.maybeLogOutboxDrainStuck(args);
  }

  private async runAccountDrainCycle(args: {
    accountId: string;
    trigger: string;
    reason?: string;
    globalNextDelay: number | null;
  }): Promise<number | null> {
    return await this.outboxDrainRuntime.runAccountDrainCycle(args);
  }

  private async flushPushQueue(args?: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }): Promise<void> {
    await this.outboxDrainRuntime.flushPushQueue(args);
  }

  private async waitForMessageAck(messageId: string, waitMs: number): Promise<'acked' | 'timeout'> {
    return await this.bridgeAckFacade.waitForMessageAck(messageId, waitMs);
  }

  // Connection-state runtime bridges ---------------------------------------

  private connectionKey(accountId: string, clientId?: string): string {
    const acc = normalizeAccountId(accountId);
    const cid = asString(clientId || '').trim();
    return `${acc}::${cid || 'default'}`;
  }

  private gcTransientState() {
    this.transientStateRuntime.gcTransientState();
  }

  private cleanupFileTransfers() {
    this.transientStateRuntime.cleanupFileTransfers();
  }

  private markSeen(accountId: string, connId: string, clientId?: string) {
    this.connectionState.markSeen(accountId, connId, clientId);
  }

  private markOutboundCapability(args: {
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady?: boolean;
    preferredForOutbound?: boolean;
    inboundOnly?: boolean;
    at?: number;
  }) {
    this.connectionState.markOutboundCapability(args);
  }

  private hasAlternativeLiveConnection(
    accountId: string,
    currentConnId?: string,
    currentClientId?: string,
  ): boolean {
    return this.connectionState.hasAlternativeLiveConnection(
      accountId,
      currentConnId,
      currentClientId,
    );
  }

  private degradeOutboundCapability(args: {
    accountId: string;
    connId?: string;
    clientId?: string;
    reason: string;
    at?: number;
  }) {
    this.connectionState.degradeOutboundCapability(args);
  }

  private isOnline(accountId: string): boolean {
    return this.connectionState.isOnline(accountId);
  }

  private activeConnectionCount(accountId: string): number {
    return this.connectionState.activeConnectionCount(accountId);
  }

  // Session routing / status / public bridge surface -----------------------
  // The tail of the bridge exposes account/session helpers, status facades,
  // queue inspection, reply enqueue, and the final plugin/channel factories.

  // Session routing and dedupe surface -------------------------------------

  private isPrimaryConnection(accountId: string, clientId?: string): boolean {
    const acc = normalizeAccountId(accountId);
    const key = this.connectionKey(acc, clientId);
    const primary = this.activeConnectionByAccount.get(acc);
    if (!primary) return true;
    return primary === key;
  }

  private markInboundDedupSeen(key: string): boolean {
    const t = now();
    const last = this.recentInbound.get(key);
    this.recentInbound.set(key, t);

    // 90s 内重复包直接丢弃
    return typeof last === 'number' && t - last <= 90_000;
  }

  rememberSessionRoute(sessionKey: string, accountId: string, route: BncrRoute) {
    this.targetRuntime.rememberSessionRoute(sessionKey, accountId, route);
  }

  resolveRouteBySession(sessionKey: string, accountId: string): BncrRoute | null {
    return this.targetRuntime.resolveRouteBySession(sessionKey, accountId);
  }

  // 严谨目标解析：
  // 1) 标准 to 仅认 Bncr:<platform>:0:<userId> / Bncr:<platform>:<groupId>:0
  // 2) 仍接受 strict sessionKey 作为内部兼容输入
  // 3) 输入侧额外兼容 Bncr:<platform>:User:<userId> / Bncr:<platform>:Group:<groupId>
  // 4) 其他旧格式直接失败，并输出标准格式提示日志
  resolveVerifiedTarget(
    rawTarget: string,
    accountId: string,
  ): { sessionKey: string; route: BncrRoute; displayScope: string } {
    return this.targetRuntime.resolveVerifiedTarget(rawTarget, accountId);
  }

  private markActivity(accountId: string, at = now()) {
    this.bridgeConnectionFacade.markActivity(accountId, at);
  }

  // File ACK surface helpers ------------------------------------------------

  private fileAckKey(transferId: string, stage: string, chunkIndex?: number): string {
    return this.bridgeAckFacade.fileAckKey(transferId, stage, chunkIndex);
  }

  // File ACK waiter/read-model facade --------------------------------------
  // Keep file ACK keying, waiter wakeup, and transfer owner projection close
  // together because they form one debugging and lifecycle boundary.

  private fileAckOwnerInfo(transferId: string) {
    const st = this.fileSendTransfers.get(transferId);
    return {
      ...(st?.ownerConnId ? { ownerConnId: st.ownerConnId } : {}),
      ...(st?.ownerClientId ? { ownerClientId: st.ownerClientId } : {}),
    };
  }

  private waitForFileAck(params: {
    transferId: string;
    stage: string;
    chunkIndex?: number;
    timeoutMs?: number;
  }) {
    return this.bridgeAckFacade.waitForFileAck(params);
  }

  private resolveFileAck(params: {
    transferId: string;
    stage: string;
    chunkIndex?: number;
    payload: Record<string, unknown>;
    ok: boolean;
  }) {
    return this.bridgeAckFacade.resolveFileAck(params);
  }

  // Structure note (adaptive ACK observability):
  // This log gate stays in the bridge because it reads and throttles account-level adaptive
  // timeout state that is shared with status/telemetry surfaces. If this area changes later,
  // prefer extracting a pure read-model helper rather than another stateful runtime wrapper.
  private maybeLogAdaptiveAckTimeout(args: {
    accountId: string;
    timeoutMs: number;
    reason: string;
    lastLateAckPushLatencyMs: number | null;
    nowMs?: number;
  }) {
    this.bridgeAckFacade.maybeLogAdaptiveAckTimeout(args);
  }

  // Structure note (adaptive ACK decision boundary):
  // Keep the final timeout decision in the bridge. It is the aggregation point for multiple
  // account-scoped telemetry maps plus runtime policy constants, and splitting it further would
  // mostly widen runtime injection without making ownership clearer.
  private resolveMessageAckTimeoutMs(accountId?: string) {
    return this.bridgeAckFacade.resolveMessageAckTimeoutMs(accountId || BNCR_DEFAULT_ACCOUNT_ID);
  }

  // Structure note (runtime ACK snapshot):
  // This method intentionally remains a bridge-owned read-model builder because it projects
  // several runtime maps into one diagnostics/status snapshot. Future cleanup should extract
  // pure snapshot shaping only, not move the underlying state ownership out of the bridge.
  private buildRuntimeAckObservability(accountId: string) {
    return this.bridgeAckFacade.buildRuntimeAckObservability(accountId);
  }

  private readonly runtimeAckObservabilityBuilder = createBncrRuntimeAckObservabilityBuilder({
    normalizeAccountId,
    getCounter: (map, accountId) => this.getCounter(map, accountId),
    ackTimeoutCountByAccount: this.ackTimeoutCountByAccount,
    lateAckOkCountByAccount: this.lateAckOkCountByAccount,
    lastLateAckPushLatencyMsByAccount: this.lastLateAckPushLatencyMsByAccount,
    lastLateAckOkByAccount: this.lastLateAckOkByAccount,
    adaptiveAckRecoveryOkCountByAccount: this.adaptiveAckRecoveryOkCountByAccount,
    lastAckOkByAccount: this.lastAckOkByAccount,
    lastAckTimeoutByAccount: this.lastAckTimeoutByAccount,
    lastAckQueueLatencyMsByAccount: this.lastAckQueueLatencyMsByAccount,
    lastAckPushLatencyMsByAccount: this.lastAckPushLatencyMsByAccount,
    lastLateAckQueueLatencyMsByAccount: this.lastLateAckQueueLatencyMsByAccount,
    adaptiveAckTimeoutEnabled: ADAPTIVE_ACK_TIMEOUT_DEFAULT_ENABLED,
    defaultAckTimeoutMs: PUSH_ACK_TIMEOUT_MS,
    resolveMessageAckTimeoutMs: (accountId) => this.resolveMessageAckTimeoutMs(accountId),
    minAckTimeoutMs: RECOMMENDED_ACK_TIMEOUT_MIN_MS,
    maxAckTimeoutMs: RECOMMENDED_ACK_TIMEOUT_MAX_MS,
    lateAckObservationTtlMs: ADAPTIVE_ACK_TIMEOUT_OBSERVATION_TTL_MS,
    recoveryOkThreshold: ADAPTIVE_ACK_TIMEOUT_RECOVERY_OK_THRESHOLD,
    now,
  });

  // Structure note (runtime ACK strategy facade):
  // Keep this facade adjacent to the bridge-owned observability snapshot so status/runtime
  // surfaces continue to read one coherent source of truth.
  private buildRuntimeAckStrategy(ackObservability: BncrAckObservability) {
    return this.bridgeAckFacade.buildRuntimeAckStrategy(ackObservability);
  }

  // Status and diagnostics public read-models ------------------------------
  // These methods are the bridge-owned projection layer consumed by status,
  // diagnostics handlers, and plugin surfaces.

  private buildRuntimeStatusInput(
    accountId: string,
    overrides: Parameters<typeof this.bridgeStatusFacade.buildRuntimeStatusInput>[1] = {},
  ) {
    return this.bridgeStatusFacade.buildRuntimeStatusInput(accountId, overrides);
  }

  // Structure note (status facade):
  // This stays as a thin bridge facade on purpose. The bridge owns which account-scoped state
  // participates in status projection, while statusRuntime owns the formatting/projection logic.
  private buildStatusMeta(accountId: string) {
    return this.bridgeStatusFacade.buildStatusMeta(accountId);
  }

  getAccountRuntimeSnapshot(
    accountId: string,
    runtimeStatusInput = this.buildRuntimeStatusInput(accountId, { running: true }),
  ) {
    return this.bridgeStatusFacade.getAccountRuntimeSnapshot(accountId, runtimeStatusInput);
  }

  // Structure note (status headline facade):
  // Keep headline projection adjacent to buildStatusMeta so status entrypoints remain obvious
  // from the bridge surface instead of being scattered across additional wrapper layers.
  private buildStatusHeadline(accountId: string): string {
    return this.bridgeStatusFacade.buildStatusHeadline(accountId);
  }

  getStatusHeadline(accountId: string): string {
    return this.bridgeStatusFacade.getStatusHeadline(accountId);
  }

  getChannelSummary(defaultAccountId: string) {
    return this.bridgeStatusFacade.getChannelSummary(defaultAccountId);
  }

  // Outbound queue terminal flow -------------------------------------------
  // These methods close the loop between enqueue, due-entry collection,
  // retry exhaustion, and dead-letter settlement.

  private enqueueOutbound(entry: OutboxEntry) {
    this.bridgeOutboxFacade.enqueueOutbound(entry);
  }

  // Structure note (dead-letter terminal sink):
  // This remains bridge-owned because dead-lettering is the terminal transition sink for the
  // outbound state machine: it settles waiters, mutates bounded deadLetter memory, updates
  // counters, schedules persistence, and emits summary logs in one ownership boundary.
  private moveToDeadLetter(entry: OutboxEntry, reason: string) {
    this.bridgeOutboxFacade.moveToDeadLetter(entry, reason);
  }

  collectDue(accountId: string, maxBatch: number): Array<Record<string, unknown>> {
    return this.bridgeOutboxFacade.collectDue({ accountId, maxBatch });
  }

  // File-transfer outbound flow --------------------------------------------
  // This cluster keeps transfer media loading, route diagnostics, bridge-side
  // transfer logs, and orchestrator/runtime facades in one scan path.

  private async loadOutboundTransferMedia(params: {
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
  }): Promise<{
    loaded: OpenClawLoadedMedia;
    size: number;
    mimeType?: string;
    fileName: string;
  }> {
    return await this.bridgeMediaFacade.loadOutboundTransferMedia(params);
  }

  private buildTransferRouteDiagnostics(args: {
    accountId: string;
    recentInboundReachable: boolean;
  }) {
    return this.bridgeMediaFacade.buildTransferRouteDiagnostics(args);
  }

  private selectTransferConnIds(args: {
    directConnIds: Set<string>;
    recentConnIds: Set<string>;
    recentInboundReachable: boolean;
  }) {
    return this.bridgeMediaFacade.selectTransferConnIds(args);
  }

  private logFileChunkDiag(args: {
    accountId: string;
    sessionKey: string;
    mediaUrl: string;
    hasGatewayContext: boolean;
    activeConnectionKey: string | null;
    ownerConnId?: string;
    ownerClientId?: string;
    directConnIds: Iterable<string>;
    recentInboundReachable: boolean;
    recentConnIds: Iterable<string>;
    accountConnections: Array<{
      connId: string;
      clientId?: string;
      connectedAt: number;
      lastSeenAt: number;
    }>;
  }) {
    this.bridgeMediaFacade.logFileChunkDiag(args);
  }

  private logFileTransferStart(args: {
    transferId: string;
    accountId: string;
    sessionKey: string;
    mediaUrl: string;
    fileName: string;
    mimeType?: string;
    fileSize: number;
    chunkSize: number;
    totalChunks: number;
    connIds: ReadonlySet<string>;
    ownerConnId?: string;
    ownerClientId?: string;
  }) {
    this.bridgeMediaFacade.logFileTransferStart(args);
  }

  private logFileTransferChunkSend(args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
    offset: number;
    size: number;
    connIds: ReadonlySet<string>;
  }) {
    this.bridgeMediaFacade.logFileTransferChunkSend(args);
  }

  private logFileTransferChunkAck(args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
  }) {
    this.bridgeMediaFacade.logFileTransferChunkAck(args);
  }

  private logFileTransferChunkAckFail(args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
    error: unknown;
  }) {
    this.bridgeMediaFacade.logFileTransferChunkAckFail(args);
  }

  private logFileTransferCompleteSend(args: {
    transferId: string;
    accountId: string;
    connIds: ReadonlySet<string>;
  }) {
    this.bridgeMediaFacade.logFileTransferCompleteSend(args);
  }

  private logFileTransferCompleteAck(args: {
    transferId: string;
    accountId: string;
    payload: { path: string };
  }) {
    this.bridgeMediaFacade.logFileTransferCompleteAck(args);
  }

  private buildInitialFileSendTransferState(args: {
    transferId: string;
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    fileName: string;
    mimeType?: string;
    fileSize: number;
    chunkSize: number;
    totalChunks: number;
    fileSha256: string;
    ownerConnId?: string;
    ownerClientId?: string;
  }): FileSendTransferState {
    return this.bridgeMediaFacade.buildInitialFileSendTransferState(args) as FileSendTransferState;
  }

  // Phase 8: media orchestration and host handoff ---------------------------
  private readonly mediaOrchestratorsRuntimeGroup = createBncrMediaOrchestratorsRuntimeGroup({
    now,
    asString,
    fileSendTransfers: this.fileSendTransfers,
    getGatewayContext: () =>
      this.gatewayContext
        ? {
            broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) =>
              this.gatewayContext!.broadcastToConnIds(event, payload, connIds),
          }
        : null,
    fileInitEvent: BNCR_FILE_INIT_EVENT,
    fileAbortEvent: BNCR_FILE_ABORT_EVENT,
    prepareOutboundTransfer: (args) => this.fileTransferSetup.prepareOutboundTransfer(args),
    sendChunk: (args) => this.fileTransferSend.sendChunk(args),
    sendComplete: (args) => this.fileTransferSend.sendComplete(args),
    waitForFileAck: (args) => this.waitForFileAck(args),
    logFileTransferChunkAck: (args) => this.logFileTransferChunkAck(args),
    logFileTransferChunkAckFail: (args) => this.logFileTransferChunkAckFail(args),
    logFileTransferCompleteAck: (args) => this.logFileTransferCompleteAck(args),
    logInfo: (scope, message, options) => this.logInfo(scope, message, options),
    logEnqueueFromReply: (args) => this.logEnqueueFromReply(args),
    enqueueOutbound: (entry) => this.enqueueOutbound(entry),
    buildTextOutboxEntry: (args) => this.buildTextOutboxEntry(args),
    buildFileTransferOutboxEntry: (args) => this.buildFileTransferOutboxEntry(args),
    rememberRecentMediaSend: (args) => this.rememberRecentMediaSend(args),
    tryBuildMediaDedupeFallback: (args) => this.tryBuildMediaDedupeFallback(args),
  });

  private readonly fileTransferOrchestrator =
    this.mediaOrchestratorsRuntimeGroup.fileTransferOrchestrator;

  // Structure note (bridge-local wait primitive):
  // Keep this tiny sleep helper near the file-transfer orchestrator facade so
  // transfer retry/wait flows remain easy to trace without searching upward.
  private async sleepMs(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, clampFiniteNumber(ms, 0, 0, 120_000)));
  }

  private async waitChunkAck(params: {
    transferId: string;
    chunkIndex: number;
    timeoutMs?: number;
  }): Promise<void> {
    return this.bridgeMediaFacade.waitChunkAck(params);
  }

  private async waitCompleteAck(params: {
    transferId: string;
    timeoutMs?: number;
  }): Promise<{ path: string }> {
    return this.bridgeMediaFacade.waitCompleteAck(params);
  }

  private async transferMediaToBncrClient(params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
  }): Promise<{
    mode: 'base64' | 'chunk';
    mimeType?: string;
    fileName?: string;
    mediaBase64?: string;
    path?: string;
  }> {
    return this.bridgeMediaFacade.transferMediaToBncrClient(params);
  }

  public async enqueueFromReply(params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: ReplyPayloadInput;
    mediaLocalRoots?: readonly string[];
    replyTargetPolicy?: OutboundReplyTargetPolicy;
  }) {
    this.bridgeMediaFacade.enqueueFromReply(params);
  }

  private logEnqueueFromReply(args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: NormalizedReplyPayload;
  }) {
    this.bridgeMediaFacade.logEnqueueFromReply(args);
  }

  private readonly replyMediaOrchestrator =
    this.mediaOrchestratorsRuntimeGroup.replyMediaOrchestrator;

  private readonly bridgeMediaFacade = createBncrBridgeMediaFacade({
    getApi: () => this.api,
    resolveOutboundFileName,
    outboxRoute: this.outboxRoute,
    fileTransferOrchestrator: this.fileTransferOrchestrator,
    replyMediaOrchestrator: this.replyMediaOrchestrator,
    logInfoJson: (scope, event, payload, options) =>
      this.logInfoJson(scope, event, payload, options),
    buildEnqueueFromReplyDebugInfo,
    fileTransferLogs: {
      logFileChunkDiag: (args) => this.fileTransferLogs.logFileChunkDiag(args),
      logFileTransferStart: (args) => this.fileTransferLogs.logFileTransferStart(args),
      logFileTransferChunkSend: (args) => this.fileTransferLogs.logFileTransferChunkSend(args),
      logFileTransferChunkAck: (args) => this.fileTransferLogs.logFileTransferChunkAck(args),
      logFileTransferChunkAckFail: (args) =>
        this.fileTransferLogs.logFileTransferChunkAckFail(args),
      logFileTransferCompleteSend: (args) =>
        this.fileTransferLogs.logFileTransferCompleteSend(args),
      logFileTransferCompleteAck: (args) => this.fileTransferLogs.logFileTransferCompleteAck(args),
      buildInitialFileSendTransferState: (args) =>
        this.fileTransferLogs.buildInitialFileSendTransferState(args) as FileSendTransferState,
    },
    normalizeAccountId,
  });

  private readonly fileTransferPushFacade = createBncrBridgeFileTransferPushFacade({
    pushEvent: BNCR_PUSH_EVENT,
    getGatewayContext: () => this.gatewayContext,
    transferMediaToBncrClient: (params) => this.transferMediaToBncrClient(params),
    buildFileTransferOutboundFrame: (params) => this.buildFileTransferOutboundFrame(params),
    logOutboxRouteSelect: (args) => this.logOutboxRouteSelect(args),
    recordOutboxPushSuccess: (args) => this.recordOutboxPushSuccess(args),
    logOutboxPushOkSummary: (messageId) => this.logOutboxPushOkSummary(messageId),
    logOutboxPushOk: (args) => this.logOutboxPushOk(args),
    handleFileTransferPushFailure: (args) => this.outboxPush.handleFileTransferPushFailure(args),
    handleFileTransferPushGuardFailure: (args) =>
      this.outboxPush.handleFileTransferPushGuardFailure(args),
  });

  private enqueueReplyMediaEntries(params: ReplyMediaEntriesParams) {
    this.bridgeMediaFacade.enqueueReplyMediaEntries(params);
  }

  // Surface runtime assembly -----------------------------------------------
  // The bridge remains the ownership root, but these builders keep the final
  // gateway/inbound/channel send wiring readable by concern instead of as one
  // long inline callback bag.

  // Final host surfaces -----------------------------------------------------
  // These builders sit last on purpose: they consume the already-assembled
  // bridge facades/runtime groups and project the final gateway/inbound/send
  // surfaces that the host calls.

  private buildBridgeSurfaceHandlersRuntime() {
    const statusProjection = this.buildBridgeStatusProjectionRuntime();
    const drainTriggers = this.buildBridgeDrainTriggers();
    const lifecycleMarkers = this.buildBridgeLifecycleMarkers();
    return buildBncrBridgeSurfaceHandlersRuntime({
      bridgeId: this.bridgeId,
      gatewayPid: this.gatewayPid,
      pushEvent: BNCR_PUSH_EVENT,
      bridgeVersion: BRIDGE_VERSION,
      getApi: () => this.api,
      channelId: CHANNEL_ID,
      asString,
      now,
      finiteNonNegativeNumberOrNull,
      syncDebugFlag: () => this.syncDebugFlag(),
      logInfo: (scope, message, options) => this.logInfo(scope, message, options),
      logWarn: (scope, message, options) => this.logWarn(scope, message, options),
      normalizeAccountId,
      pluginRoot: this.pluginRoot || '',
      ...statusProjection,
      isPrimaryConnection: (accountId, clientId) => this.isPrimaryConnection(accountId, clientId),
      acceptConnection: () => this.acceptConnection(),
      refreshLiveConnectionState: (args) => this.refreshLiveConnectionState(args),
      ...drainTriggers,
      shouldIgnoreStaleEvent: (args) => this.shouldIgnoreStaleEvent(args),
      incrementConnectEvents: (accountId) =>
        this.incrementCounter(this.connectEventsByAccount, accountId),
      incrementActivityEvents: (accountId) =>
        this.incrementCounter(this.activityEventsByAccount, accountId),
      incrementAckEvents: (accountId) => this.incrementCounter(this.ackEventsByAccount, accountId),
      ...lifecycleMarkers,
      messageAckWaiterCount: () => this.messageAckWaiters.size,
      fileAckWaiterCount: () => this.fileAckWaiters.size,
      prepareAckHandling: (args) => this.prepareAckHandling(args),
      handleAckOutcome: (args) => this.handleAckOutcome(args),
      fileSendTransfers: this.fileSendTransfers,
      hasFileAckWaiter: (key) => this.fileAckWaiters.has(key),
      fileAckKey: (transferId, stage, chunkIndex) => this.fileAckKey(transferId, stage, chunkIndex),
      observeLease: (kind, payload) => this.observeLease(kind, payload),
      tryAdoptTransferOwner: (args) => this.tryAdoptTransferOwner(args),
      refreshAcceptedFileTransferLiveState: (args) =>
        this.refreshAcceptedFileTransferLiveState(args),
      resolveFileAck: (args) => this.resolveFileAck(args),
      countInvalidOutboxSessionKeys: (accountId) => this.countInvalidOutboxSessionKeys(accountId),
      countLegacyAccountResidue: (accountId) => this.countLegacyAccountResidue(accountId),
      activeConnectionCount: (accountId) => this.activeConnectionCount(accountId),
      getMessageAckWaiterCount: () => this.messageAckWaiters.size,
      getFileAckWaiterCount: () => this.fileAckWaiters.size,
      filterDeadLetterEntries: (args) => this.filterDeadLetterEntries(args),
      listDeadLetterEntries: () => this.deadLetter.slice(),
      buildDeadLetterDiagnostics: (accountId) => this.buildDeadLetterDiagnostics(accountId),
      replaceDeadLetterEntries: (nextEntries) => {
        this.deadLetter = nextEntries;
      },
      scheduleSave: () => this.scheduleSave(),
      logDeadLetterSummary: (accountId, args) => this.logDeadLetterSummary(accountId, args),
    });
  }

  private buildInboundSurfaceRuntime() {
    const inboundConnectionRuntime = this.buildInboundSurfaceConnectionRuntime();
    const inboundActivityRuntime = this.buildInboundSurfaceActivityRuntime();
    return buildBncrInboundSurfaceRuntime({
      getApi: () => this.api,
      channelId: CHANNEL_ID,
      bridgeId: this.bridgeId,
      pluginRoot: this.pluginRoot || '',
      asString,
      now,
      normalizeAccountId,
      finiteNonNegativeNumberOrNull,
      syncDebugFlag: () => this.syncDebugFlag(),
      ...inboundConnectionRuntime,
      logInfo: (scope, message, options) => this.logInfo(scope, message, options),
      logWarn: (scope, message, options) => this.logWarn(scope, message, options),
      logError: (scope, message, options) => this.logError(scope, message, options),
      buildInboundResponsePayload,
      buildInboundAcceptedLifecycleDebugInfo,
      ...inboundActivityRuntime,
      ensureCanonicalAgentId: (args) => this.ensureCanonicalAgentId(args),
      defaultAdminAgentId: (args) => this.defaultAdminAgentId(args),
      defaultPublicAgentId: () => this.defaultPublicAgentId(),
      sceneRegistry: this.sceneRegistry,
      groupHistories: this.groupHistories,
      prepareInboundAcceptance: (args) => this.prepareInboundAcceptance(args),
      logInboundSummary: (args) => this.logInboundSummary(args),
      flushPushQueueBestEffort: (args) => this.flushPushQueueBestEffort(args),
      rememberSessionRoute: (sessionKey, accountId, route) =>
        this.rememberSessionRoute(sessionKey, accountId, route),
      enqueueFromReply: (args: Parameters<BncrBridgeRuntime['enqueueFromReply']>[0]) =>
        this.enqueueFromReply(args),
      scheduleSave: () => this.scheduleSave(),
      buildCanonicalSessionKey: (route: BncrRoute) =>
        buildCanonicalBncrSessionKey(route, this.canonicalAgentId || 'main'),
      fileRecvTransfers: this.fileRecvTransfers,
      inboundFileTransferMaxBytes: INBOUND_FILE_TRANSFER_MAX_BYTES,
      inboundFileTransferMaxChunks: INBOUND_FILE_TRANSFER_MAX_CHUNKS,
    });
  }

  private buildChannelSendRuntime() {
    const targetRuntime = this.buildChannelSendTargetRuntime();
    return buildBncrChannelSendRuntime({
      channelId: CHANNEL_ID,
      asString,
      syncDebugFlag: () => this.syncDebugFlag(),
      logInfo: (scope, message, options) => this.logInfo(scope, message, options),
      ...targetRuntime,
      listOutboxEntries: () => Array.from(this.outbox.values()),
    });
  }

  // Gateway / diagnostics surface assembly ---------------------------------
  // These groups bind bridge-owned state and methods into gateway-facing
  // handlers without moving ownership of the underlying runtime maps.

  private readonly bridgeSurfaceHandlersGroup = createBncrBridgeSurfaceHandlersGroup(
    this.buildBridgeSurfaceHandlersRuntime(),
  );

  private readonly connectionHandlers = this.bridgeSurfaceHandlersGroup.connectionHandlers;

  handleConnect = async (ctx: GatewayRequestHandlerOptions) =>
    this.connectionHandlers.handleConnect(ctx);

  handleActivity = async (ctx: GatewayRequestHandlerOptions) =>
    this.connectionHandlers.handleActivity(ctx);

  handleAck = async (ctx: GatewayRequestHandlerOptions) => this.connectionHandlers.handleAck(ctx);

  private readonly diagnosticsHandlers = this.bridgeSurfaceHandlersGroup.diagnosticsHandlers;

  handleDiagnostics = async (ctx: GatewayRequestHandlerOptions) =>
    this.diagnosticsHandlers.handleDiagnostics(ctx);

  handleDeadLetterInspect = async (ctx: GatewayRequestHandlerOptions) =>
    this.diagnosticsHandlers.handleDeadLetterInspect(ctx);

  handleDeadLetterPrune = async (ctx: GatewayRequestHandlerOptions) =>
    this.diagnosticsHandlers.handleDeadLetterPrune(ctx);

  handleFileInit = async (ctx: GatewayRequestHandlerOptions) =>
    this.fileInboundHandlers.handleFileInit(ctx);

  handleFileChunk = async (ctx: GatewayRequestHandlerOptions) =>
    this.fileInboundHandlers.handleFileChunk(ctx);

  handleFileComplete = async (ctx: GatewayRequestHandlerOptions) =>
    this.fileInboundHandlers.handleFileComplete(ctx);

  handleFileAbort = async (ctx: GatewayRequestHandlerOptions) =>
    this.fileInboundHandlers.handleFileAbort(ctx);

  handleFileAck = async (ctx: GatewayRequestHandlerOptions) =>
    this.connectionHandlers.handleFileAck(ctx);

  // Inbound surface assembly ------------------------------------------------
  // This group owns inbound event acceptance, reply bridging, and inbound file
  // transfer surfaces that sit beside gateway ACK/connect handlers.

  private readonly inboundSurfaceHandlersGroup = createBncrInboundSurfaceHandlersGroup(
    this.buildInboundSurfaceRuntime(),
  );

  private readonly fileInboundHandlers = this.inboundSurfaceHandlersGroup.fileInboundHandlers;

  private readonly inboundHandlers = this.inboundSurfaceHandlersGroup.inboundHandlers;

  handleInbound = async (ctx: GatewayRequestHandlerOptions) =>
    this.inboundHandlers.handleInbound(ctx);

  // Status worker lifecycle -------------------------------------------------

  channelStartAccount = async (ctx: BncrStatusWorkerContext) => {
    await startBncrStatusWorker(this.buildStatusWorkerRuntime(), ctx);
  };

  channelStopAccount = async (ctx: Partial<BncrStatusWorkerContext>) => {
    await stopBncrStatusWorker(this.buildStatusWorkerRuntime(), ctx);
  };

  // Channel send surface assembly ------------------------------------------
  // This group backs the public channel send APIs and should stay adjacent to
  // the final exposed channel* methods for quick top-down scanning.

  private readonly channelSendRuntimeGroup = createBncrChannelSendRuntimeGroup(
    this.buildChannelSendRuntime(),
  );

  private readonly channelSendRuntime = this.channelSendRuntimeGroup.channelSendRuntime;

  channelSendText = async (ctx: BncrChannelSendContext) =>
    this.channelSendRuntime.channelSendText(ctx);

  channelSendMedia = async (ctx: BncrChannelSendContext) =>
    this.channelSendRuntime.channelSendMedia(ctx);

  channelMessageSendText = async (ctx: BncrChannelSendContext) =>
    this.channelSendRuntime.channelMessageSendText(ctx);

  channelMessageSendMedia = async (ctx: BncrChannelSendContext) =>
    this.channelSendRuntime.channelMessageSendMedia(ctx);

  channelMessageSendPayload = async (ctx: BncrChannelSendContext) =>
    this.channelSendRuntime.channelMessageSendPayload(ctx);
}

// Plugin surface export -----------------------------------------------------

export function createBncrBridge(
  api: OpenClawPluginApi,
  runtimePaths: BncrBridgeRuntimePaths = {},
) {
  return new BncrBridgeRuntime(api, runtimePaths);
}

export function createBncrChannelPlugin(getBridge: () => BncrBridgeRuntime) {
  const bridgeGroup = createBncrChannelPluginBridgeGroup({
    channelId: CHANNEL_ID,
    defaultAccountId: BNCR_DEFAULT_ACCOUNT_ID,
    getBridge: () => getBridge() as unknown as BncrChannelPluginBridge,
  });

  return createBncrChannelPluginSurfaceGroup({
    channelId: CHANNEL_ID,
    getMessageSendBridge: bridgeGroup.getMessageSendBridge,
    getOutboundBridge: bridgeGroup.getOutboundBridge,
    getMessagingBridge: bridgeGroup.getMessagingBridge,
    getStatusBridge: bridgeGroup.getStatusBridge,
    getToolActionBridge: bridgeGroup.getToolActionBridge,
    getGatewayBridge: bridgeGroup.getGatewayBridge,
    channelMeta: BNCR_CHANNEL_META,
    channelCapabilities: BNCR_CHANNEL_CAPABILITIES,
    gatewayMethods: BNCR_GATEWAY_METHODS,
    configSurface: BNCR_CONFIG_SURFACE,
    setupSurface: BNCR_SETUP_SURFACE,
    extractToolSend: extractOpenClawToolSend,
    openClawJsonResult,
  }).plugin;
}
