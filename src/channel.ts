import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  GatewayRequestHandlerOptions,
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from 'openclaw/plugin-sdk/core';
import {
  BNCR_DEFAULT_ACCOUNT_ID,
  CHANNEL_ID,
  listAccountIds,
  normalizeAccountId,
  resolveAccount,
} from './core/accounts.ts';
import { BncrConfigSchema } from './core/config-schema.ts';
import {
  applyOutboundCapability,
  buildCapabilitySnapshot,
  clearOutboundCapability,
  findCapabilityConnection,
} from './core/connection-capability.ts';
import {
  getRevalidatedAttemptReason,
  hasAlternativeLiveConnection as hasAlternativeLiveConnectionFromRuntime,
  hasRecentInboundReachability as hasRecentInboundReachabilityFromRuntime,
  isRecentlyReachableConn as isRecentlyReachableConnFromRuntime,
  resolveRecentInboundConnIds as resolveRecentInboundConnIdsFromRuntime,
} from './core/connection-reachability.ts';
import { buildDiagnosticsPayload } from './core/diagnostics.ts';
import { buildDownlinkHealth as buildDownlinkHealthFromRuntime } from './core/downlink-health.ts';
import { buildExtendedDiagnostics as buildExtendedDiagnosticsFromRuntime } from './core/extended-diagnostics.ts';
import { buildFileAckKey } from './core/file-ack.ts';
import {
  buildFileTransferAbortPayload,
  buildFileTransferChunkPayload,
  buildFileTransferCompletePayload,
  buildFileTransferInitPayload,
} from './core/file-transfer-payloads.ts';
import {
  matchesTransferOwner as matchesTransferOwnerFromRuntime,
  observeLeaseState,
} from './core/lease-state.ts';
import { emitBncrLog, emitBncrLogLine } from './core/logging.ts';
import { buildOutboxEnqueueDebugInfo } from './core/outbox-enqueue.ts';
import {
  buildFileTransferOutboxEntry as buildFileTransferOutboxEntryFromRuntime,
  buildTextOutboxEntry as buildTextOutboxEntryFromRuntime,
} from './core/outbox-entry-builders.ts';
import {
  buildFileTransferPushOkArgs,
  buildFileTransferPushSuccessArgs,
} from './core/outbox-file-transfer-bookkeeping.ts';
import {
  buildFileTransferPushFailureArgs,
  resolveFileTransferFailureState,
} from './core/outbox-file-transfer-failure.ts';
import { resolveFileTransferGuard } from './core/outbox-file-transfer-guards.ts';
import { prepareFileTransferRouteSelection } from './core/outbox-file-transfer-prep.ts';
import {
  buildFileTransferBroadcastPayload,
  buildFileTransferRouteSelectArgs,
} from './core/outbox-file-transfer-success.ts';
import {
  appendDeadLetter,
  buildDeadLetterEntry,
  collectDueOutboxEntries,
} from './core/outbox-queue.ts';
import { summarizeOutboxEntry } from './core/outbox-summary.ts';
import { buildTextPushFailureArgs } from './core/outbox-text-push-failure.ts';
import { resolveTextPushGuard } from './core/outbox-text-push-guards.ts';
import { prepareTextPushRouteSelection } from './core/outbox-text-push-prep.ts';
import {
  buildTextPushBroadcastPayload,
  buildTextPushOkArgs,
  buildTextPushRouteSelectArgs,
  buildTextPushSuccessArgs,
} from './core/outbox-text-push-success.ts';
import { resolveBncrChannelPolicy, resolveBncrConfigWarnings } from './core/policy.ts';
import {
  appendBoundedRegisterTrace,
  buildRegisterDriftSnapshot,
  buildRegisterTraceEntry,
  buildRegisterTraceSummary as buildRegisterTraceSummaryFromEntries,
} from './core/register-trace.ts';
import {
  buildAccountRuntimeSnapshot,
  buildIntegratedDiagnostics as buildIntegratedDiagnosticsFromRuntime,
  buildStatusHeadlineFromRuntime,
  buildStatusMetaFromRuntime,
} from './core/status.ts';
import {
  buildCanonicalBncrSessionKey,
  formatDisplayScope,
  normalizeInboundSessionKey,
  normalizeStoredSessionKey,
  parseRouteFromDisplayScope,
  parseRouteLike,
  parseStrictBncrSessionKey,
  routeKey,
  withTaskSessionKey,
} from './core/targets.ts';
import type { BncrConnection, BncrRoute, OutboxEntry } from './core/types.ts';
import { dispatchBncrInbound } from './messaging/inbound/dispatch.ts';
import { checkBncrMessageGate } from './messaging/inbound/gate.ts';
import { parseBncrInboundParams } from './messaging/inbound/parse.ts';
import {
  buildEnqueueFromReplyDebugInfo,
  buildFlushDebugInfo,
  buildOutboxAckDebugInfo,
  buildOutboxDrainSkipDebugInfo,
  buildOutboxDrainStuckDebugInfo,
  buildOutboxPushOkDebugInfo,
  buildOutboxPushSkipDebugInfo,
  buildOutboxRouteSelectDebugInfo,
  buildOutboxScheduleDebugInfo,
  buildPushFailureDebugInfo,
  buildRetryRerouteDebugInfo,
} from './messaging/outbound/diagnostics.ts';
import { buildBncrMediaOutboundFrame } from './messaging/outbound/media.ts';
import {
  getOpenClawRuntimeConfig,
  getOpenClawRuntimeConfigOrDefault,
} from './openclaw/config-runtime.ts';
import {
  loadOpenClawWebMedia,
  type OpenClawLoadedMedia,
  saveOpenClawChannelMediaBuffer,
} from './openclaw/media-runtime.ts';
import { resolveOpenClawAgentRoute } from './openclaw/routing-runtime.ts';
import {
  extractOpenClawToolSend,
  openClawJsonResult,
  readOpenClawBooleanParam,
  readOpenClawJsonFileWithFallback,
  readOpenClawStringParam,
  writeOpenClawJsonFileAtomically,
} from './openclaw/sdk-helpers.ts';

function buildInboundAcceptedLifecycleDebugInfo(args: {
  stage: 'accepted';
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
  activeConnections: Array<{
    connId: string;
    clientId?: string;
    connectedAt: number;
    lastSeenAt: number;
  }>;
}) {
  return {
    stage: args.stage,
    bridge: args.bridge,
    accountId: args.accountId,
    connId: args.connId,
    clientId: args.clientId,
    outboundReady: args.outboundReady,
    preferredForOutbound: args.preferredForOutbound,
    inboundOnly: args.inboundOnly,
    onlineAfterSeen: args.onlineAfterSeen,
    recentInboundReachable: args.recentInboundReachable,
    activeConnectionKey: args.activeConnectionKey,
    activeConnections: args.activeConnections,
  };
}

function resolveInboundSessionContext(args: {
  cfg: any;
  accountId: string;
  peer: { kind: string } & Record<string, unknown>;
  route: BncrRoute;
  sessionKeyFromRoute?: string;
  canonicalAgentId: string;
  taskKey?: string;
  text: string;
  extractedText?: string;
  resolveAgentRoute: (params: { cfg: any; channel: string; accountId: string; peer: unknown }) => {
    sessionKey: string;
  };
}) {
  const resolvedRoute = args.resolveAgentRoute({
    cfg: args.cfg,
    channel: CHANNEL_ID,
    accountId: args.accountId,
    peer: args.peer,
  });
  const baseSessionKey =
    normalizeInboundSessionKey(args.sessionKeyFromRoute, args.route, args.canonicalAgentId) ||
    resolvedRoute.sessionKey;
  const taskSessionKey = withTaskSessionKey(baseSessionKey, args.taskKey);
  return {
    resolvedRoute,
    baseSessionKey,
    taskSessionKey,
    sessionKey: taskSessionKey || baseSessionKey,
    inboundText: asString(args.extractedText || args.text || ''),
  };
}

function buildInboundResponsePayload(
  args:
    | {
        kind: 'stale-ignored';
        accountId: string;
        msgId?: string | null;
      }
    | {
        kind: 'invalid-peer';
      }
    | {
        kind: 'duplicated';
        accountId: string;
        msgId?: string | null;
      }
    | {
        kind: 'gate-denied';
        accountId: string;
        msgId?: string | null;
        reason: string;
      }
    | {
        kind: 'accepted';
        accountId: string;
        sessionKey: string;
        msgId?: string | null;
        taskKey?: string | null;
      },
) {
  switch (args.kind) {
    case 'stale-ignored':
      return {
        accepted: false,
        stale: true,
        ignored: true,
        accountId: args.accountId,
        msgId: args.msgId ?? null,
      };
    case 'invalid-peer':
      return { error: 'platform/groupId/userId required' };
    case 'duplicated':
      return {
        accepted: true,
        duplicated: true,
        accountId: args.accountId,
        msgId: args.msgId ?? null,
      };
    case 'gate-denied':
      return {
        accepted: false,
        accountId: args.accountId,
        msgId: args.msgId ?? null,
        reason: args.reason,
      };
    case 'accepted':
      return {
        accepted: true,
        accountId: args.accountId,
        sessionKey: args.sessionKey,
        msgId: args.msgId ?? null,
        taskKey: args.taskKey ?? null,
      };
  }
}

import { buildBncrDurableQueuedResult } from './messaging/outbound/durable-queue-adapter.ts';
import {
  buildMediaTextFallback,
  type MediaDedupeCacheEntry,
  normalizeMessageText,
  normalizeReplyToId,
} from './messaging/outbound/media-dedupe.ts';
import {
  buildOutboxOnlineDebugInfo,
  clampOutboxDrainDelay,
  computeNextOutboxDelay,
  computeOutboxRetryWait,
  findDueOutboxEntry,
  listAccountOutboxEntries,
  selectOutboxFileTransferRouteCandidates,
  selectOutboxRouteCandidates,
  selectOutboxTargetAccounts,
  updateMinOutboxDelay,
} from './messaging/outbound/queue-selectors.ts';
import {
  OUTBOUND_DEGRADE_REASON,
  OUTBOUND_FLUSH_REASON,
  OUTBOUND_FLUSH_TRIGGER,
  OUTBOUND_SCHEDULE_SOURCE,
  OUTBOUND_TERMINAL_REASON,
} from './messaging/outbound/reasons.ts';
import {
  enqueueNormalizedReplyPayload,
  enqueueReplyMediaFallbackTextEntry,
  enqueueReplyMediaFileTransferEntry,
  enqueueReplyTextEntry,
  enqueueSingleReplyMediaEntry,
  hasReplyMediaEntries,
  type NormalizedReplyPayload,
  normalizeReplyPayload,
  type ReplyMediaEntriesParams,
  type ReplyPayloadInput,
} from './messaging/outbound/reply-enqueue.ts';
import {
  computePushFailureDecision,
  computeRetryRerouteDecision,
} from './messaging/outbound/retry-policy.ts';
import { sendBncrMedia, sendBncrText } from './messaging/outbound/send.ts';
import { BNCR_CHANNEL_CAPABILITIES } from './plugin/capabilities.ts';
import { BNCR_CONFIG_SURFACE } from './plugin/config.ts';
import { BNCR_GATEWAY_METHODS } from './plugin/gateway-methods.ts';
import { createBncrGatewayRuntime } from './plugin/gateway-runtime.ts';
import { BNCR_MESSAGE_RECEIVE_POLICY } from './plugin/message-policy.ts';
import { createBncrMessageSend } from './plugin/message-send.ts';
import { createBncrMessagingSurface } from './plugin/messaging.ts';
import { BNCR_CHANNEL_META } from './plugin/meta.ts';
import { createBncrOutboundRuntime } from './plugin/outbound.ts';
import { BNCR_SETUP_SURFACE } from './plugin/setup.ts';
import { createBncrStatusSurface } from './plugin/status.ts';
import { shouldEmitDedupLog as shouldEmitDedupLogFromRuntime } from './runtime/log-dedupe.ts';
import {
  buildBncrRuntimeAckStrategy,
  computeBncrRecommendedAckTimeoutMs,
  computeBncrRecommendedAckTimeoutReason,
} from './runtime/outbound-ack-timeout.ts';
import {
  buildBncrRuntimeFlags,
  buildBncrRuntimeStatusInput,
  resolveBncrOutboundAckRequired,
} from './runtime/outbound-flags.ts';
import {
  applyBncrPushFailureDecisionToEntry,
  applyBncrRetryRerouteDecisionToEntry,
  buildBncrAckOkTelemetryPatch,
  buildBncrAckRetryEntryPatch,
  buildBncrOutboxFailureEntryPatch,
  buildBncrOutboxPushSuccessEntryPatch,
} from './runtime/outbox-transitions.ts';
import { buildRuntimeStatusSnapshots } from './runtime/status-snapshots.ts';
import {
  type ChannelAccountWorkerHandle,
  clearAllBncrStatusWorkers,
  startBncrStatusWorker,
  stopBncrStatusWorker,
} from './runtime/status-worker.ts';

const BRIDGE_VERSION = 2;
const BNCR_PUSH_EVENT = 'plugin.bncr.push';
const BNCR_FILE_INIT_EVENT = 'plugin.bncr.file.init';
const BNCR_FILE_CHUNK_EVENT = 'plugin.bncr.file.chunk';
const BNCR_FILE_COMPLETE_EVENT = 'plugin.bncr.file.complete';
const BNCR_FILE_ABORT_EVENT = 'plugin.bncr.file.abort';
const CONNECT_TTL_MS = 120_000;
const RECENT_INBOUND_SEND_WINDOW_MS = 60_000;
const MAX_RETRY = 10;
const MAX_DEAD_LETTER_ENTRIES = 1000;
const MAX_SESSION_ROUTE_ENTRIES = 1000;
const MAX_ACCOUNT_ACTIVITY_ENTRIES = 1000;
const PUSH_DRAIN_INTERVAL_MS = 500;
const PUSH_DRAIN_ACCOUNT_BUDGET = 5;
const PUSH_DRAIN_ACCOUNT_TIME_BUDGET_MS = 2_000;
const PUSH_DRAIN_EXCEPTION_RETRY_LIMIT = 3;
const PUSH_DRAIN_EXCEPTION_RETRY_DELAY_MS = 1_000;
const PUSH_DRAIN_STUCK_WARN_MS = 30_000;
const PRE_PUSH_GUARD_RETRY_DELAY_MS = 1_000;
const PUSH_ACK_TIMEOUT_MS = 30_000;
const ADAPTIVE_ACK_TIMEOUT_DEFAULT_ENABLED = true;
const RECOMMENDED_ACK_TIMEOUT_MIN_MS = PUSH_ACK_TIMEOUT_MS;
const RECOMMENDED_ACK_TIMEOUT_MAX_MS = 90_000;
const ADAPTIVE_ACK_TIMEOUT_OBSERVATION_TTL_MS = 60 * 60 * 1000;
const ADAPTIVE_ACK_TIMEOUT_RECOVERY_OK_THRESHOLD = 3;
const ADAPTIVE_ACK_TIMEOUT_LOG_THROTTLE_MS = 5 * 60 * 1000;
const OUTBOUND_READY_TTL_MS = 30_000;
const PREFERRED_OUTBOUND_TTL_MS = 12_000;
const FILE_FORCE_CHUNK = true; // 统一走 WS 分块，保留 base64 仅作兜底
const FILE_INLINE_THRESHOLD = 5 * 1024 * 1024; // fallback 阈值（仅 FILE_FORCE_CHUNK=false 时生效）
const FILE_CHUNK_SIZE = 256 * 1024; // 256KB
const INBOUND_FILE_TRANSFER_MAX_BYTES = 50 * 1024 * 1024;
const INBOUND_FILE_TRANSFER_MAX_CHUNKS =
  Math.ceil(INBOUND_FILE_TRANSFER_MAX_BYTES / FILE_CHUNK_SIZE) + 1;
const FILE_ACK_TIMEOUT_MS = 30_000;
const FILE_TRANSFER_ACK_TTL_MS = 30_000;
const MAX_EARLY_FILE_ACKS = 1000;
const INTERNAL_SLEEP_MAX_MS = 120_000;
const FILE_TRANSFER_KEEP_MS = 6 * 60 * 60 * 1000;
const FILE_TRANSFER_TERMINAL_KEEP_MS = 10 * 60 * 1000;
const REGISTER_WARMUP_WINDOW_MS = 30_000;
let BNCR_DEBUG_VERBOSE = false; // 全局调试日志开关（默认关闭）

type FileSendTransferState = {
  transferId: string;
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  fileName: string;
  mimeType: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  fileSha256: string;
  startedAt: number;
  status: 'init' | 'transferring' | 'completed' | 'aborted';
  ackedChunks: Set<number>;
  failedChunks: Map<number, string>;
  ownerConnId?: string;
  ownerClientId?: string;
  completedPath?: string;
  terminalAt?: number;
  error?: string;
};

type FileRecvTransferState = {
  transferId: string;
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  fileName: string;
  mimeType: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  fileSha256: string;
  startedAt: number;
  status: 'init' | 'transferring' | 'completed' | 'aborted';
  bufferByChunk: Map<number, Buffer>;
  receivedChunks: Set<number>;
  ownerConnId?: string;
  ownerClientId?: string;
  completedPath?: string;
  terminalAt?: number;
  error?: string;
};

type FileAckPayloadState = {
  payload: Record<string, unknown>;
  ok: boolean;
  at: number;
};

type ChannelMessageActionAdapter = {
  describeMessageTool: (ctx: { cfg: any }) => { actions: string[]; capabilities: unknown[] } | null;
  supportsAction: (ctx: { action: string }) => boolean;
  extractToolSend: (ctx: { args: unknown }) => unknown;
  handleAction: (ctx: {
    action: string;
    params: unknown;
    accountId: string;
    mediaLocalRoots?: string[];
  }) => Promise<unknown>;
};

type PersistedState = {
  outbox: OutboxEntry[];
  deadLetter: OutboxEntry[];
  sessionRoutes: Array<{
    sessionKey: string;
    accountId: string;
    route: BncrRoute;
    updatedAt: number;
  }>;
  lastSessionByAccount?: Array<{
    accountId: string;
    sessionKey: string;
    scope: string;
    updatedAt: number;
  }>;
  lastActivityByAccount?: Array<{
    accountId: string;
    updatedAt: number;
  }>;
  lastInboundByAccount?: Array<{
    accountId: string;
    updatedAt: number;
  }>;
  lastOutboundByAccount?: Array<{
    accountId: string;
    updatedAt: number;
  }>;
  lastDriftSnapshot?: {
    capturedAt: number;
    registerCount: number | null;
    apiGeneration: number | null;
    postWarmupRegisterCount: number | null;
    apiInstanceId: string | null;
    registryFingerprint: string | null;
    dominantBucket: string | null;
    sourceBuckets: Record<string, number>;
    traceWindowSize: number;
    traceRecent: Array<Record<string, unknown>>;
  } | null;
};

type NormalizedBncrSendParams = {
  to: string;
  accountId: string;
  message: string;
  caption: string;
  mediaUrl?: string;
  asVoice: boolean;
  audioAsVoice: boolean;
};

function normalizeBncrSendParams(input: {
  params: unknown;
  accountId: string;
}): NormalizedBncrSendParams {
  const paramsObj = isPlainObject(input.params) ? input.params : {};
  const to = readOpenClawStringParam(paramsObj, 'to', { required: true });
  const resolvedAccountId = normalizeAccountId(
    readOpenClawStringParam(paramsObj, 'accountId') ?? input.accountId,
  );

  const message = readOpenClawStringParam(paramsObj, 'message', { allowEmpty: true }) ?? '';
  const caption = readOpenClawStringParam(paramsObj, 'caption', { allowEmpty: true }) ?? '';
  const mediaUrl =
    readOpenClawStringParam(paramsObj, 'media', { trim: false }) ??
    readOpenClawStringParam(paramsObj, 'path', { trim: false }) ??
    readOpenClawStringParam(paramsObj, 'filePath', { trim: false }) ??
    readOpenClawStringParam(paramsObj, 'mediaUrl', { trim: false });
  const asVoice = readOpenClawBooleanParam(paramsObj, 'asVoice') ?? false;
  const audioAsVoice = readOpenClawBooleanParam(paramsObj, 'audioAsVoice') ?? false;

  if (asVoice && !mediaUrl) throw new Error('send voice requires media path');

  const normalizedMessage = mediaUrl ? '' : message || caption || '';
  const normalizedCaption = mediaUrl ? caption || message || '' : '';

  if (!normalizedMessage.trim() && !normalizedCaption.trim() && !mediaUrl) {
    throw new Error('send requires message or media');
  }

  return {
    to,
    accountId: resolvedAccountId,
    message: normalizedMessage,
    caption: normalizedCaption,
    mediaUrl: mediaUrl || undefined,
    asVoice,
    audioAsVoice,
  };
}

function now() {
  return Date.now();
}

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

function finiteNumberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function finiteNonNegativeNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function clampFiniteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  const finite = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(finite, max));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function backoffMs(retryCount: number): number {
  // 1s,2s,4s,8s... capped by retry count checks
  return Math.max(1_000, 1_000 * 2 ** Math.max(0, retryCount - 1));
}

function fileExtFromMime(mimeType?: string): string {
  const mt = asString(mimeType || '').toLowerCase();
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
  };
  return map[mt] || '';
}

function sanitizeFileName(rawName?: string, fallback = 'file.bin'): string {
  const name = asString(rawName || '').trim();
  const base = name || fallback;
  const cleaned = Array.from(base, (ch) => {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f) return '_';
    if ('\\/:*?"<>|'.includes(ch)) return '_';
    return ch;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function buildTimestampFileName(mimeType?: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const ext = fileExtFromMime(mimeType) || '.bin';
  return `bncr_${ts}_${Math.random().toString(16).slice(2, 8)}${ext}`;
}

function resolveOutboundFileName(params: {
  mediaUrl?: string;
  fileName?: string;
  mimeType?: string;
}): string {
  const mediaUrl = asString(params.mediaUrl || '').trim();
  const mimeType = asString(params.mimeType || '').trim();

  // 线上下载的文件，统一用时间戳命名（避免超长/无意义文件名）
  if (/^https?:\/\//i.test(mediaUrl)) {
    return buildTimestampFileName(mimeType);
  }

  const candidate = sanitizeFileName(params.fileName, 'file.bin');
  if (candidate.length <= 80) return candidate;

  // 超长文件名做裁剪，尽量保留扩展名
  const ext = path.extname(candidate);
  const stem = candidate.slice(0, Math.max(1, 80 - ext.length));
  return `${stem}${ext}`;
}

class BncrBridgeRuntime {
  private api: OpenClawPluginApi;
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

  private connections = new Map<string, BncrConnection>(); // connectionKey -> connection
  private activeConnectionByAccount = new Map<string, string>(); // accountId -> connectionKey
  private outbox = new Map<string, OutboxEntry>(); // messageId -> entry
  private deadLetter: OutboxEntry[] = [];

  private sessionRoutes = new Map<
    string,
    { accountId: string; route: BncrRoute; updatedAt: number }
  >();
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
  private adaptiveAckRecoveryOkCountByAccount = new Map<string, number>();
  private adaptiveAckTimeoutLogStateByAccount = new Map<
    string,
    { at: number; timeoutMs: number; reason: string }
  >();
  private channelAccountWorkers = new Map<string, ChannelAccountWorkerHandle>();
  private logDedupeState = new Map<string, { at: number; sig: string }>();
  private canonicalAgentId: string | null = null;

  // 内置健康/回归计数（替代独立脚本）
  private startedAt = now();
  private stopped = false;
  private connectEventsByAccount = new Map<string, number>();
  private inboundEventsByAccount = new Map<string, number>();
  private activityEventsByAccount = new Map<string, number>();
  private ackEventsByAccount = new Map<string, number>();

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

  private rememberEarlyFileAck(key: string, state: FileAckPayloadState) {
    this.earlyFileAcks.set(key, state);
    while (this.earlyFileAcks.size > MAX_EARLY_FILE_ACKS) {
      const oldestKey = this.earlyFileAcks.keys().next().value;
      if (!oldestKey) break;
      this.earlyFileAcks.delete(oldestKey);
    }
  }

  constructor(api: OpenClawPluginApi) {
    this.api = api;
  }

  bindApi(api: OpenClawPluginApi) {
    this.api = api;
  }

  getBridgeId() {
    return this.bridgeId;
  }

  private logInfo(scope: string | undefined, message: string, options?: { debugOnly?: boolean }) {
    emitBncrLog('info', scope, message, options, () => this.isDebugEnabled());
  }

  private logWarn(scope: string | undefined, message: string, options?: { debugOnly?: boolean }) {
    emitBncrLog('warn', scope, message, options, () => this.isDebugEnabled());
  }

  private logError(scope: string | undefined, message: string, options?: { debugOnly?: boolean }) {
    emitBncrLog('error', scope, message, options, () => this.isDebugEnabled());
  }

  private buildDebugJsonMessage(event: string, payload: Record<string, unknown>) {
    return `${event} ${JSON.stringify(payload)}`;
  }

  private logInfoJson(
    scope: string | undefined,
    event: string,
    payload: Record<string, unknown>,
    options?: { debugOnly?: boolean },
  ) {
    this.logInfo(scope, this.buildDebugJsonMessage(event, payload), options);
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
    const compact = asString(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!compact) return '-';
    const chars = Array.from(compact);
    return chars.length > limit ? `${chars.slice(0, Math.max(1, limit)).join('')}…` : compact;
  }

  private summarizeScope(route: BncrRoute) {
    return formatDisplayScope(route);
  }

  private logInboundSummary(params: {
    accountId: string;
    route: BncrRoute;
    msgType: string;
    text: string;
    hasMedia: boolean;
  }) {
    const type = params.hasMedia ? `${params.msgType}+media` : params.msgType;
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
    return {
      workers: this.channelAccountWorkers,
      bridgeId: this.bridgeId,
      hooks: {
        isOnline: (accountId: string) => this.isOnline(accountId),
        hasRecentInboundReachability: (accountId: string) =>
          this.hasRecentInboundReachability(accountId),
        getLastActivityAt: (accountId: string, previous: Record<string, any>) =>
          this.lastActivityByAccount.get(accountId) ||
          this.lastInboundByAccount.get(accountId) ||
          this.lastOutboundByAccount.get(accountId) ||
          previous?.lastEventAt ||
          null,
        getActiveConnectionKey: (accountId: string) =>
          this.activeConnectionByAccount.get(accountId) || null,
        getActiveConnections: (accountId: string) =>
          Array.from(this.connections.values())
            .filter((c) => c.accountId === accountId)
            .map((c) => ({
              connId: c.connId,
              clientId: c.clientId,
              inboundOnly: c.inboundOnly === true,
              outboundReady: c.outboundReady === true,
              preferredForOutbound: c.preferredForOutbound === true,
            })),
        buildStatusMeta: (accountId: string) => this.buildStatusMeta(accountId),
        logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) =>
          this.logInfo(scope, message, options),
        logInfoDedup: (
          scope: string | undefined,
          message: string,
          options: { key: string; sig: string; debugOnly?: boolean; windowMs?: number },
        ) => this.logInfoDedup(scope, message, options),
      },
    };
  }

  private clearAllChannelAccountWorkers(reason: string) {
    clearAllBncrStatusWorkers(this.buildStatusWorkerRuntime(), reason);
  }

  private captureDriftSnapshot(
    summary: ReturnType<BncrBridgeRuntime['buildRegisterTraceSummary']>,
  ) {
    this.lastDriftSnapshot = buildRegisterDriftSnapshot({
      capturedAt: now(),
      registerCount: this.registerCount,
      apiGeneration: this.apiGeneration,
      summary,
      apiInstanceId: this.lastApiInstanceId,
      registryFingerprint: this.lastRegistryFingerprint,
      traceRecent: this.registerTraceRecent,
    });
    this.scheduleSave();
  }

  private buildRegisterTraceSummary() {
    return buildRegisterTraceSummaryFromEntries({
      traceRecent: this.registerTraceRecent,
      firstRegisterAt: this.firstRegisterAt,
      warmupWindowMs: REGISTER_WARMUP_WINDOW_MS,
    });
  }

  noteRegister(meta: {
    source?: string;
    pluginVersion?: string;
    apiRebound?: boolean;
    apiInstanceId?: string;
    registryFingerprint?: string;
  }) {
    const ts = now();
    this.registerCount += 1;
    if (this.firstRegisterAt == null) this.firstRegisterAt = ts;
    this.lastRegisterAt = ts;
    if (meta.apiRebound) {
      this.apiGeneration += 1;
      this.lastApiRebindAt = ts;
    } else if (this.registerCount === 1 && this.apiGeneration === 0) {
      this.apiGeneration = 1;
    }
    if (meta.source) this.pluginSource = meta.source;
    if (meta.pluginVersion) this.pluginVersion = meta.pluginVersion;
    if (meta.apiInstanceId) this.lastApiInstanceId = meta.apiInstanceId;
    if (meta.registryFingerprint) this.lastRegistryFingerprint = meta.registryFingerprint;

    const stack = String(new Error().stack || '')
      .split('\n')
      .slice(2, 7)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' <- ');
    const trace = buildRegisterTraceEntry({
      ts,
      bridgeId: this.bridgeId,
      gatewayPid: this.gatewayPid,
      registerCount: this.registerCount,
      apiGeneration: this.apiGeneration,
      apiRebound: meta.apiRebound === true,
      apiInstanceId: this.lastApiInstanceId,
      registryFingerprint: this.lastRegistryFingerprint,
      source: this.pluginSource,
      pluginVersion: this.pluginVersion,
      stack,
    });
    appendBoundedRegisterTrace(this.registerTraceRecent, trace, 12);

    const summary = this.buildRegisterTraceSummary();
    if (summary.postWarmupRegisterCount > 0) this.captureDriftSnapshot(summary);

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
    const channelRuntime = (this.api as any)?.runtime?.channel;
    const surfaces = {
      inbound: Boolean(channelRuntime?.inbound),
      media: Boolean(channelRuntime?.media),
      reply: Boolean(channelRuntime?.reply),
      routing: Boolean(channelRuntime?.routing),
      session: Boolean(channelRuntime?.session),
    };
    return {
      channel: surfaces,
      missing: Object.entries(surfaces)
        .filter(([, present]) => !present)
        .map(([name]) => name),
    };
  }

  private buildExtendedDiagnostics(accountId: string) {
    const acc = normalizeAccountId(accountId);
    const diagnostics = this.buildIntegratedDiagnostics(acc) as Record<string, any>;
    return buildExtendedDiagnosticsFromRuntime({
      diagnostics,
      runtimeSurface: this.buildRuntimeSurfaceDiagnostics(),
      register: {
        bridgeId: this.bridgeId,
        gatewayPid: this.gatewayPid,
        pluginVersion: this.pluginVersion,
        source: this.pluginSource,
        apiInstanceId: this.lastApiInstanceId,
        registryFingerprint: this.lastRegistryFingerprint,
        registerCount: this.registerCount,
        firstRegisterAt: this.firstRegisterAt,
        lastRegisterAt: this.lastRegisterAt,
        lastApiRebindAt: this.lastApiRebindAt,
        apiGeneration: this.apiGeneration,
        traceRecent: this.registerTraceRecent,
        traceSummary: this.buildRegisterTraceSummary(),
        lastDriftSnapshot: this.lastDriftSnapshot,
      },
      connection: {
        active: this.activeConnectionCount(acc),
        primaryLeaseId: this.primaryLeaseId,
        primaryEpoch: this.connectionEpoch || null,
        acceptedConnections: this.acceptedConnections,
        lastConnectAt: this.lastConnectAt,
        lastDisconnectAt: this.lastDisconnectAt,
        lastActivityAt: this.lastActivityAtGlobal,
        lastInboundAt: this.lastInboundAtGlobal,
        lastAckAt: this.lastAckAtGlobal,
        hasGatewayContext: Boolean(this.gatewayContext),
        lastGatewayContextAt: this.lastGatewayContextAt,
        recent: Array.from(this.recentConnections.entries()).map(([leaseId, entry]) => ({
          leaseId,
          epoch: entry.epoch,
          connectedAt: entry.connectedAt,
          lastActivityAt: entry.lastActivityAt,
          isPrimary: entry.isPrimary,
        })),
      },
      outbound: {
        pending: Array.from(this.outbox.values()).filter((entry) => entry.accountId === acc).length,
        enqueueCount: this.getCounter(this.outboundEnqueueCountByAccount, acc),
        lastEnqueueAt: this.lastOutboundEnqueueAtByAccount.get(acc) || null,
        prePushGuardSkipCount: this.getCounter(this.prePushGuardSkipCountByAccount, acc),
        lastPrePushGuardSkipAt: this.lastPrePushGuardSkipAtByAccount.get(acc) || null,
        lastPrePushGuardSkipReason: this.lastPrePushGuardSkipReasonByAccount.get(acc) || null,
        hasGatewayContext: Boolean(this.gatewayContext),
        lastGatewayContextAt: this.lastGatewayContextAt,
      },
      protocol: {
        bridgeVersion: BRIDGE_VERSION,
        protocolVersion: 2,
        minClientProtocol: 1,
        features: {
          leaseId: true,
          connectionEpoch: true,
          staleObserveOnly: true,
          staleRejectAck: false,
          staleRejectFile: false,
        },
      },
      stale: this.staleCounters,
    });
  }

  isDebugEnabled(): boolean {
    return BNCR_DEBUG_VERBOSE;
  }

  startService = async (ctx: OpenClawPluginServiceContext, debug?: boolean) => {
    this.stopped = false;
    this.statePath = path.join(ctx.stateDir, 'bncr-bridge-state.json');
    try {
      const cfg = getOpenClawRuntimeConfig(this.api);
      this.initializeCanonicalAgentId(cfg);
      for (const warning of resolveBncrConfigWarnings(cfg?.channels?.[CHANNEL_ID] || {})) {
        this.logWarn('config', warning);
      }
    } catch {
      // ignore startup canonical agent initialization errors
    }
    await this.loadState();
    if (typeof debug === 'boolean') BNCR_DEBUG_VERBOSE = debug;
    await this.refreshDebugFlagFromConfig({ forceLog: true });
    const bootDiag = this.buildIntegratedDiagnostics(BNCR_DEFAULT_ACCOUNT_ID);
    this.logInfo(
      'startup',
      `bridge=${this.bridgeId} routes=${bootDiag.regression.totalKnownRoutes}`,
    );
    this.logInfo(
      'debug',
      `service started bridge=${this.bridgeId} diag.ok=${bootDiag.regression.ok} routes=${bootDiag.regression.totalKnownRoutes} pending=${bootDiag.health.pending} dead=${bootDiag.health.deadLetter} debug=${BNCR_DEBUG_VERBOSE}`,
      { debugOnly: true },
    );
  };

  stopService = async () => {
    this.cleanupRuntimeWaitersAndTimers('service stopped');
    await this.flushState();
    this.logInfo('debug', 'service stopped', { debugOnly: true });
  };

  shutdown() {
    this.cleanupRuntimeWaitersAndTimers('shutdown');
  }

  private cleanupRuntimeWaitersAndTimers(reason: string) {
    this.logInfo(
      'lifecycle',
      `cleanup ${JSON.stringify({
        bridge: this.bridgeId,
        reason,
        messageAckWaiters: this.messageAckWaiters.size,
        fileAckWaiters: this.fileAckWaiters.size,
        earlyFileAcks: this.earlyFileAcks.size,
        outbox: this.outbox.size,
        runningDrainAccounts: this.pushDrainRunningAccounts.size,
        channelAccountWorkers: this.channelAccountWorkers.size,
        hasSaveTimer: !!this.saveTimer,
        hasPushTimer: !!this.pushTimer,
      })}`,
      { debugOnly: true },
    );
    this.stopped = true;
    this.clearAllChannelAccountWorkers(reason);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    for (const waiter of this.messageAckWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve('timeout');
    }
    this.messageAckWaiters.clear();
    for (const waiter of this.fileAckWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.fileAckWaiters.clear();
    this.earlyFileAcks.clear();
  }

  private scheduleSave() {
    if (this.stopped) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.stopped) return;
      void this.flushState();
    }, 300);
  }

  private incrementCounter(map: Map<string, number>, accountId: string) {
    const acc = normalizeAccountId(accountId);
    map.set(acc, (map.get(acc) || 0) + 1);
  }

  private getCounter(map: Map<string, number>, accountId: string): number {
    return map.get(normalizeAccountId(accountId)) || 0;
  }

  private async refreshDebugFlagFromConfig(options?: { forceLog?: boolean }) {
    try {
      const cfg = getOpenClawRuntimeConfig(this.api);
      const raw = (cfg as any)?.channels?.[CHANNEL_ID]?.debug?.verbose;
      const next = typeof raw === 'boolean' ? raw : false;
      const changed = next !== BNCR_DEBUG_VERBOSE;
      BNCR_DEBUG_VERBOSE = next;
      if (changed || options?.forceLog) {
        this.logInfo('debug', `verbose=${BNCR_DEBUG_VERBOSE}`, { debugOnly: true });
      }
    } catch {
      // ignore config read errors
    }
  }

  private async syncDebugFlag() {
    await this.refreshDebugFlagFromConfig();
  }

  private tryResolveBindingAgentId(args: {
    cfg: any;
    accountId: string;
    peer?: any;
    channelId?: string;
  }): string | null {
    try {
      const resolved = resolveOpenClawAgentRoute(this.api, {
        cfg: args.cfg,
        channel: args.channelId || CHANNEL_ID,
        accountId: normalizeAccountId(args.accountId),
        peer: args.peer,
      });
      const agentId = asString(resolved?.agentId || '').trim();
      return agentId || null;
    } catch {
      return null;
    }
  }

  private initializeCanonicalAgentId(cfg: any) {
    if (this.canonicalAgentId) return;
    const agentId = this.tryResolveBindingAgentId({
      cfg,
      accountId: BNCR_DEFAULT_ACCOUNT_ID,
      channelId: CHANNEL_ID,
      peer: { kind: 'direct', id: 'bootstrap' },
    });
    if (!agentId) return;
    this.canonicalAgentId = agentId;
  }

  private ensureCanonicalAgentId(args: {
    cfg: any;
    accountId: string;
    peer?: any;
    channelId?: string;
  }): string {
    if (this.canonicalAgentId) return this.canonicalAgentId;

    const agentId = this.tryResolveBindingAgentId(args);
    if (agentId) {
      this.canonicalAgentId = agentId;
      return agentId;
    }

    this.canonicalAgentId = 'main';
    this.logWarn(
      'target',
      'binding agent unresolved; fallback to main for current process lifetime',
      { debugOnly: true },
    );
    return this.canonicalAgentId;
  }

  private countInvalidOutboxSessionKeys(accountId: string): number {
    const acc = normalizeAccountId(accountId);
    let count = 0;
    for (const entry of this.outbox.values()) {
      if (entry.accountId !== acc) continue;
      if (!parseStrictBncrSessionKey(entry.sessionKey)) count += 1;
    }
    return count;
  }

  private countLegacyAccountResidue(accountId: string): number {
    const acc = normalizeAccountId(accountId);
    const mismatched = (raw?: string | null) =>
      asString(raw || '').trim() && normalizeAccountId(raw) !== acc;

    let count = 0;

    for (const entry of this.outbox.values()) {
      if (mismatched(entry.accountId)) count += 1;
    }
    for (const entry of this.deadLetter) {
      if (mismatched(entry.accountId)) count += 1;
    }
    for (const info of this.sessionRoutes.values()) {
      if (mismatched(info.accountId)) count += 1;
    }
    for (const key of this.lastSessionByAccount.keys()) {
      if (mismatched(key)) count += 1;
    }
    for (const key of this.lastActivityByAccount.keys()) {
      if (mismatched(key)) count += 1;
    }
    for (const key of this.lastInboundByAccount.keys()) {
      if (mismatched(key)) count += 1;
    }
    for (const key of this.lastOutboundByAccount.keys()) {
      if (mismatched(key)) count += 1;
    }

    return count;
  }

  private buildIntegratedDiagnostics(accountId: string) {
    const ackObservability = this.buildRuntimeAckObservability(accountId);
    const ackStrategy = this.buildRuntimeAckStrategy(ackObservability);
    return {
      ...buildIntegratedDiagnosticsFromRuntime(this.buildRuntimeStatusInput(accountId)),
      ackObservability,
      ackStrategy,
    };
  }

  private buildDownlinkHealth(accountId: string) {
    const acc = normalizeAccountId(accountId);
    return buildDownlinkHealthFromRuntime({
      accountId: acc,
      now: now(),
      outboxEntries: this.outbox.values(),
      lastAckOkAt: this.lastAckOkByAccount.get(acc) || null,
      lastAckTimeoutAt: this.lastAckTimeoutByAccount.get(acc) || null,
      recentAckTimeoutCount: this.getCounter(this.ackTimeoutCountByAccount, acc),
      activeConnectionCount: this.activeConnectionCount(acc),
      lastInboundAt: this.lastInboundByAccount.get(acc) || null,
      lastActivityAt: this.lastActivityByAccount.get(acc) || null,
      onlineByConn: this.isOnline(acc),
    });
  }

  private async loadState() {
    if (!this.statePath) return;
    const loaded = await readOpenClawJsonFileWithFallback(this.statePath, {
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
    });
    const data = loaded.value as PersistedState;

    this.outbox.clear();
    for (const entry of data.outbox || []) {
      if (!entry?.messageId) continue;
      const accountId = normalizeAccountId(entry.accountId);
      const sessionKey = asString(entry.sessionKey || '').trim();
      const normalized = normalizeStoredSessionKey(sessionKey, this.canonicalAgentId);
      if (!normalized) continue;

      const route = parseRouteLike(entry.route) || normalized.route;
      const payload =
        entry.payload && typeof entry.payload === 'object' ? { ...entry.payload } : {};
      (payload as any).sessionKey = normalized.sessionKey;
      (payload as any).platform = route.platform;
      (payload as any).groupId = route.groupId;
      (payload as any).userId = route.userId;

      const migratedEntry: OutboxEntry = {
        ...entry,
        accountId,
        sessionKey: normalized.sessionKey,
        route,
        payload,
        createdAt: finiteNumberOr(entry.createdAt, now()),
        retryCount: finiteNumberOr(entry.retryCount, 0),
        nextAttemptAt: finiteNumberOr(entry.nextAttemptAt, now()),
        lastAttemptAt: optionalFiniteNumber(entry.lastAttemptAt),
        lastError: entry.lastError ? asString(entry.lastError) : undefined,
      };

      this.outbox.set(migratedEntry.messageId, migratedEntry);
    }

    this.deadLetter = [];
    const persistedDeadLetter = Array.isArray(data.deadLetter)
      ? data.deadLetter.slice(-MAX_DEAD_LETTER_ENTRIES)
      : [];
    for (const entry of persistedDeadLetter) {
      if (!entry?.messageId) continue;
      const accountId = normalizeAccountId(entry.accountId);
      const sessionKey = asString(entry.sessionKey || '').trim();
      const normalized = normalizeStoredSessionKey(sessionKey, this.canonicalAgentId);
      if (!normalized) continue;

      const route = parseRouteLike(entry.route) || normalized.route;
      const payload =
        entry.payload && typeof entry.payload === 'object' ? { ...entry.payload } : {};
      (payload as any).sessionKey = normalized.sessionKey;
      (payload as any).platform = route.platform;
      (payload as any).groupId = route.groupId;
      (payload as any).userId = route.userId;

      this.deadLetter.push({
        ...entry,
        accountId,
        sessionKey: normalized.sessionKey,
        route,
        payload,
        createdAt: finiteNumberOr(entry.createdAt, now()),
        retryCount: finiteNumberOr(entry.retryCount, 0),
        nextAttemptAt: finiteNumberOr(entry.nextAttemptAt, now()),
        lastAttemptAt: optionalFiniteNumber(entry.lastAttemptAt),
        lastError: entry.lastError ? asString(entry.lastError) : undefined,
      });
    }

    this.sessionRoutes.clear();
    this.routeAliases.clear();
    const persistedSessionRoutes = Array.isArray(data.sessionRoutes)
      ? data.sessionRoutes.slice(-MAX_SESSION_ROUTE_ENTRIES)
      : [];
    for (const item of persistedSessionRoutes) {
      const normalized = normalizeStoredSessionKey(
        asString(item?.sessionKey || ''),
        this.canonicalAgentId,
      );
      if (!normalized) continue;

      const route = parseRouteLike(item?.route) || normalized.route;
      const accountId = normalizeAccountId(item?.accountId);
      const updatedAt = finiteNumberOr(item?.updatedAt, now());

      const info = {
        accountId,
        route,
        updatedAt,
      };

      this.sessionRoutes.set(normalized.sessionKey, info);
      this.routeAliases.set(routeKey(accountId, route), info);
    }

    this.lastSessionByAccount.clear();
    const persistedLastSessionByAccount = Array.isArray(data.lastSessionByAccount)
      ? data.lastSessionByAccount.slice(-MAX_ACCOUNT_ACTIVITY_ENTRIES)
      : [];
    for (const item of persistedLastSessionByAccount) {
      const accountId = normalizeAccountId(item?.accountId);
      const normalized = normalizeStoredSessionKey(
        asString(item?.sessionKey || ''),
        this.canonicalAgentId,
      );
      const updatedAt = finiteNumberOr(item?.updatedAt, 0);
      if (!normalized || updatedAt <= 0) continue;

      this.lastSessionByAccount.set(accountId, {
        sessionKey: normalized.sessionKey,
        // 展示统一为 Bncr-platform:group:user
        scope: formatDisplayScope(normalized.route),
        updatedAt,
      });
    }

    this.lastActivityByAccount.clear();
    const persistedLastActivityByAccount = Array.isArray(data.lastActivityByAccount)
      ? data.lastActivityByAccount.slice(-MAX_ACCOUNT_ACTIVITY_ENTRIES)
      : [];
    for (const item of persistedLastActivityByAccount) {
      const accountId = normalizeAccountId(item?.accountId);
      const updatedAt = finiteNumberOr(item?.updatedAt, 0);
      if (updatedAt <= 0) continue;
      this.lastActivityByAccount.set(accountId, updatedAt);
    }

    this.lastInboundByAccount.clear();
    const persistedLastInboundByAccount = Array.isArray(data.lastInboundByAccount)
      ? data.lastInboundByAccount.slice(-MAX_ACCOUNT_ACTIVITY_ENTRIES)
      : [];
    for (const item of persistedLastInboundByAccount) {
      const accountId = normalizeAccountId(item?.accountId);
      const updatedAt = finiteNumberOr(item?.updatedAt, 0);
      if (updatedAt <= 0) continue;
      this.lastInboundByAccount.set(accountId, updatedAt);
    }

    this.lastOutboundByAccount.clear();
    const persistedLastOutboundByAccount = Array.isArray(data.lastOutboundByAccount)
      ? data.lastOutboundByAccount.slice(-MAX_ACCOUNT_ACTIVITY_ENTRIES)
      : [];
    for (const item of persistedLastOutboundByAccount) {
      const accountId = normalizeAccountId(item?.accountId);
      const updatedAt = finiteNumberOr(item?.updatedAt, 0);
      if (updatedAt <= 0) continue;
      this.lastOutboundByAccount.set(accountId, updatedAt);
    }

    this.lastDriftSnapshot =
      data.lastDriftSnapshot && typeof data.lastDriftSnapshot === 'object'
        ? {
            capturedAt: finiteNumberOr((data.lastDriftSnapshot as any).capturedAt, 0),
            registerCount: Number.isFinite(Number((data.lastDriftSnapshot as any).registerCount))
              ? Number((data.lastDriftSnapshot as any).registerCount)
              : null,
            apiGeneration: Number.isFinite(Number((data.lastDriftSnapshot as any).apiGeneration))
              ? Number((data.lastDriftSnapshot as any).apiGeneration)
              : null,
            postWarmupRegisterCount: Number.isFinite(
              Number((data.lastDriftSnapshot as any).postWarmupRegisterCount),
            )
              ? Number((data.lastDriftSnapshot as any).postWarmupRegisterCount)
              : null,
            apiInstanceId:
              asString((data.lastDriftSnapshot as any).apiInstanceId || '').trim() || null,
            registryFingerprint:
              asString((data.lastDriftSnapshot as any).registryFingerprint || '').trim() || null,
            dominantBucket:
              asString((data.lastDriftSnapshot as any).dominantBucket || '').trim() || null,
            sourceBuckets:
              (data.lastDriftSnapshot as any).sourceBuckets &&
              typeof (data.lastDriftSnapshot as any).sourceBuckets === 'object'
                ? { ...((data.lastDriftSnapshot as any).sourceBuckets as Record<string, number>) }
                : {},
            traceWindowSize: finiteNumberOr((data.lastDriftSnapshot as any).traceWindowSize, 0),
            traceRecent: Array.isArray((data.lastDriftSnapshot as any).traceRecent)
              ? [...((data.lastDriftSnapshot as any).traceRecent as Array<Record<string, unknown>>)]
              : [],
          }
        : null;

    // 兼容旧状态文件：若尚未持久化 lastSession*/lastActivity*，从 sessionRoutes 回填。
    if (this.lastSessionByAccount.size === 0 && this.sessionRoutes.size > 0) {
      for (const [sessionKey, info] of this.sessionRoutes.entries()) {
        const acc = normalizeAccountId(info.accountId);
        const updatedAt = finiteNumberOr(info.updatedAt, 0);
        if (updatedAt <= 0) continue;

        const current = this.lastSessionByAccount.get(acc);
        if (!current || updatedAt >= current.updatedAt) {
          this.lastSessionByAccount.set(acc, {
            sessionKey,
            // 回填时统一展示为 Bncr-platform:group:user
            scope: formatDisplayScope(info.route),
            updatedAt,
          });
        }

        const lastAct = this.lastActivityByAccount.get(acc) || 0;
        if (updatedAt > lastAct) this.lastActivityByAccount.set(acc, updatedAt);

        const lastIn = this.lastInboundByAccount.get(acc) || 0;
        if (updatedAt > lastIn) this.lastInboundByAccount.set(acc, updatedAt);
      }
    }
  }

  private async flushState() {
    if (!this.statePath) return;

    const sessionRoutes = Array.from(this.sessionRoutes.entries())
      .map(([sessionKey, v]) => ({
        sessionKey,
        accountId: v.accountId,
        route: v.route,
        updatedAt: v.updatedAt,
      }))
      .slice(-MAX_SESSION_ROUTE_ENTRIES);

    const data: PersistedState = {
      outbox: Array.from(this.outbox.values()),
      deadLetter: this.deadLetter.slice(-MAX_DEAD_LETTER_ENTRIES),
      sessionRoutes,
      lastSessionByAccount: Array.from(this.lastSessionByAccount.entries())
        .map(([accountId, v]) => ({
          accountId,
          sessionKey: v.sessionKey,
          scope: v.scope,
          updatedAt: v.updatedAt,
        }))
        .slice(-MAX_ACCOUNT_ACTIVITY_ENTRIES),
      lastActivityByAccount: Array.from(this.lastActivityByAccount.entries())
        .map(([accountId, updatedAt]) => ({
          accountId,
          updatedAt,
        }))
        .slice(-MAX_ACCOUNT_ACTIVITY_ENTRIES),
      lastInboundByAccount: Array.from(this.lastInboundByAccount.entries())
        .map(([accountId, updatedAt]) => ({
          accountId,
          updatedAt,
        }))
        .slice(-MAX_ACCOUNT_ACTIVITY_ENTRIES),
      lastOutboundByAccount: Array.from(this.lastOutboundByAccount.entries())
        .map(([accountId, updatedAt]) => ({
          accountId,
          updatedAt,
        }))
        .slice(-MAX_ACCOUNT_ACTIVITY_ENTRIES),
      lastDriftSnapshot: this.lastDriftSnapshot
        ? {
            capturedAt: this.lastDriftSnapshot.capturedAt,
            registerCount: this.lastDriftSnapshot.registerCount,
            apiGeneration: this.lastDriftSnapshot.apiGeneration,
            postWarmupRegisterCount: this.lastDriftSnapshot.postWarmupRegisterCount,
            apiInstanceId: this.lastDriftSnapshot.apiInstanceId,
            registryFingerprint: this.lastDriftSnapshot.registryFingerprint,
            dominantBucket: this.lastDriftSnapshot.dominantBucket,
            sourceBuckets: { ...this.lastDriftSnapshot.sourceBuckets },
            traceWindowSize: this.lastDriftSnapshot.traceWindowSize,
            traceRecent: this.lastDriftSnapshot.traceRecent.map((trace) => ({ ...trace })),
          }
        : null,
    };

    await writeOpenClawJsonFileAtomically(this.statePath, data);
  }

  private resolveMessageAck(messageId: string, result: 'acked' | 'timeout' = 'acked') {
    const key = asString(messageId).trim();
    if (!key) return false;
    const waiter = this.messageAckWaiters.get(key);
    if (!waiter) return false;
    this.messageAckWaiters.delete(key);
    clearTimeout(waiter.timer);
    waiter.resolve(result);
    return true;
  }

  private rememberGatewayContext(context: GatewayRequestHandlerOptions['context']) {
    if (!context) return;
    this.gatewayContext = context;
    this.lastGatewayContextAt = now();
  }

  private resolveOutboxPushOwner(accountId: string): BncrConnection | null {
    const acc = normalizeAccountId(accountId);
    const t = now();
    const primaryKey = this.activeConnectionByAccount.get(acc);
    const primary = primaryKey ? this.connections.get(primaryKey) : null;

    const isEligible = (
      conn: BncrConnection | null | undefined,
    ): conn is BncrConnection & {
      outboundReadyUntil?: number;
      preferredForOutboundUntil?: number;
      inboundOnly?: boolean;
    } => {
      if (!conn?.connId) return false;
      if (t - conn.lastSeenAt > CONNECT_TTL_MS) return false;
      if ((conn as any).inboundOnly === true) return false;
      return true;
    };

    const recentInboundConnIds = this.resolveRecentInboundConnIds(acc);
    const candidateScore = (conn: BncrConnection) => {
      const preferredForOutboundUntil = finiteNumberOr((conn as any).preferredForOutboundUntil, 0);
      const outboundReadyUntil = finiteNumberOr((conn as any).outboundReadyUntil, 0);
      const lastPushTimeoutAt = finiteNumberOr((conn as any).lastPushTimeoutAt, 0);
      const lastAckOkAt = finiteNumberOr((conn as any).lastAckOkAt, 0);
      const pushFailureScore = finiteNumberOr((conn as any).pushFailureScore, 0);
      const recentTimeoutPenalty = lastPushTimeoutAt > 0 && t - lastPushTimeoutAt <= 30_000 ? 1 : 0;
      return {
        preferred: preferredForOutboundUntil > t ? 1 : 0,
        ready: outboundReadyUntil > t ? 1 : 0,
        recentInbound: recentInboundConnIds.has(conn.connId) ? 1 : 0,
        recentTimeoutPenalty,
        pushFailureScore,
        lastAckOkAt,
        lastPushTimeoutAt,
        lastSeenAt: conn.lastSeenAt,
        connectedAt: conn.connectedAt,
      };
    };

    if (isEligible(primary)) {
      const score = candidateScore(primary);
      if (score.preferred || score.ready) return primary;
    }

    const candidates = Array.from(this.connections.values())
      .filter((c): c is BncrConnection => c.accountId === acc)
      .filter((c) => isEligible(c))
      .sort((a, b) => {
        const sa = candidateScore(a);
        const sb = candidateScore(b);
        if (sb.preferred !== sa.preferred) return sb.preferred - sa.preferred;
        if (sb.ready !== sa.ready) return sb.ready - sa.ready;
        if (sa.recentTimeoutPenalty !== sb.recentTimeoutPenalty)
          return sa.recentTimeoutPenalty - sb.recentTimeoutPenalty;
        if (sa.pushFailureScore !== sb.pushFailureScore)
          return sa.pushFailureScore - sb.pushFailureScore;
        if (sb.lastAckOkAt !== sa.lastAckOkAt) return sb.lastAckOkAt - sa.lastAckOkAt;
        if (sa.lastPushTimeoutAt !== sb.lastPushTimeoutAt)
          return sa.lastPushTimeoutAt - sb.lastPushTimeoutAt;
        if (sb.recentInbound !== sa.recentInbound) return sb.recentInbound - sa.recentInbound;
        if (sb.lastSeenAt !== sa.lastSeenAt) return sb.lastSeenAt - sa.lastSeenAt;
        return sb.connectedAt - sa.connectedAt;
      });

    const next = candidates[0] || null;
    if (!next) return null;

    const nextKey = this.connectionKey(acc, next.clientId);
    if (primaryKey !== nextKey) {
      this.activeConnectionByAccount.set(acc, nextKey);
      this.logInfo(
        'connection',
        `owner:promote ${JSON.stringify({
          bridge: this.bridgeId,
          accountId: acc,
          previousActiveKey: primaryKey || null,
          previousActiveConn: primary || null,
          nextActiveKey: nextKey,
          nextActiveConn: {
            connId: next.connId,
            clientId: next.clientId,
            connectedAt: next.connectedAt,
            lastSeenAt: next.lastSeenAt,
            outboundReadyUntil: (next as any).outboundReadyUntil || null,
            preferredForOutboundUntil: (next as any).preferredForOutboundUntil || null,
            inboundOnly: (next as any).inboundOnly === true,
          },
          reason: 'better-outbound-candidate',
        })}`,
        { debugOnly: true },
      );
    }

    return next;
  }

  private resolvePushConnIds(accountId: string): Set<string> {
    // Refactor boundary note (route selection):
    // This selector is not a pure lookup. It combines active-owner preference, outbound readiness,
    // preferred-for-outbound windows, recent inbound reachability, timeout penalties, and a final
    // fallback pass over live connections. If this logic is extracted later, first isolate the
    // candidate scoring / ordering into a pure function and keep the current fallback semantics intact.
    const acc = normalizeAccountId(accountId);
    const t = now();
    const connIds = new Set<string>();

    const isEligible = (
      conn: BncrConnection | null | undefined,
    ): conn is BncrConnection & {
      outboundReadyUntil?: number;
      preferredForOutboundUntil?: number;
      inboundOnly?: boolean;
    } => {
      if (!conn?.connId) return false;
      if (t - conn.lastSeenAt > CONNECT_TTL_MS) return false;
      if ((conn as any).inboundOnly === true) return false;
      return true;
    };

    const recentInboundConnIds = this.resolveRecentInboundConnIds(acc);
    const candidateScore = (conn: BncrConnection) => {
      const preferredForOutboundUntil = finiteNumberOr((conn as any).preferredForOutboundUntil, 0);
      const outboundReadyUntil = finiteNumberOr((conn as any).outboundReadyUntil, 0);
      const lastPushTimeoutAt = finiteNumberOr((conn as any).lastPushTimeoutAt, 0);
      const lastAckOkAt = finiteNumberOr((conn as any).lastAckOkAt, 0);
      const pushFailureScore = finiteNumberOr((conn as any).pushFailureScore, 0);
      const recentTimeoutPenalty = lastPushTimeoutAt > 0 && t - lastPushTimeoutAt <= 30_000 ? 1 : 0;
      return {
        preferred: preferredForOutboundUntil > t ? 1 : 0,
        ready: outboundReadyUntil > t ? 1 : 0,
        recentInbound: recentInboundConnIds.has(conn.connId) ? 1 : 0,
        recentTimeoutPenalty,
        pushFailureScore,
        lastAckOkAt,
        lastPushTimeoutAt,
        lastSeenAt: conn.lastSeenAt,
        connectedAt: conn.connectedAt,
      };
    };

    const primaryKey = this.activeConnectionByAccount.get(acc);
    if (primaryKey) {
      const primary = this.connections.get(primaryKey);
      if (isEligible(primary)) {
        connIds.add(primary.connId);
      }
    }

    const candidates = Array.from(this.connections.values())
      .filter((c): c is BncrConnection => c.accountId === acc)
      .filter((c) => isEligible(c))
      .sort((a, b) => {
        const sa = candidateScore(a);
        const sb = candidateScore(b);
        if (sb.preferred !== sa.preferred) return sb.preferred - sa.preferred;
        if (sb.ready !== sa.ready) return sb.ready - sa.ready;
        if (sa.recentTimeoutPenalty !== sb.recentTimeoutPenalty)
          return sa.recentTimeoutPenalty - sb.recentTimeoutPenalty;
        if (sa.pushFailureScore !== sb.pushFailureScore)
          return sa.pushFailureScore - sb.pushFailureScore;
        if (sb.lastAckOkAt !== sa.lastAckOkAt) return sb.lastAckOkAt - sa.lastAckOkAt;
        if (sa.lastPushTimeoutAt !== sb.lastPushTimeoutAt)
          return sa.lastPushTimeoutAt - sb.lastPushTimeoutAt;
        if (sb.recentInbound !== sa.recentInbound) return sb.recentInbound - sa.recentInbound;
        if (sb.lastSeenAt !== sa.lastSeenAt) return sb.lastSeenAt - sa.lastSeenAt;
        return sb.connectedAt - sa.connectedAt;
      });

    for (const c of candidates) {
      connIds.add(c.connId);
    }

    if (connIds.size > 0) return connIds;

    for (const c of this.connections.values()) {
      if (c.accountId !== acc) continue;
      if (!c.connId) continue;
      if (t - c.lastSeenAt > CONNECT_TTL_MS) continue;
      connIds.add(c.connId);
    }

    return connIds;
  }

  private hasRecentInboundReachability(accountId: string): boolean {
    const acc = normalizeAccountId(accountId);
    return hasRecentInboundReachabilityFromRuntime({
      now: now(),
      windowMs: RECENT_INBOUND_SEND_WINDOW_MS,
      lastInboundAt: this.lastInboundByAccount.get(acc) || 0,
      lastActivityAt: this.lastActivityByAccount.get(acc) || 0,
    });
  }

  private resolveRecentInboundConnIds(accountId: string): Set<string> {
    const acc = normalizeAccountId(accountId);
    return resolveRecentInboundConnIdsFromRuntime({
      accountId: acc,
      now: now(),
      connectTtlMs: CONNECT_TTL_MS,
      recentInboundReachable: this.hasRecentInboundReachability(acc),
      connections: this.connections.values(),
    });
  }

  private isRecentlyReachableConn(accountId: string, connId?: string, clientId?: string): boolean {
    const acc = normalizeAccountId(accountId);
    const activeKey = this.activeConnectionByAccount.get(acc);
    const active = activeKey ? this.connections.get(activeKey) || null : null;
    return isRecentlyReachableConnFromRuntime({
      accountId: acc,
      connId,
      clientId,
      recentConnIds: this.resolveRecentInboundConnIds(acc),
      activeConnection: active,
    });
  }

  private isRevalidatedAttemptedConn(entry: OutboxEntry, connId: string): boolean {
    const acc = normalizeAccountId(entry.accountId);
    const revalidated = getRevalidatedAttemptReason({
      entry,
      connId,
      accountId: acc,
      now: now(),
      connectTtlMs: CONNECT_TTL_MS,
      recentInboundReachable: this.hasRecentInboundReachability(acc),
      connections: this.connections.values(),
    });
    if (!revalidated) return false;

    this.logInfo(
      'outbox',
      `revalidated-retry ${JSON.stringify({
        messageId: entry.messageId,
        accountId: acc,
        connId: String(connId || '').trim(),
        ...revalidated,
      })}`,
      { debugOnly: true },
    );
    return true;
  }

  private tryAdoptTransferOwner(args: {
    accountId: string;
    transfer: FileSendTransferState | FileRecvTransferState | undefined;
    connId: string;
    clientId?: string;
  }): boolean {
    const { accountId, transfer, connId, clientId } = args;
    if (!transfer) return false;
    if (!this.hasRecentInboundReachability(accountId)) return false;
    if (!this.isRecentlyReachableConn(accountId, connId, clientId)) return false;

    transfer.ownerConnId = connId;
    transfer.ownerClientId = asString(clientId || '').trim() || undefined;
    return true;
  }

  private isRetryableFileTransferError(error: unknown): boolean {
    const msg = asString((error as any)?.message || error || '')
      .trim()
      .toLowerCase();
    if (!msg) return true;

    const retryableMarkers = [
      'gateway context unavailable',
      'no active bncr client for file chunk transfer',
      'chunk ack timeout',
      'complete ack timeout',
      'transfer state missing',
      'transfer aborted',
      'temporarily unavailable',
      'timeout',
      'econn',
      'socket',
      'network',
    ];

    return retryableMarkers.some((marker) => msg.includes(marker));
  }

  private async pushFileTransferSuccessPath(args: {
    entry: OutboxEntry;
    meta: Record<string, unknown>;
    owner: ReturnType<BncrBridgeRuntime['resolveOutboxPushOwner']>;
    connIds: Iterable<string>;
    recentInboundReachable: boolean;
    routeReason: string;
    mediaUrl: string;
  }): Promise<void> {
    const media = await this.transferMediaToBncrClient({
      accountId: args.entry.accountId,
      sessionKey: args.entry.sessionKey,
      route: args.entry.route,
      mediaUrl: args.mediaUrl,
      mediaLocalRoots: Array.isArray(args.meta.mediaLocalRoots)
        ? args.meta.mediaLocalRoots.filter((v): v is string => typeof v === 'string')
        : undefined,
    });
    const frame = this.buildFileTransferOutboundFrame({
      entry: args.entry,
      meta: args.meta,
      media,
      mediaUrl: args.mediaUrl,
    });

    this.gatewayContext!.broadcastToConnIds(
      BNCR_PUSH_EVENT,
      buildFileTransferBroadcastPayload({
        frame,
        messageId: args.entry.messageId,
      }),
      args.connIds,
    );
    this.logOutboxRouteSelect(
      buildFileTransferRouteSelectArgs({
        entry: args.entry,
        connIds: args.connIds,
        routeReason: args.routeReason,
        recentInboundReachable: args.recentInboundReachable,
        owner: args.owner,
        event: BNCR_PUSH_EVENT,
      }),
    );
    this.recordOutboxPushSuccess(
      buildFileTransferPushSuccessArgs({
        entry: args.entry,
        connIds: args.connIds,
        owner: args.owner,
      }),
    );
    this.logOutboxPushOkSummary(args.entry.messageId);
    this.logOutboxPushOk(
      buildFileTransferPushOkArgs({
        entry: args.entry,
        connIds: args.connIds,
        recentInboundReachable: args.recentInboundReachable,
        event: BNCR_PUSH_EVENT,
      }),
    );
  }

  private handleFileTransferPushFailure(args: { entry: OutboxEntry; error: unknown }) {
    this.recordOutboxPushFailure({
      entry: args.entry,
      error: args.error,
      fallbackError: 'file-transfer-error',
      persist: true,
    });
    const failure = resolveFileTransferFailureState({
      entry: args.entry,
      error: args.error,
      isRetryableFileTransferError: (value) => this.isRetryableFileTransferError(value),
    });
    this.logOutboxPushFailureSummary(args.entry.messageId, args.entry.lastError);
    this.logOutboxPushFailure(
      buildFileTransferPushFailureArgs({
        entry: args.entry,
        retryable: failure.retryable,
      }),
    );
    if (!failure.retryable) {
      this.moveToDeadLetter(args.entry, failure.deadLetterReason);
    }
  }

  private handleFileTransferPushGuardFailure(args: {
    entry: OutboxEntry;
    guard: Exclude<ReturnType<typeof resolveFileTransferGuard>, { ok: true }>;
  }) {
    this.recordOutboxPrePushFailure({
      entry: args.entry,
      lastError: args.guard.lastError,
      persist: true,
    });
    if (args.guard.reason === 'media-url-missing') {
      this.logOutboxPushFailure({
        messageId: args.entry.messageId,
        accountId: args.entry.accountId,
        retryCount: args.entry.retryCount,
        kind: 'file-transfer',
        lastError: args.entry.lastError,
      });
      return;
    }
    this.logOutboxPushSkip({
      messageId: args.entry.messageId,
      accountId: args.entry.accountId,
      kind: 'file-transfer',
      reason:
        args.guard.reason === 'no-gateway-context' ? 'no-gateway-context' : 'no-active-connection',
      recentInboundReachable:
        args.guard.reason === 'no-active-connection'
          ? args.guard.recentInboundReachable
          : undefined,
    });
  }

  private async tryPushFileTransferEntry(
    entry: OutboxEntry,
    meta: Record<string, unknown>,
  ): Promise<boolean> {
    const ctx = this.gatewayContext;
    const owner = this.resolveOutboxPushOwner(entry.accountId);
    const selection = prepareFileTransferRouteSelection({
      entry,
      owner,
      resolvePushConnIds: (accountId) => this.resolvePushConnIds(accountId),
      resolveRecentInboundConnIds: (accountId) => this.resolveRecentInboundConnIds(accountId),
      hasRecentInboundReachability: (accountId) => this.hasRecentInboundReachability(accountId),
      isRevalidatedAttemptedConn: (connId) => this.isRevalidatedAttemptedConn(entry, connId),
      selectOutboxFileTransferRouteCandidates,
    });
    const guard = resolveFileTransferGuard({
      gatewayContext: ctx,
      entry,
      owner,
      routeSelection: selection,
      mediaUrl: asString(meta.mediaUrl || '').trim(),
    });
    if (!guard.ok) {
      this.handleFileTransferPushGuardFailure({
        entry,
        guard,
      });
      return false;
    }

    const { connIds, recentInboundReachable, routeReason, mediaUrl } = guard;

    try {
      await this.pushFileTransferSuccessPath({
        entry,
        meta,
        owner,
        connIds,
        recentInboundReachable,
        routeReason,
        mediaUrl,
      });
      return true;
    } catch (error) {
      this.handleFileTransferPushFailure({
        entry,
        error,
      });
      return false;
    }
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
    kind?: 'tool' | 'block' | 'final';
    replyToId?: string;
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
      kind: params.kind,
      replyToId: asString(params.replyToId || '').trim() || undefined,
    });
  }

  private pruneMediaDedupeCache(sessionKey: string, currentTime = now()) {
    const sessionCache = this.recentMediaDedupeBySession.get(sessionKey);
    if (!sessionCache) return;

    for (const [mediaUrl, entry] of sessionCache.entries()) {
      if (currentTime - entry.createdAt > 10_000) {
        sessionCache.delete(mediaUrl);
      }
    }

    if (sessionCache.size === 0) {
      this.recentMediaDedupeBySession.delete(sessionKey);
    }
  }

  private rememberRecentMediaSend(params: {
    sessionKey: string;
    mediaUrl: string;
    text: string;
    replyToId: string;
    createdAt?: number;
  }) {
    const sessionKey = asString(params.sessionKey || '').trim();
    const mediaUrl = asString(params.mediaUrl || '').trim();
    if (!sessionKey || !mediaUrl) return;

    const createdAt = typeof params.createdAt === 'number' ? params.createdAt : now();
    this.pruneMediaDedupeCache(sessionKey, createdAt);
    let sessionCache = this.recentMediaDedupeBySession.get(sessionKey);
    if (!sessionCache) {
      sessionCache = new Map<string, MediaDedupeCacheEntry>();
      this.recentMediaDedupeBySession.set(sessionKey, sessionCache);
    }
    sessionCache.set(mediaUrl, {
      mediaUrl,
      text: normalizeMessageText(params.text),
      replyToId: normalizeReplyToId(params.replyToId),
      createdAt,
    });
  }

  private tryBuildMediaDedupeFallback(params: {
    sessionKey: string;
    mediaUrl: string;
    text: string;
    replyToId: string;
    currentTime?: number;
  }): { text: string; reason: 'same-text-sent-checkmark' | 'text-changed-downgrade' } | null {
    const sessionKey = asString(params.sessionKey || '').trim();
    const mediaUrl = asString(params.mediaUrl || '').trim();
    if (!sessionKey || !mediaUrl) return null;

    const currentTime = typeof params.currentTime === 'number' ? params.currentTime : now();
    this.pruneMediaDedupeCache(sessionKey, currentTime);
    const sessionCache = this.recentMediaDedupeBySession.get(sessionKey);
    const previous = sessionCache?.get(mediaUrl);
    if (!previous) return null;
    if (currentTime - previous.createdAt > 10_000) return null;

    return buildMediaTextFallback({
      currentText: normalizeMessageText(params.text),
      previousText: previous.text,
      currentReplyToId: normalizeReplyToId(params.replyToId),
      previousReplyToId: previous.replyToId,
    });
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
      media: params.media,
      mediaUrl: params.mediaUrl,
      mediaMsg: asString(params.meta.text || ''),
      fileName: resolveOutboundFileName({
        mediaUrl: params.mediaUrl,
        fileName: params.media.fileName,
        mimeType: params.media.mimeType,
      }),
      hintedType: wantsVoice ? 'voice' : undefined,
      kind: messageKind,
      replyToId: normalizeReplyToId(params.meta.replyToId) || undefined,
      now: now(),
    });
  }

  private buildTextOutboxEntry(params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    text: string;
    kind?: 'tool' | 'block' | 'final';
    replyToId?: string;
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
    this.gatewayContext!.broadcastToConnIds(
      BNCR_PUSH_EVENT,
      buildTextPushBroadcastPayload({
        payload: args.entry.payload,
        messageId: args.entry.messageId,
      }),
      args.connIds,
    );
    this.logOutboxRouteSelect(
      buildTextPushRouteSelectArgs({
        entry: args.entry,
        connIds: args.connIds,
        routeReason: args.routeReason,
        recentInboundReachable: args.recentInboundReachable,
        owner: args.owner,
        event: BNCR_PUSH_EVENT,
      }),
    );
    this.recordOutboxPushSuccess(
      buildTextPushSuccessArgs({
        entry: args.entry,
        connIds: args.connIds,
        ownerConnId: args.ownerConnId,
        ownerClientId: args.ownerConnId ? args.owner?.clientId : undefined,
      }),
    );
    this.logOutboxPushOkSummary(args.entry.messageId);
    this.logOutboxPushOk(
      buildTextPushOkArgs({
        entry: args.entry,
        connIds: args.connIds,
        recentInboundReachable: args.recentInboundReachable,
        event: BNCR_PUSH_EVENT,
      }),
    );
  }

  private handleTextPushFailure(args: { entry: OutboxEntry; error: unknown }) {
    this.recordOutboxPushFailure({
      entry: args.entry,
      error: args.error,
      fallbackError: 'push-error',
    });
    this.logOutboxPushFailureSummary(args.entry.messageId, args.entry.lastError);
    this.logOutboxPushFailure(buildTextPushFailureArgs({ entry: args.entry }));
  }

  private async tryPushTextEntry(entry: OutboxEntry): Promise<boolean> {
    const ctx = this.gatewayContext;
    const owner = this.resolveOutboxPushOwner(entry.accountId);
    const selection = prepareTextPushRouteSelection({
      entry,
      owner,
      resolvePushConnIds: (accountId) => this.resolvePushConnIds(accountId),
      resolveRecentInboundConnIds: (accountId) => this.resolveRecentInboundConnIds(accountId),
      hasRecentInboundReachability: (accountId) => this.hasRecentInboundReachability(accountId),
      isRevalidatedAttemptedConn: (connId) => this.isRevalidatedAttemptedConn(entry, connId),
      selectOutboxRouteCandidates,
    });
    const guard = resolveTextPushGuard({
      gatewayContext: ctx,
      entry,
      routeSelection: selection,
    });
    if (!guard.ok) {
      this.recordOutboxPrePushFailure({
        entry,
        lastError:
          guard.reason === 'no-gateway-context'
            ? 'gateway context unavailable'
            : 'no active bncr client',
        persist: true,
      });
      this.logOutboxPushSkip({
        messageId: entry.messageId,
        accountId: entry.accountId,
        reason: guard.reason,
        recentInboundReachable:
          guard.reason === 'no-active-connection' ? guard.recentInboundReachable : undefined,
        routeReason: selection.routeReason,
        connIds: selection.connIds,
        ownerConnId: selection.ownerConnId,
        ownerClientId: owner?.clientId,
      });
      return false;
    }

    const { connIds, recentInboundReachable, routeReason, ownerConnId } = guard;

    try {
      this.pushTextSuccessPath({
        entry,
        owner,
        connIds,
        recentInboundReachable,
        routeReason,
        ownerConnId,
      });
      return true;
    } catch (error) {
      this.handleTextPushFailure({
        entry,
        error,
      });
      return false;
    }
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
    this.recordPrePushGuardSkip({ accountId: args.accountId, reason: args.reason });
    this.logInfo(
      'outbox push skip',
      `mid=${args.messageId}|q=${this.outbox.size}|reason=${args.reason}${args.kind ? `|kind=${args.kind}` : ''}`,
    );
    this.logInfo(
      'outbox',
      `push-skip ${JSON.stringify(
        buildOutboxPushSkipDebugInfo({
          ...args,
          activeConnectionCount: this.activeConnectionCount(args.accountId),
          connections: this.connections.values(),
        }),
      )}`,
      { debugOnly: true },
    );
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
    this.logInfo(
      'outbox',
      `route-select ${JSON.stringify(buildOutboxRouteSelectDebugInfo(args))}`,
      { debugOnly: true },
    );
  }

  private logOutboxPushFailure(args: {
    messageId: string;
    accountId: string;
    retryCount: number;
    kind?: 'file-transfer';
    retryable?: boolean;
    lastError?: string;
  }) {
    this.logInfo('outbox', `push-fail ${JSON.stringify(buildPushFailureDebugInfo(args))}`, {
      debugOnly: true,
    });
  }

  private logOutboxPushOkSummary(messageId: string) {
    this.logInfo('outbox push', `mid=${messageId}|q=${this.outbox.size}`);
  }

  private logOutboxPushFailureSummary(messageId: string, lastError?: string) {
    this.logInfo('outbox push fail', `mid=${messageId}|q=${this.outbox.size}|err=${lastError}`);
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
    const parts = [`mid=${args.messageId}`, `q=${this.outbox.size}`];
    if (typeof args.queueMs === 'number') parts.push(`queueMs=${args.queueMs}`);
    if (typeof args.pushMs === 'number') parts.push(`pushMs=${args.pushMs}`);
    if (typeof args.waitMs === 'number') parts.push(`waitMs=${args.waitMs}`);
    if (args.err) parts.push(`err=${args.err}`);
    this.logInfo(scope, parts.join('|'));
  }

  private logOutboxAckWait(args: {
    entry: OutboxEntry;
    requireAck: boolean;
    ackResult: 'acked' | 'timeout';
    onlineNow: boolean;
    recentInboundReachable: boolean;
    ackTimeoutMs?: number | null;
  }) {
    this.logInfo(
      'outbox',
      `ack ${JSON.stringify(
        buildOutboxAckDebugInfo({
          messageId: args.entry.messageId,
          accountId: args.entry.accountId,
          sessionKey: args.entry.sessionKey,
          to: formatDisplayScope(args.entry.route),
          kind:
            isPlainObject(args.entry.payload?._meta) &&
            args.entry.payload?._meta?.kind === 'file-transfer'
              ? 'file-transfer'
              : undefined,
          requireAck: args.requireAck,
          ackResult: args.ackResult,
          ackStage: 'message',
          ackOutcome: args.ackResult,
          reason:
            args.ackResult === 'timeout'
              ? OUTBOUND_TERMINAL_REASON.PUSH_ACK_TIMEOUT
              : 'message-acked',
          ackTimeoutMs: typeof args.ackTimeoutMs === 'number' ? args.ackTimeoutMs : undefined,
          adaptiveAckTimeoutEnabled: ADAPTIVE_ACK_TIMEOUT_DEFAULT_ENABLED,
          onlineNow: args.onlineNow,
          recentInboundReachable: args.recentInboundReachable,
          connIds: args.entry.lastPushConnId ? [args.entry.lastPushConnId] : [],
          ownerConnId: args.entry.lastPushConnId,
          ownerClientId: args.entry.lastPushClientId,
          event: BNCR_PUSH_EVENT,
        }),
      )}`,
      { debugOnly: true },
    );
  }

  private logOutboxAckReroute(args: {
    accountId: string;
    entry: OutboxEntry;
    requireAck: boolean;
    currentConnId: string;
    availableConnIds: string[];
    decision: ReturnType<typeof computeRetryRerouteDecision>;
    localNextDelay: number | null;
    ackTimeoutMs?: number | null;
  }) {
    this.logOutboxAckSummary(args.requireAck ? 'outbox ack timeout' : 'outbox ack retry', {
      messageId: args.entry.messageId,
      connId: args.entry.lastPushConnId,
      clientId: args.entry.lastPushClientId,
      err: args.requireAck ? undefined : args.entry.lastError,
      waitMs: args.requireAck ? args.ackTimeoutMs : undefined,
    });
    this.logInfo(
      'outbox',
      `retry-reroute ${JSON.stringify(
        buildRetryRerouteDebugInfo({
          messageId: args.entry.messageId,
          accountId: args.accountId,
          currentConnId: args.currentConnId,
          decision: args.decision,
          availableConnIds: args.availableConnIds,
        }),
      )}`,
      { debugOnly: true },
    );

    this.logInfo(
      'outbox',
      `schedule ${JSON.stringify(
        buildOutboxScheduleDebugInfo({
          bridgeId: this.bridgeId,
          accountId: args.accountId,
          messageId: args.entry.messageId,
          source: OUTBOUND_SCHEDULE_SOURCE.RETRY_REROUTE_WAIT,
          wait: computeOutboxRetryWait(args.decision.nextAttemptAt, now()),
          localNextDelay: args.localNextDelay,
        }),
      )}`,
      { debugOnly: true },
    );
  }

  private respondAckResult(
    respond: GatewayRequestHandlerOptions['respond'],
    stale: boolean,
    result: { ok: true; movedToDeadLetter?: true; willRetry?: true },
  ) {
    respond(true, stale ? { ...result, stale: true, staleAccepted: true } : result);
  }

  private prepareAckHandling(args: {
    params: any;
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
    const { params, respond, client, context } = args;
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
    const messageId = asString(params?.messageId || '').trim();
    const staleObserved = this.observeLease('ack', params ?? {});

    this.logInfo(
      'outbox',
      `ack ${JSON.stringify({
        accountId,
        messageId,
        ok: params?.ok !== false,
        fatal: params?.fatal === true,
        error: asString(params?.error || ''),
        stale: staleObserved.stale,
      })}`,
      { debugOnly: true },
    );
    if (!messageId) {
      respond(false, { error: 'messageId required' });
      return null;
    }

    if (this.stopped) {
      respond(true, { ok: true, ignored: true, reason: 'service-stopped' });
      return null;
    }

    const entry = this.outbox.get(messageId);
    if (!entry) {
      respond(true, { ok: true, message: 'already-acked-or-missing', stale: staleObserved.stale });
      return null;
    }

    if (entry.accountId !== accountId) {
      respond(false, { error: 'account mismatch' });
      return null;
    }

    if (staleObserved.stale) {
      const sameConn = !!entry.lastPushConnId && entry.lastPushConnId === connId;
      const sameClient =
        !entry.lastPushConnId &&
        !!entry.lastPushClientId &&
        !!clientId &&
        entry.lastPushClientId === clientId;
      if (!(sameConn || sameClient)) {
        this.logWarn(
          'stale',
          `ignore kind=ack accountId=${accountId} connId=${connId} clientId=${clientId || '-'} messageId=${messageId} reason=owner-mismatch lastPushConnId=${entry.lastPushConnId || '-'} lastPushClientId=${entry.lastPushClientId || '-'}`,
          { debugOnly: true },
        );
        respond(true, { ok: true, stale: true, ignored: true });
        return null;
      }
    } else {
      this.rememberGatewayContext(context);
      this.markSeen(accountId, connId, clientId);
    }

    return {
      accountId,
      connId,
      clientId,
      messageId,
      entry,
      staleObserved,
    };
  }

  private handleAckOk(args: {
    accountId: string;
    messageId: string;
    connId: string;
    clientId?: string;
    stale: boolean;
    entry: OutboxEntry;
  }) {
    this.markOutboundCapability({
      accountId: args.accountId,
      connId: args.connId,
      clientId: args.clientId,
      outboundReady: true,
      preferredForOutbound: true,
    });
    const telemetryPatch = buildBncrAckOkTelemetryPatch({
      entry: args.entry,
      ackAt: now(),
      defaultAckTimeoutMs: PUSH_ACK_TIMEOUT_MS,
    });
    const { ackAt, ackQueueLatencyMs, ackPushLatencyMs, lateAccepted } = telemetryPatch;
    this.lastAckOkByAccount.set(args.accountId, ackAt);
    this.lastAckQueueLatencyMsByAccount.set(args.accountId, ackQueueLatencyMs);
    if (typeof ackPushLatencyMs === 'number') {
      this.lastAckPushLatencyMsByAccount.set(args.accountId, ackPushLatencyMs);
    }
    if (telemetryPatch.shouldResetAdaptiveAckRecovery) {
      this.adaptiveAckRecoveryOkCountByAccount.set(args.accountId, 0);
      this.lateAckOkCountByAccount.set(
        args.accountId,
        this.getCounter(this.lateAckOkCountByAccount, args.accountId) + 1,
      );
      this.lastLateAckOkByAccount.set(args.accountId, ackAt);
      this.lastLateAckQueueLatencyMsByAccount.set(args.accountId, ackQueueLatencyMs);
      if (typeof ackPushLatencyMs === 'number') {
        this.lastLateAckPushLatencyMsByAccount.set(args.accountId, ackPushLatencyMs);
      }
      args.entry.awaitingRetryPush = false;
      args.entry.lastError = undefined;
    } else if (telemetryPatch.shouldIncrementAdaptiveAckRecovery) {
      this.adaptiveAckRecoveryOkCountByAccount.set(
        args.accountId,
        this.getCounter(this.adaptiveAckRecoveryOkCountByAccount, args.accountId) + 1,
      );
    }
    this.outbox.delete(args.messageId);
    this.scheduleSave();
    this.resolveMessageAck(args.messageId, 'acked');
    this.logOutboxAckSummary(lateAccepted ? 'outbox ack ok late' : 'outbox ack ok', {
      messageId: args.messageId,
      connId: args.connId,
      clientId: args.clientId,
      queueMs: ackQueueLatencyMs,
      pushMs: ackPushLatencyMs,
      err: lateAccepted ? 'accepted-after-timeout' : undefined,
    });
  }

  private handleAckFatal(args: {
    entry: OutboxEntry;
    messageId: string;
    connId: string;
    clientId?: string;
    error: string;
  }) {
    this.moveToDeadLetter(args.entry, args.error);
    this.logOutboxAckSummary('outbox ack fatal', {
      messageId: args.messageId,
      connId: args.connId,
      clientId: args.clientId,
      err: args.error,
    });
  }

  private handleAckRetry(args: {
    entry: OutboxEntry;
    messageId: string;
    connId: string;
    clientId?: string;
    error: string;
  }) {
    const nextEntry = buildBncrAckRetryEntryPatch({
      entry: args.entry,
      error: args.error,
      nextAttemptAt: now() + 1_000,
    });
    this.outbox.set(args.messageId, nextEntry);
    this.scheduleSave();
    this.logOutboxAckSummary('outbox ack retry', {
      messageId: args.messageId,
      connId: args.connId,
      clientId: args.clientId,
      err: nextEntry.lastError,
    });
  }

  private handleAckOutcome(args: {
    params: any;
    respond: GatewayRequestHandlerOptions['respond'];
    accountId: string;
    connId: string;
    clientId?: string;
    messageId: string;
    entry: OutboxEntry;
    staleObserved: { stale: boolean };
  }) {
    const { params, respond, accountId, connId, clientId, messageId, entry, staleObserved } = args;
    const ok = params?.ok !== false;
    const fatal = params?.fatal === true;

    if (ok) {
      this.handleAckOk({
        accountId,
        messageId,
        connId,
        clientId,
        stale: staleObserved.stale,
        entry,
      });
      this.respondAckResult(respond, staleObserved.stale, { ok: true });
      this.flushPushQueueBestEffort({
        accountId,
        trigger: OUTBOUND_FLUSH_TRIGGER.ACK_OK,
        reason: OUTBOUND_FLUSH_REASON.MESSAGE_ACKED,
      });
      return;
    }

    if (fatal) {
      const error = asString(params?.error || 'fatal-ack');
      this.handleAckFatal({
        entry,
        messageId,
        connId,
        clientId,
        error,
      });
      this.respondAckResult(respond, staleObserved.stale, {
        ok: true,
        movedToDeadLetter: true,
      });
      return;
    }

    this.handleAckRetry({
      entry,
      messageId,
      connId,
      clientId,
      error: asString(params?.error || 'retryable-ack'),
    });

    this.respondAckResult(respond, staleObserved.stale, {
      ok: true,
      willRetry: true,
    });
  }

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
      }
    | {
        ok: false;
        status: boolean;
        payload: ReturnType<typeof buildInboundResponsePayload>;
      }
  > {
    const { parsed, canonicalAgentId } = args;
    const {
      accountId,
      platform,
      groupId,
      userId,
      sessionKeyfromroute,
      route,
      text,
      mediaBase64,
      mediaPathFromTransfer,
      msgId,
      peer,
      extracted,
      dedupKey,
    } = parsed;

    if (!platform || (!userId && !groupId)) {
      return {
        ok: false,
        status: false,
        payload: buildInboundResponsePayload({ kind: 'invalid-peer' }),
      };
    }
    if (this.markInboundDedupSeen(dedupKey)) {
      return {
        ok: false,
        status: true,
        payload: buildInboundResponsePayload({
          kind: 'duplicated',
          accountId,
          msgId: msgId ?? null,
        }),
      };
    }

    const cfg = getOpenClawRuntimeConfig(this.api);
    const gate = await checkBncrMessageGate({
      parsed,
      cfg,
      account: resolveAccount(cfg, accountId),
    });
    if (!gate.allowed) {
      return {
        ok: false,
        status: true,
        payload: buildInboundResponsePayload({
          kind: 'gate-denied',
          accountId,
          msgId: msgId ?? null,
          reason: gate.reason,
        }),
      };
    }

    const { sessionKey, inboundText } = resolveInboundSessionContext({
      cfg,
      accountId,
      peer,
      route,
      sessionKeyFromRoute: sessionKeyfromroute,
      canonicalAgentId,
      taskKey: extracted.taskKey,
      text,
      extractedText: extracted.text,
      resolveAgentRoute: (params) => resolveOpenClawAgentRoute(this.api, params),
    });

    return {
      ok: true,
      accountId,
      sessionKey,
      inboundText,
      hasMedia: Boolean(mediaBase64 || mediaPathFromTransfer),
    };
  }

  private refreshLiveConnectionState(args: {
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady: boolean;
    preferredForOutbound: boolean;
    inboundOnly: boolean;
    context: GatewayRequestHandlerOptions['context'];
  }) {
    const {
      accountId,
      connId,
      clientId,
      outboundReady,
      preferredForOutbound,
      inboundOnly,
      context,
    } = args;
    this.refreshAcceptedFileTransferLiveState({
      accountId,
      connId,
      clientId,
      context,
    });
    this.markOutboundCapability({
      accountId,
      connId,
      clientId,
      outboundReady,
      preferredForOutbound,
      inboundOnly,
    });
  }

  private refreshAcceptedFileTransferLiveState(args: {
    accountId: string;
    connId: string;
    clientId?: string;
    context: GatewayRequestHandlerOptions['context'];
  }) {
    const { accountId, connId, clientId, context } = args;
    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);
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
    this.logInfo('outbox', `push ${JSON.stringify(buildOutboxPushOkDebugInfo(args))}`, {
      debugOnly: true,
    });
  }

  private recordOutboxPrePushFailure(args: {
    entry: OutboxEntry;
    lastError: string;
    persist?: boolean;
  }) {
    const nextEntry = buildBncrOutboxFailureEntryPatch({
      entry: args.entry,
      lastError: args.lastError,
    });
    Object.assign(args.entry, nextEntry);
    this.outbox.set(nextEntry.messageId, args.entry);
    if (args.persist) this.scheduleSave();
  }

  private isPrePushGuardReason(reason: string) {
    return reason === 'no-gateway-context' || reason === 'no-active-connection';
  }

  private recordPrePushGuardSkip(args: { accountId: string; reason: string }) {
    if (!this.isPrePushGuardReason(args.reason)) return;
    const acc = normalizeAccountId(args.accountId);
    this.incrementCounter(this.prePushGuardSkipCountByAccount, acc);
    this.lastPrePushGuardSkipAtByAccount.set(acc, now());
    this.lastPrePushGuardSkipReasonByAccount.set(acc, args.reason);
  }

  private isPrePushGuardDeferral(entry: OutboxEntry) {
    return (
      entry.lastError === 'gateway context unavailable' ||
      entry.lastError === 'no active bncr client'
    );
  }

  private recordOutboxPushFailure(args: {
    entry: OutboxEntry;
    error: unknown;
    fallbackError: string;
    persist?: boolean;
  }) {
    const nextEntry = buildBncrOutboxFailureEntryPatch({
      entry: args.entry,
      lastError: asString((args.error as any)?.message || args.error || args.fallbackError),
    });
    Object.assign(args.entry, nextEntry);
    this.outbox.set(nextEntry.messageId, args.entry);
    if (args.persist) this.scheduleSave();
  }

  private recordOutboxPushSuccess(args: {
    entry: OutboxEntry;
    connIds: Iterable<string>;
    ownerConnId?: string;
    ownerClientId?: string;
    clearLastError?: boolean;
  }) {
    const pushedAt = now();
    const nextEntry = buildBncrOutboxPushSuccessEntryPatch({
      entry: args.entry,
      connIds: args.connIds,
      pushedAt,
      ownerConnId: args.ownerConnId,
      ownerClientId: args.ownerClientId,
      clearLastError: args.clearLastError,
    });
    Object.assign(args.entry, nextEntry);
    this.outbox.set(nextEntry.messageId, args.entry);
    this.lastOutboundByAccount.set(nextEntry.accountId, pushedAt);
    this.markActivity(nextEntry.accountId, pushedAt);
    this.scheduleSave();
  }

  private schedulePushDrain(delayMs = 0) {
    if (this.stopped) return;
    // Structure note (drain scheduler):
    // This is the single-timer gate for outbound retry scheduling. It intentionally coalesces
    // multiple nudges into one pending timer and delegates all actual decision-making to
    // flushPushQueue. If extracted later, preserve the current "one pending timer per bridge"
    // behavior so retry cadence and burst control do not change accidentally.
    if (this.pushTimer) return;
    const delay = clampOutboxDrainDelay(delayMs);
    this.logInfo(
      'outbox',
      `schedule ${JSON.stringify(
        buildOutboxScheduleDebugInfo({
          bridgeId: this.bridgeId,
          source: OUTBOUND_SCHEDULE_SOURCE.SCHEDULE_PUSH_DRAIN,
          wait: delay,
        }),
      )}`,
      { debugOnly: true },
    );
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      if (this.stopped) return;
      this.flushPushQueueBestEffort({
        trigger: OUTBOUND_FLUSH_TRIGGER.TIMER,
        reason: OUTBOUND_FLUSH_REASON.SCHEDULED_DRAIN,
      });
    }, delay);
  }

  private flushPushQueueBestEffort(args?: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }) {
    void this.flushPushQueue(args)
      .then(() => {
        this.pushDrainExceptionRetryCount = 0;
      })
      .catch((error) => {
        const accountId = args?.accountId ? normalizeAccountId(args.accountId) : '';
        const reason = asString(args?.reason || args?.trigger || 'flush-error');
        const err = asString((error as any)?.message || error || 'flush-error');
        const nextRetryCount = this.pushDrainExceptionRetryCount + 1;
        const willRetry = nextRetryCount <= PUSH_DRAIN_EXCEPTION_RETRY_LIMIT;
        this.pushDrainExceptionRetryCount = nextRetryCount;
        this.logError(
          'outbox drain fail',
          `accountId=${accountId || '-'}|reason=${reason}|err=${err}|retry=${willRetry ? nextRetryCount : 'false'}|limit=${PUSH_DRAIN_EXCEPTION_RETRY_LIMIT}`,
        );
        if (willRetry) {
          this.schedulePushDrain(PUSH_DRAIN_EXCEPTION_RETRY_DELAY_MS);
        }
      });
  }

  private isOutboundAckRequired(accountId?: string) {
    return resolveBncrOutboundAckRequired({ api: this.api, accountId });
  }

  private buildRuntimeFlags(accountId?: string) {
    return buildBncrRuntimeFlags({
      api: this.api,
      accountId,
      resolveMessageAckTimeoutMs: (acc?: string) => this.resolveMessageAckTimeoutMs(acc),
      adaptiveAckTimeoutEnabled: ADAPTIVE_ACK_TIMEOUT_DEFAULT_ENABLED,
      defaultMessageAckTimeoutMs: PUSH_ACK_TIMEOUT_MS,
      fileAckTimeoutMs: FILE_ACK_TIMEOUT_MS,
      debugVerbose: BNCR_DEBUG_VERBOSE,
    });
  }

  private getAccountPendingOutboxEntries(accountId: string) {
    const acc = normalizeAccountId(accountId);
    return Array.from(this.outbox.values()).filter((entry) => entry.accountId === acc);
  }

  private maybeLogOutboxDrainStuck(args: { accountId: string; trigger: string; reason: string }) {
    const acc = normalizeAccountId(args.accountId);
    const startedAt = this.pushDrainRunningSinceByAccount.get(acc) || 0;
    if (!startedAt) return;

    const t = now();
    const runningMs = Math.max(0, t - startedAt);
    if (runningMs < PUSH_DRAIN_STUCK_WARN_MS) return;

    const lastWarnedAt = this.pushDrainStuckWarnedAtByAccount.get(acc) || 0;
    if (lastWarnedAt && t - lastWarnedAt < PUSH_DRAIN_STUCK_WARN_MS) return;

    const pendingEntries = this.getAccountPendingOutboxEntries(acc);
    const pending = pendingEntries.length;
    if (!pending) return;

    this.pushDrainStuckWarnedAtByAccount.set(acc, t);
    this.logWarn(
      'outbox drain stuck',
      `accountId=${acc}|pending=${pending}|runningMs=${runningMs}|waiters=${this.messageAckWaiters.size}/${this.fileAckWaiters.size}`,
    );
    this.logInfo(
      'outbox',
      `drain-stuck ${JSON.stringify(
        buildOutboxDrainStuckDebugInfo({
          bridgeId: this.bridgeId,
          accountId: acc,
          reason: args.reason,
          trigger: args.trigger,
          outboxSize: this.outbox.size,
          pending,
          runningMs,
          runningSince: startedAt,
          hasGatewayContext: Boolean(this.gatewayContext),
          activeConnectionCount: this.activeConnectionCount(acc),
          messageAckWaiters: this.messageAckWaiters.size,
          fileAckWaiters: this.fileAckWaiters.size,
          pendingEntries,
          connections: this.connections.values(),
        }),
      )}`,
      { debugOnly: true },
    );
  }

  private async flushPushQueue(args?: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }): Promise<void> {
    if (this.stopped) return;
    // Structure guide for future safe extraction:
    // - pre-check: choose target accounts, skip accounts already draining, emit flush context logs
    // - tryPush: pick one due entry per account and attempt actual outbound delivery
    // - ack wait: wait for message ack when policy requires it, then decide whether queue can advance
    // - degrade: mark timed-out / unconfirmed outbound capability on the attempted owner connection
    // - reroute: avoid the timed-out route, optionally revalidate a previously-attempted conn, then retry once
    // - retry scheduling: keep the entry in outbox, compute backoff / nextAttemptAt, and schedule next drain
    // - dead letter: after max retries, move the entry out of the active outbox into deadLetter
    //
    // Wake-source note:
    // flushPushQueue is entered from several distinct wake sources with different meanings:
    // - enqueue/manual: a new outbound entry was added and may be due immediately
    // - timer/scheduled-drain: retry scheduling says a previously-deferred entry is now worth retrying
    // - connect/ws-online: a transport became available again
    // - ack-ok/message-acked: one completed message may let the queue advance to the next
    // - activity/activity-heartbeat: capability/liveness was refreshed
    // - inbound/inbound-accepted: inbound traffic provided a fresh reachability signal
    // Keep these wake reasons explicit in future refactors; they are observability and behavior boundaries,
    // not just log decoration.
    //
    // Refactor boundary note:
    // flushPushQueue is the core outbound state machine. It currently couples queue selection,
    // route choice, ack policy, degrade/failover, retry timing, and dead-letter transitions.
    // Future extraction should preserve these semantics first; do not split behavior and routing in
    // the same change unless tests already lock the full lifecycle.
    const filterAcc = args?.accountId ? normalizeAccountId(args.accountId) : null;
    const trigger = asString(args?.trigger || '').trim() || 'manual';
    const reason = asString(args?.reason || '').trim() || undefined;
    const targetAccounts = selectOutboxTargetAccounts({
      accountId: filterAcc,
      outboxEntries: this.outbox.values(),
      normalizeAccountId,
    });
    this.logInfo(
      'outbox',
      `flush ${JSON.stringify(
        buildFlushDebugInfo({
          bridgeId: this.bridgeId,
          accountId: filterAcc,
          targetAccounts,
          outboxSize: this.outbox.size,
          trigger,
          reason,
        }),
      )}`,
      { debugOnly: true },
    );

    let globalNextDelay: number | null = null;

    for (const acc of targetAccounts) {
      if (!acc) continue;
      if (this.pushDrainRunningAccounts.has(acc)) {
        this.logInfo(
          'outbox',
          `drain-skip ${JSON.stringify(
            buildOutboxDrainSkipDebugInfo({
              bridgeId: this.bridgeId,
              accountId: acc,
              reason: 'already-running',
              outboxSize: this.outbox.size,
              trigger,
            }),
          )}`,
          { debugOnly: true },
        );
        this.maybeLogOutboxDrainStuck({
          accountId: acc,
          trigger,
          reason: reason || 'already-running',
        });
        continue;
      }
      const online = this.isOnline(acc);
      const recentInboundReachable = this.hasRecentInboundReachability(acc);
      this.logInfo(
        'outbox',
        `online ${JSON.stringify(
          buildOutboxOnlineDebugInfo({
            bridgeId: this.bridgeId,
            accountId: acc,
            online,
            recentInboundReachable,
            connections: this.connections.values(),
          }),
        )}`,
        { debugOnly: true },
      );
      this.pushDrainRunningAccounts.add(acc);
      this.pushDrainRunningSinceByAccount.set(acc, now());
      this.pushDrainStuckWarnedAtByAccount.delete(acc);
      try {
        let localNextDelay: number | null = null;
        let processedThisRun = 0;
        const accountDrainStartedAt = now();

        while (true) {
          if (this.stopped) break;
          if (
            processedThisRun > 0 &&
            now() - accountDrainStartedAt >= PUSH_DRAIN_ACCOUNT_TIME_BUDGET_MS
          ) {
            localNextDelay = updateMinOutboxDelay(localNextDelay, 0);
            this.logInfo(
              'outbox',
              `schedule ${JSON.stringify(
                buildOutboxScheduleDebugInfo({
                  bridgeId: this.bridgeId,
                  accountId: acc,
                  source: OUTBOUND_SCHEDULE_SOURCE.ACCOUNT_TIME_BUDGET_YIELD,
                  wait: 0,
                  localNextDelay,
                }),
              )}`,
              { debugOnly: true },
            );
            break;
          }
          if (processedThisRun >= PUSH_DRAIN_ACCOUNT_BUDGET) {
            localNextDelay = updateMinOutboxDelay(localNextDelay, 0);
            this.logInfo(
              'outbox',
              `schedule ${JSON.stringify(
                buildOutboxScheduleDebugInfo({
                  bridgeId: this.bridgeId,
                  accountId: acc,
                  source: OUTBOUND_SCHEDULE_SOURCE.ACCOUNT_BUDGET_YIELD,
                  wait: 0,
                  localNextDelay,
                }),
              )}`,
              { debugOnly: true },
            );
            break;
          }
          const t = now();
          const entries = listAccountOutboxEntries({
            accountId: acc,
            outboxEntries: this.outbox.values(),
            normalizeAccountId,
          });

          if (!entries.length) break;

          const entry = findDueOutboxEntry(entries, t);
          if (!entry) {
            const wait = computeNextOutboxDelay(entries, t);
            if (wait != null) {
              localNextDelay = updateMinOutboxDelay(localNextDelay, wait);
              this.logInfo(
                'outbox',
                `schedule ${JSON.stringify(
                  buildOutboxScheduleDebugInfo({
                    bridgeId: this.bridgeId,
                    accountId: acc,
                    source: OUTBOUND_SCHEDULE_SOURCE.ACCOUNT_NO_DUE_ENTRY,
                    wait,
                    localNextDelay,
                  }),
                )}`,
                { debugOnly: true },
              );
            }
            break;
          }

          const onlineNow = this.isOnline(acc);
          const recentInboundReachable = this.hasRecentInboundReachability(acc);
          let pushed = false;
          try {
            pushed = await this.tryPushEntry(entry);
          } catch (error) {
            const meta = isPlainObject(entry.payload?._meta) ? entry.payload._meta : null;
            if (meta?.kind === 'file-transfer') {
              this.handleFileTransferPushFailure({
                entry,
                error,
              });
            } else {
              this.handleTextPushFailure({
                entry,
                error,
              });
            }
            pushed = false;
          }
          processedThisRun += 1;
          if (pushed) {
            const requireAck = this.isOutboundAckRequired(acc);
            const ackTimeoutMs = requireAck ? this.resolveMessageAckTimeoutMs(acc) : null;
            let ackResult: 'acked' | 'timeout' = requireAck ? 'timeout' : 'acked';
            if (onlineNow && requireAck) {
              this.logInfo(
                'outbox',
                `ack wait-start ${JSON.stringify(
                  buildOutboxAckDebugInfo({
                    messageId: entry.messageId,
                    accountId: entry.accountId,
                    sessionKey: entry.sessionKey,
                    to: formatDisplayScope(entry.route),
                    kind:
                      isPlainObject(entry.payload?._meta) &&
                      entry.payload?._meta?.kind === 'file-transfer'
                        ? 'file-transfer'
                        : undefined,
                    requireAck,
                    ackResult: 'timeout',
                    ackStage: 'message',
                    ackOutcome: 'waiting',
                    ackTimeoutMs: ackTimeoutMs || PUSH_ACK_TIMEOUT_MS,
                    adaptiveAckTimeoutEnabled: ADAPTIVE_ACK_TIMEOUT_DEFAULT_ENABLED,
                    onlineNow,
                    recentInboundReachable,
                    connIds: entry.lastPushConnId ? [entry.lastPushConnId] : [],
                    ownerConnId: entry.lastPushConnId,
                    ownerClientId: entry.lastPushClientId,
                    event: BNCR_PUSH_EVENT,
                  }),
                )}`,
                { debugOnly: true },
              );
              ackResult = await this.waitForMessageAck(
                entry.messageId,
                ackTimeoutMs || PUSH_ACK_TIMEOUT_MS,
              );
            }

            this.logOutboxAckWait({
              entry,
              requireAck,
              ackResult,
              onlineNow,
              recentInboundReachable,
              ackTimeoutMs,
            });

            if (!this.outbox.has(entry.messageId)) {
              await this.sleepMs(PUSH_DRAIN_INTERVAL_MS);
              continue;
            }

            if (onlineNow && (!requireAck || ackResult !== 'timeout')) {
              await this.sleepMs(PUSH_DRAIN_INTERVAL_MS);
              continue;
            }

            if (entry.lastPushConnId || entry.lastPushClientId) {
              this.degradeOutboundCapability({
                accountId: acc,
                connId: entry.lastPushConnId || undefined,
                clientId: entry.lastPushClientId || undefined,
                reason: requireAck
                  ? OUTBOUND_DEGRADE_REASON.ACK_TIMEOUT
                  : OUTBOUND_DEGRADE_REASON.PUSH_UNCONFIRMED,
              });
            }

            const attemptedConnIds = Array.isArray(entry.routeAttemptConnIds)
              ? entry.routeAttemptConnIds.filter((v): v is string => typeof v === 'string' && !!v)
              : [];
            const currentConnId = asString(entry.lastPushConnId || '').trim();
            const availableConnIds = Array.from(this.resolvePushConnIds(acc));
            const decision = computeRetryRerouteDecision(
              {
                nowMs: now(),
                maxRetry: MAX_RETRY,
                requireAck,
                currentRetryCount: entry.retryCount,
                currentRouteAttemptRound: Number(entry.routeAttemptRound || 0),
                currentFastReroutePending: entry.fastReroutePending === true,
                lastError: entry.lastError,
                currentConnId: currentConnId || undefined,
                attemptedConnIds,
                availableConnIds,
              },
              { backoffMs },
            );

            if (decision.kind === 'dead-letter') {
              this.logInfo(
                'outbox ack fatal',
                `mid=${entry.messageId}|q=${this.outbox.size}|err=${decision.terminalReason}`,
              );
              this.moveToDeadLetter(entry, decision.terminalReason);
              continue;
            }

            const nextEntry = applyBncrRetryRerouteDecisionToEntry(entry, decision);
            this.outbox.set(entry.messageId, nextEntry);
            this.scheduleSave();
            if (requireAck) {
              this.lastAckTimeoutByAccount.set(acc, now());
              this.ackTimeoutCountByAccount.set(
                acc,
                this.getCounter(this.ackTimeoutCountByAccount, acc) + 1,
              );
              this.adaptiveAckRecoveryOkCountByAccount.set(acc, 0);
            }
            const wait = computeOutboxRetryWait(decision.nextAttemptAt, now());
            localNextDelay = updateMinOutboxDelay(localNextDelay, wait);
            this.logOutboxAckReroute({
              accountId: acc,
              entry: nextEntry,
              requireAck,
              currentConnId,
              availableConnIds,
              decision,
              localNextDelay,
              ackTimeoutMs,
            });
            await this.sleepMs(PUSH_DRAIN_INTERVAL_MS);
            break;
          }

          if (!this.outbox.has(entry.messageId)) {
            await this.sleepMs(PUSH_DRAIN_INTERVAL_MS);
            continue;
          }

          if (this.isPrePushGuardDeferral(entry)) {
            const wait = PRE_PUSH_GUARD_RETRY_DELAY_MS;
            localNextDelay = updateMinOutboxDelay(localNextDelay, wait);
            this.logInfo(
              'outbox',
              `schedule ${JSON.stringify(
                buildOutboxScheduleDebugInfo({
                  bridgeId: this.bridgeId,
                  accountId: acc,
                  messageId: entry.messageId,
                  source: OUTBOUND_SCHEDULE_SOURCE.PRE_PUSH_GUARD_WAIT,
                  wait,
                  localNextDelay,
                }),
              )}`,
              { debugOnly: true },
            );
            break;
          }

          const decision = computePushFailureDecision(
            {
              nowMs: t,
              maxRetry: MAX_RETRY,
              currentRetryCount: entry.retryCount,
              lastError: entry.lastError,
            },
            { backoffMs },
          );
          if (decision.kind === 'dead-letter') {
            this.moveToDeadLetter(entry, decision.terminalReason);
            continue;
          }

          const nextEntry = applyBncrPushFailureDecisionToEntry(entry, decision);
          this.outbox.set(entry.messageId, nextEntry);
          this.scheduleSave();

          const wait = computeOutboxRetryWait(decision.nextAttemptAt, t);
          localNextDelay = updateMinOutboxDelay(localNextDelay, wait);
          this.logInfo(
            'outbox',
            `schedule ${JSON.stringify(
              buildOutboxScheduleDebugInfo({
                bridgeId: this.bridgeId,
                accountId: acc,
                messageId: entry.messageId,
                source: OUTBOUND_SCHEDULE_SOURCE.PUSH_FAIL_WAIT,
                wait,
                localNextDelay,
              }),
            )}`,
            { debugOnly: true },
          );
          break;
        }

        if (localNextDelay != null) {
          globalNextDelay = updateMinOutboxDelay(globalNextDelay, localNextDelay);
          this.logInfo(
            'outbox',
            `schedule ${JSON.stringify(
              buildOutboxScheduleDebugInfo({
                bridgeId: this.bridgeId,
                accountId: acc,
                source: OUTBOUND_SCHEDULE_SOURCE.ACCOUNT_NEXT_DELAY_MERGE,
                localNextDelay,
                globalNextDelay,
              }),
            )}`,
            { debugOnly: true },
          );
        }
      } finally {
        this.pushDrainRunningAccounts.delete(acc);
        this.pushDrainRunningSinceByAccount.delete(acc);
        this.pushDrainStuckWarnedAtByAccount.delete(acc);
      }
    }

    if (globalNextDelay != null) {
      this.logInfo(
        'outbox',
        `schedule ${JSON.stringify(
          buildOutboxScheduleDebugInfo({
            bridgeId: this.bridgeId,
            source: OUTBOUND_SCHEDULE_SOURCE.FLUSH_NEXT_DRAIN,
            globalNextDelay,
            wait: globalNextDelay,
          }),
        )}`,
        { debugOnly: true },
      );
      this.schedulePushDrain(globalNextDelay);
    }
  }

  private async waitForMessageAck(messageId: string, waitMs: number): Promise<'acked' | 'timeout'> {
    const key = asString(messageId).trim();
    const timeoutMs = clampFiniteNumber(waitMs, 0, 0, RECOMMENDED_ACK_TIMEOUT_MAX_MS);
    if (!key || !timeoutMs) return 'timeout';

    const existing = this.messageAckWaiters.get(key);
    if (existing) {
      this.logWarn(
        'outbox',
        `message-ack-waiter-reuse ${JSON.stringify({ bridge: this.bridgeId, messageId: key })}`,
        { debugOnly: true },
      );
      return await existing.promise;
    }

    let timer: NodeJS.Timeout;
    let resolveWaiter!: (result: 'acked' | 'timeout') => void;
    const promise = new Promise<'acked' | 'timeout'>((resolve) => {
      resolveWaiter = resolve;
      timer = setTimeout(() => {
        this.messageAckWaiters.delete(key);
        resolve('timeout');
      }, timeoutMs);
    });

    this.messageAckWaiters.set(key, { promise, resolve: resolveWaiter, timer: timer! });
    return await promise;
  }

  private connectionKey(accountId: string, clientId?: string): string {
    const acc = normalizeAccountId(accountId);
    const cid = asString(clientId || '').trim();
    return `${acc}::${cid || 'default'}`;
  }

  private gcTransientState() {
    const t = now();

    // 清理过期连接
    const staleBefore = t - CONNECT_TTL_MS * 2;
    for (const [key, c] of this.connections.entries()) {
      if (c.lastSeenAt < staleBefore) {
        this.logInfo(
          'connection',
          `gc ${JSON.stringify({
            bridge: this.bridgeId,
            key,
            accountId: c.accountId,
            connId: c.connId,
            clientId: c.clientId,
            lastSeenAt: c.lastSeenAt,
            staleBefore,
          })}`,
          { debugOnly: true },
        );
        this.connections.delete(key);
        if (this.activeConnectionByAccount.get(c.accountId) === key) {
          this.activeConnectionByAccount.delete(c.accountId);
        }
      }
    }

    // 清理去重窗口（90s）
    const dedupWindowMs = 90_000;
    for (const [key, ts] of this.recentInbound.entries()) {
      if (t - ts > dedupWindowMs) this.recentInbound.delete(key);
    }

    this.cleanupFileTransfers();
  }

  private cleanupFileTransfers() {
    const t = now();
    const keepMsForTransfer = (st: { status: string; startedAt: number; terminalAt?: number }) => {
      const startedAt = finiteNumberOr(st.startedAt, t);
      if (st.status === 'completed' || st.status === 'aborted') {
        return {
          since: finiteNumberOr(st.terminalAt, startedAt),
          keepMs: FILE_TRANSFER_TERMINAL_KEEP_MS,
        };
      }
      return { since: startedAt, keepMs: FILE_TRANSFER_KEEP_MS };
    };
    for (const [id, st] of this.fileSendTransfers.entries()) {
      const keep = keepMsForTransfer(st);
      if (t - keep.since > keep.keepMs) this.fileSendTransfers.delete(id);
    }
    for (const [id, st] of this.fileRecvTransfers.entries()) {
      const keep = keepMsForTransfer(st);
      if (t - keep.since > keep.keepMs) this.fileRecvTransfers.delete(id);
    }
    for (const [key, ack] of this.earlyFileAcks.entries()) {
      if (t - ack.at > FILE_TRANSFER_ACK_TTL_MS) this.earlyFileAcks.delete(key);
    }
  }

  private markSeen(accountId: string, connId: string, clientId?: string) {
    this.gcTransientState();

    const acc = normalizeAccountId(accountId);
    const key = this.connectionKey(acc, clientId);
    const t = now();
    const prev = this.connections.get(key);
    const previousActiveKey = this.activeConnectionByAccount.get(acc) || null;
    const previousActiveConn = previousActiveKey
      ? this.connections.get(previousActiveKey) || null
      : null;

    const nextConn = {
      accountId: acc,
      connId,
      clientId: asString(clientId || '').trim() || undefined,
      connectedAt: prev?.connectedAt || t,
      lastSeenAt: t,
      outboundReadyUntil: (prev as any)?.outboundReadyUntil,
      preferredForOutboundUntil: (prev as any)?.preferredForOutboundUntil,
      inboundOnly: (prev as any)?.inboundOnly,
    } as BncrConnection & {
      outboundReadyUntil?: number;
      preferredForOutboundUntil?: number;
      inboundOnly?: boolean;
    };

    this.connections.set(key, nextConn as BncrConnection);
    const connectionSeenPayload = {
      bridge: this.bridgeId,
      accountId: acc,
      connId,
      clientId: nextConn.clientId,
      connectedAt: nextConn.connectedAt,
      lastSeenAt: nextConn.lastSeenAt,
      outboundReadyUntil: nextConn.outboundReadyUntil || null,
      preferredForOutboundUntil: nextConn.preferredForOutboundUntil || null,
      inboundOnly: nextConn.inboundOnly === true,
    };
    const connectionSeenSig = JSON.stringify({
      bridge: this.bridgeId,
      accountId: acc,
      connId,
      clientId: nextConn.clientId || null,
      inboundOnly: nextConn.inboundOnly === true,
      outboundReadyActive: Number(nextConn.outboundReadyUntil || 0) > t,
      preferredForOutboundActive: Number(nextConn.preferredForOutboundUntil || 0) > t,
    });
    this.logInfoDedupJson('connection', 'seen', connectionSeenPayload, {
      key: `connection-seen:${acc}:${nextConn.clientId || connId}`,
      sig: connectionSeenSig,
      debugOnly: true,
    });

    const current = this.activeConnectionByAccount.get(acc);
    if (!current) {
      this.activeConnectionByAccount.set(acc, key);
      this.logInfo(
        'connection',
        `seen:promote ${JSON.stringify({
          bridge: this.bridgeId,
          accountId: acc,
          reason: 'no-current-active',
          previousActiveKey,
          previousActiveConn,
          nextActiveKey: key,
          nextActiveConn: nextConn,
          activeConnections: Array.from(this.connections.values())
            .filter((c) => c.accountId === acc)
            .map((c) => ({
              connId: c.connId,
              clientId: c.clientId,
              connectedAt: c.connectedAt,
              lastSeenAt: c.lastSeenAt,
              outboundReadyUntil: (c as any).outboundReadyUntil || null,
              preferredForOutboundUntil: (c as any).preferredForOutboundUntil || null,
              inboundOnly: (c as any).inboundOnly === true,
            })),
        })}`,
        { debugOnly: true },
      );
      return;
    }

    const curConn = this.connections.get(current);
    if (!curConn || t - curConn.lastSeenAt > CONNECT_TTL_MS) {
      this.activeConnectionByAccount.set(acc, key);
      this.logInfo(
        'connection',
        `seen:promote ${JSON.stringify({
          bridge: this.bridgeId,
          accountId: acc,
          reason: !curConn ? 'current-missing' : 'current-stale',
          previousActiveKey,
          previousActiveConn,
          nextActiveKey: key,
          nextActiveConn: nextConn,
          activeConnections: Array.from(this.connections.values())
            .filter((c) => c.accountId === acc)
            .map((c) => ({
              connId: c.connId,
              clientId: c.clientId,
              connectedAt: c.connectedAt,
              lastSeenAt: c.lastSeenAt,
              outboundReadyUntil: (c as any).outboundReadyUntil || null,
              preferredForOutboundUntil: (c as any).preferredForOutboundUntil || null,
              inboundOnly: (c as any).inboundOnly === true,
            })),
        })}`,
        { debugOnly: true },
      );
    }
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
    const acc = normalizeAccountId(args.accountId);
    const key = this.connectionKey(acc, args.clientId);
    const t = Number(args.at || now());
    const current = this.connections.get(key) as BncrConnection | undefined;
    if (!current || current.connId !== args.connId) return;

    const next = applyOutboundCapability({
      connection: current,
      at: t,
      outboundReadyTtlMs: OUTBOUND_READY_TTL_MS,
      preferredOutboundTtlMs: PREFERRED_OUTBOUND_TTL_MS,
      outboundReady: args.outboundReady,
      preferredForOutbound: args.preferredForOutbound,
      inboundOnly: args.inboundOnly,
    });

    this.connections.set(key, next as BncrConnection);
    const snapshot = buildCapabilitySnapshot(next);
    const connectionCapabilityPayload = {
      bridge: this.bridgeId,
      accountId: acc,
      connId: next.connId,
      clientId: next.clientId,
      outboundReady: args.outboundReady === true,
      preferredForOutbound: args.preferredForOutbound === true,
      inboundOnly: snapshot.inboundOnly,
      outboundReadyUntil: snapshot.outboundReadyUntil,
      preferredForOutboundUntil: snapshot.preferredForOutboundUntil,
    };
    const connectionCapabilitySig = JSON.stringify({
      bridge: this.bridgeId,
      accountId: acc,
      connId: next.connId,
      clientId: next.clientId || null,
      outboundReady: args.outboundReady === true,
      preferredForOutbound: args.preferredForOutbound === true,
      inboundOnly: snapshot.inboundOnly,
      outboundReadyActive: Number(snapshot.outboundReadyUntil || 0) > t,
      preferredForOutboundActive: Number(snapshot.preferredForOutboundUntil || 0) > t,
    });
    this.logInfoDedupJson('connection', 'capability', connectionCapabilityPayload, {
      key: `connection-capability:${acc}:${next.clientId || next.connId}`,
      sig: connectionCapabilitySig,
      debugOnly: true,
    });
  }

  private hasAlternativeLiveConnection(
    accountId: string,
    currentConnId?: string,
    currentClientId?: string,
  ): boolean {
    const acc = normalizeAccountId(accountId);
    return hasAlternativeLiveConnectionFromRuntime({
      accountId: acc,
      now: now(),
      connectTtlMs: CONNECT_TTL_MS,
      currentConnId,
      currentClientId,
      connections: this.connections.values(),
    });
  }

  private degradeOutboundCapability(args: {
    accountId: string;
    connId?: string;
    clientId?: string;
    reason: string;
    at?: number;
  }) {
    const acc = normalizeAccountId(args.accountId);
    const t = Number(args.at || now());
    const hasAlternativeLiveConnection = this.hasAlternativeLiveConnection(
      acc,
      args.connId,
      args.clientId,
    );
    const currentKey = this.activeConnectionByAccount.get(acc) || null;
    const matched = findCapabilityConnection({
      accountId: acc,
      connId: args.connId,
      clientId: args.clientId,
      connections: this.connections.entries(),
    });

    if (!matched) return;

    const before = buildCapabilitySnapshot(matched.connection);

    if (!hasAlternativeLiveConnection) {
      this.logInfo(
        'connection',
        `outbound-degrade skip ${JSON.stringify({
          bridge: this.bridgeId,
          accountId: acc,
          connId: matched.connection.connId,
          clientId: matched.connection.clientId,
          reason: args.reason,
          at: t,
          currentActiveKey: currentKey,
          degradedKey: matched.key,
          skipReason: 'no-alternative-live-connection',
          before,
        })}`,
        { debugOnly: true },
      );
      return;
    }

    const next = clearOutboundCapability(matched.connection);
    this.connections.set(matched.key, next as BncrConnection);

    this.logInfo(
      'connection',
      `outbound-degrade ${JSON.stringify({
        bridge: this.bridgeId,
        accountId: acc,
        connId: next.connId,
        clientId: next.clientId,
        reason: args.reason,
        at: t,
        currentActiveKey: currentKey,
        degradedKey: matched.key,
        before,
        after: buildCapabilitySnapshot(next),
      })}`,
      { debugOnly: true },
    );
  }

  private isOnline(accountId: string): boolean {
    const acc = normalizeAccountId(accountId);
    const t = now();
    for (const c of this.connections.values()) {
      if (c.accountId !== acc) continue;
      if (t - c.lastSeenAt <= CONNECT_TTL_MS) return true;
    }
    return false;
  }

  private activeConnectionCount(accountId: string): number {
    const acc = normalizeAccountId(accountId);
    const t = now();
    let n = 0;
    for (const c of this.connections.values()) {
      if (c.accountId !== acc) continue;
      if (t - c.lastSeenAt <= CONNECT_TTL_MS) n += 1;
    }
    return n;
  }

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

  private rememberSessionRoute(sessionKey: string, accountId: string, route: BncrRoute) {
    const key = asString(sessionKey).trim();
    if (!key) return;

    const acc = normalizeAccountId(accountId);
    const t = now();
    const info = { accountId: acc, route, updatedAt: t };

    this.sessionRoutes.set(key, info);
    this.routeAliases.set(routeKey(acc, route), info);
    this.lastSessionByAccount.set(acc, {
      sessionKey: key,
      // 状态展示统一为 Bncr-platform:group:user
      scope: formatDisplayScope(route),
      updatedAt: t,
    });
    this.markActivity(acc, t);
    this.scheduleSave();
  }

  private resolveRouteBySession(sessionKey: string, accountId: string): BncrRoute | null {
    const key = asString(sessionKey).trim();
    const hit = this.sessionRoutes.get(key);
    if (hit && normalizeAccountId(accountId) === normalizeAccountId(hit.accountId)) {
      return hit.route;
    }

    const parsed = parseStrictBncrSessionKey(key);
    if (!parsed) return null;

    const alias = this.routeAliases.get(routeKey(normalizeAccountId(accountId), parsed.route));
    return alias?.route || parsed.route;
  }

  // 严谨目标解析：
  // 1) 标准 to 仅认 Bncr:<platform>:<groupId>:<userId> / Bncr:<platform>:<userId>
  // 2) 仍接受 strict sessionKey 作为内部兼容输入
  // 3) 其他旧格式直接失败，并输出标准格式提示日志
  private resolveVerifiedTarget(
    rawTarget: string,
    accountId: string,
  ): { sessionKey: string; route: BncrRoute; displayScope: string } {
    const acc = normalizeAccountId(accountId);
    const raw = asString(rawTarget).trim();
    if (!raw) throw new Error('bncr invalid target(empty)');

    this.logInfo('target', `incoming raw=${raw} accountId=${acc}`, { debugOnly: true });

    let route: BncrRoute | null = null;

    const strict = parseStrictBncrSessionKey(raw);
    if (strict) {
      route = strict.route;
    } else {
      route = parseRouteFromDisplayScope(raw) || this.resolveRouteBySession(raw, acc);
    }

    if (!route) {
      this.logWarn(
        'target',
        `invalid raw=${raw} accountId=${acc} reason=unparseable-or-unknown standardTo=Bncr:<platform>:<groupId>:<userId>|Bncr:<platform>:<userId> standardSessionKey=agent:<agentId>:bncr:direct:<hex(scope)>`,
        { debugOnly: true },
      );
      throw new Error(
        `bncr invalid target(standard: Bncr:<platform>:<groupId>:<userId> | Bncr:<platform>:<userId>): ${raw}`,
      );
    }

    const canonicalAgentId =
      this.canonicalAgentId ||
      this.ensureCanonicalAgentId({
        cfg: getOpenClawRuntimeConfigOrDefault(this.api, {}),
        accountId: acc,
        channelId: CHANNEL_ID,
        peer: { kind: 'direct', id: route.groupId === '0' ? route.userId : route.groupId },
      });
    const verified = {
      sessionKey: buildCanonicalBncrSessionKey(route, canonicalAgentId),
      route,
      displayScope: formatDisplayScope(route),
    };

    this.logInfo(
      'target',
      `canonical raw=${raw} accountId=${acc} verified=${JSON.stringify(verified)}`,
      { debugOnly: true },
    );

    // 发送链路命中目标时，同步刷新 lastSession，避免状态页显示过期会话。
    this.lastSessionByAccount.set(acc, {
      sessionKey: verified.sessionKey,
      scope: verified.displayScope,
      updatedAt: now(),
    });
    this.scheduleSave();

    return verified;
  }

  private markActivity(accountId: string, at = now()) {
    this.lastActivityByAccount.set(normalizeAccountId(accountId), at);
  }

  private fileAckKey(transferId: string, stage: string, chunkIndex?: number): string {
    return buildFileAckKey({ transferId, stage, chunkIndex });
  }

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
    const transferId = asString(params.transferId).trim();
    const stage = asString(params.stage).trim();
    const key = this.fileAckKey(transferId, stage, params.chunkIndex);
    const timeoutMs = clampFiniteNumber(params.timeoutMs, FILE_ACK_TIMEOUT_MS, 1_000, 120_000);
    const ownerInfo = this.fileAckOwnerInfo(transferId);

    const cached = this.earlyFileAcks.get(key);
    if (cached) {
      this.earlyFileAcks.delete(key);
      this.logInfo(
        'file-ack-cache-hit',
        JSON.stringify({
          bridge: this.bridgeId,
          transferId,
          stage,
          ackStage: stage,
          ackOutcome: cached.ok ? 'acked' : 'failed',
          waiterReused: false,
          chunkIndex: Number.isFinite(Number(params.chunkIndex))
            ? Number(params.chunkIndex)
            : undefined,
          key,
          ...ownerInfo,
          ok: cached.ok,
          payload: cached.payload,
        }),
        { debugOnly: true },
      );
      if (cached.ok) return Promise.resolve(cached.payload);
      return Promise.reject(
        new Error(
          asString(cached.payload?.errorMessage || cached.payload?.error || 'file ack failed'),
        ),
      );
    }

    const existing = this.fileAckWaiters.get(key);
    if (existing) {
      this.logWarn(
        'file-ack-waiter-reuse',
        JSON.stringify({
          bridge: this.bridgeId,
          transferId,
          stage,
          ackStage: stage,
          ackOutcome: 'waiter-reused',
          waiterReused: true,
          chunkIndex: Number.isFinite(Number(params.chunkIndex))
            ? Number(params.chunkIndex)
            : undefined,
          key,
          ...ownerInfo,
        }),
        { debugOnly: true },
      );
      return existing.promise;
    }

    this.logInfo(
      'file-ack-wait',
      JSON.stringify({
        bridge: this.bridgeId,
        transferId,
        stage,
        ackStage: stage,
        ackOutcome: 'waiting',
        waiterReused: false,
        chunkIndex: Number.isFinite(Number(params.chunkIndex))
          ? Number(params.chunkIndex)
          : undefined,
        key,
        ...ownerInfo,
        timeoutMs,
      }),
      { debugOnly: true },
    );

    let timer: NodeJS.Timeout;
    let resolveWaiter!: (payload: Record<string, unknown>) => void;
    let rejectWaiter!: (err: Error) => void;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
      timer = setTimeout(() => {
        this.fileAckWaiters.delete(key);
        this.logWarn(
          OUTBOUND_TERMINAL_REASON.FILE_ACK_TIMEOUT,
          JSON.stringify({
            bridge: this.bridgeId,
            transferId,
            stage,
            ackStage: stage,
            ackOutcome: 'timeout',
            waiterReused: false,
            chunkIndex: Number.isFinite(Number(params.chunkIndex))
              ? Number(params.chunkIndex)
              : undefined,
            key,
            ...ownerInfo,
            timeoutMs,
          }),
          { debugOnly: true },
        );
        reject(new Error(`file ack timeout: ${key}`));
      }, timeoutMs);
    });
    this.fileAckWaiters.set(key, {
      promise,
      resolve: resolveWaiter,
      reject: rejectWaiter,
      timer: timer!,
    });
    return promise;
  }

  private resolveFileAck(params: {
    transferId: string;
    stage: string;
    chunkIndex?: number;
    payload: Record<string, unknown>;
    ok: boolean;
  }) {
    const transferId = asString(params.transferId).trim();
    const stage = asString(params.stage).trim();
    const key = this.fileAckKey(transferId, stage, params.chunkIndex);
    const ownerInfo = this.fileAckOwnerInfo(transferId);
    const waiter = this.fileAckWaiters.get(key);
    if (!waiter) {
      this.rememberEarlyFileAck(key, {
        payload: params.payload,
        ok: params.ok,
        at: now(),
      });
      this.logInfo(
        'file-ack-early-cache',
        JSON.stringify({
          bridge: this.bridgeId,
          transferId,
          stage,
          ackStage: stage,
          ackOutcome: params.ok ? 'early-acked' : 'early-failed',
          waiterReused: false,
          chunkIndex: Number.isFinite(Number(params.chunkIndex))
            ? Number(params.chunkIndex)
            : undefined,
          key,
          ...ownerInfo,
          ok: params.ok,
          payload: params.payload,
          cached: true,
        }),
        { debugOnly: true },
      );
      return false;
    }
    this.fileAckWaiters.delete(key);
    clearTimeout(waiter.timer);
    this.logInfo(
      'file-ack-resolve',
      JSON.stringify({
        bridge: this.bridgeId,
        transferId,
        stage,
        ackStage: stage,
        ackOutcome: params.ok ? 'acked' : 'failed',
        waiterReused: false,
        chunkIndex: Number.isFinite(Number(params.chunkIndex))
          ? Number(params.chunkIndex)
          : undefined,
        key,
        ...ownerInfo,
        ok: params.ok,
        payload: params.payload,
      }),
      { debugOnly: true },
    );
    if (params.ok) waiter.resolve(params.payload);
    else
      waiter.reject(
        new Error(
          asString(params.payload?.errorMessage || params.payload?.error || 'file ack failed'),
        ),
      );
    return true;
  }

  private computeRecommendedAckTimeoutReason(args: {
    lateAckOkCount: number;
    recentAckTimeoutCount: number;
    lastLateAckPushLatencyMs: number | null;
    lastLateAckOkAt?: number | null;
    adaptiveAckRecoveryOkCount?: number;
    recommendedAckTimeoutMs?: number;
    nowMs?: number;
  }) {
    return computeBncrRecommendedAckTimeoutReason({
      ...args,
      nowMs: typeof args.nowMs === 'number' ? args.nowMs : now(),
      defaultAckTimeoutMs: PUSH_ACK_TIMEOUT_MS,
      minAckTimeoutMs: RECOMMENDED_ACK_TIMEOUT_MIN_MS,
      maxAckTimeoutMs: RECOMMENDED_ACK_TIMEOUT_MAX_MS,
      lateAckObservationTtlMs: ADAPTIVE_ACK_TIMEOUT_OBSERVATION_TTL_MS,
      recoveryOkThreshold: ADAPTIVE_ACK_TIMEOUT_RECOVERY_OK_THRESHOLD,
    });
  }

  private computeRecommendedAckTimeoutMs(args: {
    lateAckOkCount: number;
    recentAckTimeoutCount: number;
    lastLateAckPushLatencyMs: number | null;
    lastLateAckOkAt?: number | null;
    adaptiveAckRecoveryOkCount?: number;
    nowMs?: number;
  }) {
    return computeBncrRecommendedAckTimeoutMs({
      ...args,
      nowMs: typeof args.nowMs === 'number' ? args.nowMs : now(),
      defaultAckTimeoutMs: PUSH_ACK_TIMEOUT_MS,
      minAckTimeoutMs: RECOMMENDED_ACK_TIMEOUT_MIN_MS,
      maxAckTimeoutMs: RECOMMENDED_ACK_TIMEOUT_MAX_MS,
      lateAckObservationTtlMs: ADAPTIVE_ACK_TIMEOUT_OBSERVATION_TTL_MS,
      recoveryOkThreshold: ADAPTIVE_ACK_TIMEOUT_RECOVERY_OK_THRESHOLD,
    });
  }

  private maybeLogAdaptiveAckTimeout(args: {
    accountId: string;
    timeoutMs: number;
    reason: string;
    lastLateAckPushLatencyMs: number | null;
    nowMs?: number;
  }) {
    if (args.timeoutMs <= PUSH_ACK_TIMEOUT_MS) return;
    const t = typeof args.nowMs === 'number' ? args.nowMs : now();
    const previous = this.adaptiveAckTimeoutLogStateByAccount.get(args.accountId);
    if (
      previous &&
      previous.timeoutMs === args.timeoutMs &&
      previous.reason === args.reason &&
      t - previous.at < ADAPTIVE_ACK_TIMEOUT_LOG_THROTTLE_MS
    ) {
      return;
    }
    this.adaptiveAckTimeoutLogStateByAccount.set(args.accountId, {
      at: t,
      timeoutMs: args.timeoutMs,
      reason: args.reason,
    });
    const parts = [
      args.accountId,
      `current=${args.timeoutMs}`,
      `default=${PUSH_ACK_TIMEOUT_MS}`,
      `reason=${args.reason}`,
    ];
    if (typeof args.lastLateAckPushLatencyMs === 'number') {
      parts.push(`latePushMs=${args.lastLateAckPushLatencyMs}`);
    }
    this.logInfo('outbox ack timeout-adaptive', parts.join('|'));
  }

  private resolveMessageAckTimeoutMs(accountId?: string) {
    if (!ADAPTIVE_ACK_TIMEOUT_DEFAULT_ENABLED) return PUSH_ACK_TIMEOUT_MS;
    const acc = normalizeAccountId(accountId || BNCR_DEFAULT_ACCOUNT_ID);
    const lateAckOkCount = this.getCounter(this.lateAckOkCountByAccount, acc);
    const recentAckTimeoutCount = this.getCounter(this.ackTimeoutCountByAccount, acc);
    const lastLateAckPushLatencyMs = this.lastLateAckPushLatencyMsByAccount.get(acc) || null;
    const lastLateAckOkAt = this.lastLateAckOkByAccount.get(acc) || null;
    const adaptiveAckRecoveryOkCount = this.getCounter(
      this.adaptiveAckRecoveryOkCountByAccount,
      acc,
    );
    const nowMs = now();
    const timeoutMs = this.computeRecommendedAckTimeoutMs({
      lateAckOkCount,
      recentAckTimeoutCount,
      lastLateAckPushLatencyMs,
      lastLateAckOkAt,
      adaptiveAckRecoveryOkCount,
      nowMs,
    });
    const reason = this.computeRecommendedAckTimeoutReason({
      lateAckOkCount,
      recentAckTimeoutCount,
      lastLateAckPushLatencyMs,
      lastLateAckOkAt,
      adaptiveAckRecoveryOkCount,
      recommendedAckTimeoutMs: timeoutMs,
      nowMs,
    });
    this.maybeLogAdaptiveAckTimeout({
      accountId: acc,
      timeoutMs,
      reason,
      lastLateAckPushLatencyMs,
      nowMs,
    });
    return timeoutMs;
  }

  private buildRuntimeAckObservability(accountId: string) {
    const acc = normalizeAccountId(accountId);
    const recentAckTimeoutCount = this.getCounter(this.ackTimeoutCountByAccount, acc);
    const lateAckOkCount = this.getCounter(this.lateAckOkCountByAccount, acc);
    const lastLateAckPushLatencyMs = this.lastLateAckPushLatencyMsByAccount.get(acc) || null;
    const lastLateAckOkAt = this.lastLateAckOkByAccount.get(acc) || null;
    const nowMs = now();
    const lastLateAckAgeMs =
      typeof lastLateAckOkAt === 'number' && lastLateAckOkAt > 0
        ? Math.max(0, nowMs - lastLateAckOkAt)
        : null;
    const lateAckObservationTtlMs = ADAPTIVE_ACK_TIMEOUT_OBSERVATION_TTL_MS;
    const lateAckObservationExpired =
      typeof lastLateAckAgeMs === 'number' && lastLateAckAgeMs > lateAckObservationTtlMs;
    const adaptiveAckRecoveryOkCount = this.getCounter(
      this.adaptiveAckRecoveryOkCountByAccount,
      acc,
    );
    const adaptiveAckRecovered =
      adaptiveAckRecoveryOkCount >= ADAPTIVE_ACK_TIMEOUT_RECOVERY_OK_THRESHOLD;
    const recommendedAckTimeoutMs = this.computeRecommendedAckTimeoutMs({
      lateAckOkCount,
      recentAckTimeoutCount,
      lastLateAckPushLatencyMs,
      lastLateAckOkAt,
      adaptiveAckRecoveryOkCount,
      nowMs,
    });
    const currentAckTimeoutMs = this.resolveMessageAckTimeoutMs(acc);
    return {
      lastAckOkAt: this.lastAckOkByAccount.get(acc) || null,
      lastAckTimeoutAt: this.lastAckTimeoutByAccount.get(acc) || null,
      recentAckTimeoutCount,
      lateAckOkCount,
      lastLateAckOkAt,
      lastLateAckAgeMs,
      lateAckObservationTtlMs,
      lateAckObservationExpired,
      adaptiveAckRecoveryOkCount,
      adaptiveAckRecoveryOkThreshold: ADAPTIVE_ACK_TIMEOUT_RECOVERY_OK_THRESHOLD,
      adaptiveAckRecovered,
      lastAckQueueLatencyMs: this.lastAckQueueLatencyMsByAccount.get(acc) || null,
      lastAckPushLatencyMs: this.lastAckPushLatencyMsByAccount.get(acc) || null,
      lastLateAckQueueLatencyMs: this.lastLateAckQueueLatencyMsByAccount.get(acc) || null,
      lastLateAckPushLatencyMs,
      adaptiveAckTimeoutEnabled: ADAPTIVE_ACK_TIMEOUT_DEFAULT_ENABLED,
      defaultAckTimeoutMs: PUSH_ACK_TIMEOUT_MS,
      currentAckTimeoutMs,
      recommendedAckTimeoutMs,
      recommendedAckTimeoutReason: this.computeRecommendedAckTimeoutReason({
        lateAckOkCount,
        recentAckTimeoutCount,
        lastLateAckPushLatencyMs,
        lastLateAckOkAt,
        adaptiveAckRecoveryOkCount,
        recommendedAckTimeoutMs,
        nowMs,
      }),
    };
  }

  private buildRuntimeAckStrategy(ackObservability: Record<string, any>) {
    return buildBncrRuntimeAckStrategy({
      ackObservability,
      defaultAckTimeoutMs: PUSH_ACK_TIMEOUT_MS,
      maxAckTimeoutMs: RECOMMENDED_ACK_TIMEOUT_MAX_MS,
    });
  }

  private buildRuntimeStatusInput(accountId: string, overrides: { running?: boolean } = {}) {
    const acc = normalizeAccountId(accountId);
    const snapshots = buildRuntimeStatusSnapshots({
      accountId: acc,
      outboxEntries: this.outbox.values(),
      deadLetterEntries: this.deadLetter,
      sessionRouteEntries: this.sessionRoutes.values(),
      countInvalidOutboxSessionKeys: (snapshotAccountId) =>
        this.countInvalidOutboxSessionKeys(snapshotAccountId),
      countLegacyAccountResidue: (snapshotAccountId) =>
        this.countLegacyAccountResidue(snapshotAccountId),
      connectEventsByAccount: this.connectEventsByAccount,
      inboundEventsByAccount: this.inboundEventsByAccount,
      activityEventsByAccount: this.activityEventsByAccount,
      ackEventsByAccount: this.ackEventsByAccount,
      activeConnectionCount: (snapshotAccountId) => this.activeConnectionCount(snapshotAccountId),
      lastSessionByAccount: this.lastSessionByAccount,
      lastActivityByAccount: this.lastActivityByAccount,
      lastInboundByAccount: this.lastInboundByAccount,
      lastOutboundByAccount: this.lastOutboundByAccount,
    });
    return buildBncrRuntimeStatusInput({
      accountId: acc,
      connected: this.isOnline(acc),
      ...snapshots,
      startedAt: this.startedAt,
      running: overrides.running,
      channelRoot: path.join(process.cwd(), 'plugins', 'bncr'),
    });
  }

  private buildStatusMeta(accountId: string) {
    return buildStatusMetaFromRuntime(this.buildRuntimeStatusInput(accountId));
  }

  getAccountRuntimeSnapshot(accountId: string) {
    const snapshot = buildAccountRuntimeSnapshot(
      this.buildRuntimeStatusInput(accountId, { running: true }),
    );
    const ackObservability = this.buildRuntimeAckObservability(accountId);
    const ackStrategy = this.buildRuntimeAckStrategy(ackObservability);
    return {
      ...snapshot,
      ackObservability,
      ackStrategy,
      diagnostics: {
        ...(snapshot.diagnostics || {}),
        ackObservability,
        ackStrategy,
      },
      meta: {
        ...(snapshot.meta || {}),
        ackObservability,
        ackStrategy,
        diagnostics: {
          ...(snapshot.meta?.diagnostics || {}),
          ackObservability,
          ackStrategy,
        },
      },
    };
  }

  private buildStatusHeadline(accountId: string): string {
    return buildStatusHeadlineFromRuntime(this.buildRuntimeStatusInput(accountId));
  }

  getStatusHeadline(accountId: string): string {
    return this.buildStatusHeadline(accountId);
  }

  getChannelSummary(defaultAccountId: string) {
    const accountId = normalizeAccountId(defaultAccountId);
    const runtime = this.getAccountRuntimeSnapshot(accountId);
    const headline = this.buildStatusHeadline(accountId);

    if (runtime.connected) {
      return { linked: true, self: { e164: headline } };
    }

    // 顶层汇总不绑定某个 accountId：任一账号在线都应显示 linked
    const t = now();
    for (const c of this.connections.values()) {
      if (t - c.lastSeenAt <= CONNECT_TTL_MS) {
        return { linked: true, self: { e164: headline } };
      }
    }

    return { linked: false, self: { e164: headline } };
  }

  private enqueueOutbound(entry: OutboxEntry) {
    // Structure note (outbox enqueue entrypoint):
    // This is the sync handoff from message construction into the outbound state machine.
    // Responsibilities are intentionally narrow here: log/summary, persist into outbox,
    // schedule state save, then nudge flushPushQueue. Future refactors should keep enqueue
    // lightweight and avoid reintroducing retry / route / ACK policy decisions at this layer.
    this.logInfo(
      'outbound',
      JSON.stringify(
        buildOutboxEnqueueDebugInfo({
          bridgeId: this.bridgeId,
          entry,
          asString,
          formatDisplayScope,
        }),
      ),
      { debugOnly: true },
    );
    this.logOutboundSummary(entry);
    const accountId = normalizeAccountId(entry.accountId);
    this.incrementCounter(this.outboundEnqueueCountByAccount, accountId);
    this.lastOutboundEnqueueAtByAccount.set(accountId, now());
    this.outbox.set(entry.messageId, entry);
    this.scheduleSave();
    this.flushPushQueueBestEffort({ accountId: entry.accountId });
  }

  private moveToDeadLetter(entry: OutboxEntry, reason: string) {
    // Structure note (terminal transition):
    // Dead-lettering is the terminal state transition for an outbox entry. It also resolves any
    // waiter still blocked on the message id with timeout semantics, so future extraction should
    // treat dead-letter storage and waiter cleanup as one boundary rather than separate utilities.
    //
    // Queue-lifecycle note:
    // This path is shared by both explicit fatal outcomes and retry exhaustion. Keep that distinction
    // visible in callers, but keep the final sink centralized here so terminal accounting, persistence,
    // and waiter cleanup cannot drift apart.
    const dead = buildDeadLetterEntry(entry, reason);
    this.deadLetter = appendDeadLetter({
      deadLetter: this.deadLetter,
      entry: dead,
      maxEntries: MAX_DEAD_LETTER_ENTRIES,
    });
    this.outbox.delete(entry.messageId);
    this.resolveMessageAck(entry.messageId, 'timeout');
    this.scheduleSave();
  }

  collectDue(accountId: string, maxBatch: number): Array<Record<string, unknown>> {
    const key = normalizeAccountId(accountId);
    const result = collectDueOutboxEntries({
      outbox: this.outbox.values(),
      accountId: key,
      now: now(),
      maxBatch,
      maxRetry: MAX_RETRY,
      backoffMs,
    });

    for (const entry of result.updatedEntries) {
      this.outbox.set(entry.messageId, entry);
    }
    for (const entry of result.deadLetterEntries) {
      this.moveToDeadLetter(entry, entry.lastError || 'retry-limit');
    }

    if (result.duePayloads.length) this.scheduleSave();
    return result.duePayloads;
  }

  private async loadOutboundTransferMedia(params: {
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
  }): Promise<{
    loaded: OpenClawLoadedMedia;
    size: number;
    mimeType?: string;
    fileName: string;
  }> {
    const loaded = await loadOpenClawWebMedia(this.api, params.mediaUrl, {
      localRoots: params.mediaLocalRoots,
      maxBytes: 50 * 1024 * 1024,
    });
    const size = loaded.buffer.byteLength;
    const mimeType = loaded.contentType;
    const fileName = resolveOutboundFileName({
      mediaUrl: params.mediaUrl,
      fileName: loaded.fileName,
      mimeType,
    });
    return { loaded, size, mimeType, fileName };
  }

  private buildTransferRouteDiagnostics(args: {
    accountId: string;
    recentInboundReachable: boolean;
  }) {
    const directConnIds = this.resolvePushConnIds(args.accountId);
    const recentConnIds = args.recentInboundReachable
      ? this.resolveRecentInboundConnIds(args.accountId)
      : new Set<string>();
    const activeConnectionKey = this.activeConnectionByAccount.get(args.accountId) || null;
    const accountConnections = Array.from(this.connections.values())
      .filter((c) => c.accountId === args.accountId)
      .map((c) => ({
        connId: c.connId,
        clientId: c.clientId,
        connectedAt: c.connectedAt,
        lastSeenAt: c.lastSeenAt,
      }));

    return {
      directConnIds,
      recentConnIds,
      activeConnectionKey,
      accountConnections,
    };
  }

  private selectTransferConnIds(args: {
    directConnIds: Set<string>;
    recentConnIds: Set<string>;
    recentInboundReachable: boolean;
  }) {
    let connIds = args.directConnIds;
    if (!connIds.size && args.recentInboundReachable) {
      connIds = args.recentConnIds;
    }
    return connIds;
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
    this.logInfo(
      'file-chunk-diag',
      JSON.stringify({
        bridge: this.bridgeId,
        accountId: args.accountId,
        sessionKey: args.sessionKey,
        mediaUrl: args.mediaUrl,
        hasGatewayContext: args.hasGatewayContext,
        activeConnectionKey: args.activeConnectionKey,
        ownerConnId: args.ownerConnId || null,
        ownerClientId: args.ownerClientId || null,
        directConnIds: Array.from(args.directConnIds),
        recentInboundReachable: args.recentInboundReachable,
        recentConnIds: Array.from(args.recentConnIds),
        accountConnections: args.accountConnections,
      }),
      { debugOnly: true },
    );
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
    connIds: Iterable<string>;
    ownerConnId?: string;
    ownerClientId?: string;
  }) {
    this.logInfo(
      'file-transfer-start',
      JSON.stringify({
        bridge: this.bridgeId,
        transferId: args.transferId,
        accountId: args.accountId,
        sessionKey: args.sessionKey,
        mediaUrl: args.mediaUrl,
        fileName: args.fileName,
        mimeType: args.mimeType,
        fileSize: args.fileSize,
        chunkSize: args.chunkSize,
        totalChunks: args.totalChunks,
        connIds: Array.from(args.connIds),
        ownerConnId: args.ownerConnId || null,
        ownerClientId: args.ownerClientId || null,
      }),
      { debugOnly: true },
    );
  }

  private logFileTransferChunkSend(args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
    offset: number;
    size: number;
    connIds: Iterable<string>;
  }) {
    this.logInfo(
      'file-transfer-chunk-send',
      JSON.stringify({
        bridge: this.bridgeId,
        transferId: args.transferId,
        accountId: args.accountId,
        chunkIndex: args.chunkIndex,
        attempt: args.attempt,
        offset: args.offset,
        size: args.size,
        connIds: Array.from(args.connIds),
      }),
      { debugOnly: true },
    );
  }

  private logFileTransferChunkAck(args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
  }) {
    this.logInfo(
      'file-transfer-chunk-ack',
      JSON.stringify({
        bridge: this.bridgeId,
        transferId: args.transferId,
        accountId: args.accountId,
        chunkIndex: args.chunkIndex,
        attempt: args.attempt,
      }),
      { debugOnly: true },
    );
  }

  private logFileTransferChunkAckFail(args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
    error: unknown;
  }) {
    this.logWarn(
      'file-transfer-chunk-ack-fail',
      JSON.stringify({
        bridge: this.bridgeId,
        transferId: args.transferId,
        accountId: args.accountId,
        chunkIndex: args.chunkIndex,
        attempt: args.attempt,
        error: asString((args.error as Error)?.message || args.error),
      }),
      { debugOnly: true },
    );
  }

  private logFileTransferCompleteSend(args: {
    transferId: string;
    accountId: string;
    connIds: Iterable<string>;
  }) {
    this.logInfo(
      'file-transfer-complete-send',
      JSON.stringify({
        bridge: this.bridgeId,
        transferId: args.transferId,
        accountId: args.accountId,
        connIds: Array.from(args.connIds),
      }),
      { debugOnly: true },
    );
  }

  private logFileTransferCompleteAck(args: {
    transferId: string;
    accountId: string;
    payload: { path: string };
  }) {
    this.logInfo(
      'file-transfer-complete-ack',
      JSON.stringify({
        bridge: this.bridgeId,
        transferId: args.transferId,
        accountId: args.accountId,
        payload: args.payload,
      }),
      { debugOnly: true },
    );
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
    return {
      transferId: args.transferId,
      accountId: normalizeAccountId(args.accountId),
      sessionKey: args.sessionKey,
      route: args.route,
      fileName: args.fileName,
      mimeType: args.mimeType || 'application/octet-stream',
      fileSize: args.fileSize,
      chunkSize: args.chunkSize,
      totalChunks: args.totalChunks,
      fileSha256: args.fileSha256,
      startedAt: now(),
      status: 'init',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      ownerConnId: args.ownerConnId,
      ownerClientId: args.ownerClientId,
    };
  }

  private async sleepMs(ms: number): Promise<void> {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, clampFiniteNumber(ms, 0, 0, INTERNAL_SLEEP_MAX_MS)),
    );
  }

  private async waitChunkAck(params: {
    transferId: string;
    chunkIndex: number;
    timeoutMs?: number;
  }): Promise<void> {
    // Refactor boundary note (file-transfer / ACK coupling):
    // Chunk-level ACK waiting is part of the file-transfer sub-protocol, but it depends directly on
    // mutable transfer runtime state in fileSendTransfers. Keep state prechecks here, while ACK wakeup
    // uses the shared event-style fileAckWaiters path instead of polling transfer state.
    const { transferId, chunkIndex } = params;
    const st = this.fileSendTransfers.get(transferId);
    if (!st) throw new Error('transfer state missing');
    if (st.failedChunks.has(chunkIndex)) {
      throw new Error(st.failedChunks.get(chunkIndex) || `chunk ${chunkIndex} failed`);
    }
    if (st.ackedChunks.has(chunkIndex)) return;

    await this.waitForFileAck({
      transferId,
      stage: 'chunk',
      chunkIndex,
      timeoutMs: clampFiniteNumber(params.timeoutMs, FILE_TRANSFER_ACK_TTL_MS, 1_000, 60_000),
    });
  }

  private async waitCompleteAck(params: {
    transferId: string;
    timeoutMs?: number;
  }): Promise<{ path: string }> {
    // Refactor boundary note (file-transfer completion):
    // Completion ACK waiting shares the same transfer lifecycle boundary as chunk ACKs and relies on
    // transfer status transitions performed elsewhere in channel.ts. Keep completion wait behavior and
    // transfer-state mutation boundaries aligned if/when file-transfer pieces are moved out.
    const { transferId } = params;
    const st = this.fileSendTransfers.get(transferId);
    if (!st) throw new Error('transfer state missing');
    if (st.status === 'aborted') throw new Error(st.error || 'transfer aborted');
    if (st.status === 'completed' && st.completedPath) return { path: st.completedPath };

    const payload = await this.waitForFileAck({
      transferId,
      stage: 'complete',
      timeoutMs: clampFiniteNumber(params.timeoutMs, 60_000, 2_000, 120_000),
    });
    const updated = this.fileSendTransfers.get(transferId);
    const path = asString(payload?.path || updated?.completedPath || '').trim();
    if (!path) throw new Error('complete ack missing path');
    return { path };
  }

  private async transferMediaToBncrClient(params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
  }): Promise<{
    // Refactor boundary note (file-transfer root):
    // This method is the root of the outbound file-transfer protocol. It owns media loading,
    // inline-vs-chunk mode selection, route/owner selection for transfer delivery, chunk send,
    // chunk ACK waits, complete ACK waits, and abort propagation. Future extraction should treat
    // these as one protocol boundary first, rather than splitting transport and state handling separately.
    mode: 'base64' | 'chunk';
    mimeType?: string;
    fileName?: string;
    mediaBase64?: string;
    path?: string;
  }> {
    const { loaded, size, mimeType, fileName } = await this.loadOutboundTransferMedia({
      mediaUrl: params.mediaUrl,
      mediaLocalRoots: params.mediaLocalRoots,
    });

    if (!FILE_FORCE_CHUNK && size <= FILE_INLINE_THRESHOLD) {
      return {
        mode: 'base64',
        mimeType,
        fileName,
        mediaBase64: loaded.buffer.toString('base64'),
      };
    }

    const ctx = this.gatewayContext;
    const owner = this.resolveOutboxPushOwner(params.accountId);
    const recentInboundReachable = this.hasRecentInboundReachability(params.accountId);
    const accountId = normalizeAccountId(params.accountId);
    const routeDiagnostics = this.buildTransferRouteDiagnostics({
      accountId,
      recentInboundReachable,
    });
    this.logFileChunkDiag({
      accountId,
      sessionKey: params.sessionKey,
      mediaUrl: params.mediaUrl,
      hasGatewayContext: Boolean(ctx),
      activeConnectionKey: routeDiagnostics.activeConnectionKey,
      ownerConnId: owner?.connId,
      ownerClientId: owner?.clientId,
      directConnIds: routeDiagnostics.directConnIds,
      recentInboundReachable,
      recentConnIds: routeDiagnostics.recentConnIds,
      accountConnections: routeDiagnostics.accountConnections,
    });
    if (!ctx) throw new Error('gateway context unavailable');

    const connIds = this.selectTransferConnIds({
      directConnIds: routeDiagnostics.directConnIds,
      recentConnIds: routeDiagnostics.recentConnIds,
      recentInboundReachable,
    });
    if (!connIds.size) throw new Error('no active bncr client for file chunk transfer');

    const transferId = randomUUID();
    const chunkSize = 256 * 1024;
    const totalChunks = Math.ceil(size / chunkSize);
    const fileSha256 = createHash('sha256').update(loaded.buffer).digest('hex');

    this.logFileTransferStart({
      transferId,
      accountId,
      sessionKey: params.sessionKey,
      mediaUrl: params.mediaUrl,
      fileName,
      mimeType,
      fileSize: size,
      chunkSize,
      totalChunks,
      connIds,
      ownerConnId: owner?.connId,
      ownerClientId: owner?.clientId,
    });

    const st = this.buildInitialFileSendTransferState({
      transferId,
      accountId: params.accountId,
      sessionKey: params.sessionKey,
      route: params.route,
      fileName,
      mimeType,
      fileSize: size,
      chunkSize,
      totalChunks,
      fileSha256,
      ownerConnId: owner?.connId,
      ownerClientId: owner?.clientId,
    });
    this.fileSendTransfers.set(transferId, st);

    ctx.broadcastToConnIds(
      BNCR_FILE_INIT_EVENT,
      buildFileTransferInitPayload({
        transferId,
        sessionKey: params.sessionKey,
        route: params.route,
        fileName,
        mimeType,
        fileSize: size,
        chunkSize,
        totalChunks,
        fileSha256,
        ts: now(),
      }),
      connIds,
    );

    // 逐块发送并等待 ACK
    for (let idx = 0; idx < totalChunks; idx++) {
      const start = idx * chunkSize;
      const end = Math.min(start + chunkSize, size);
      const slice = loaded.buffer.subarray(start, end);
      const chunkSha256 = createHash('sha256').update(slice).digest('hex');

      let ok = false;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        ctx.broadcastToConnIds(
          BNCR_FILE_CHUNK_EVENT,
          buildFileTransferChunkPayload({
            transferId,
            chunkIndex: idx,
            offset: start,
            size: slice.byteLength,
            chunkSha256,
            base64: slice.toString('base64'),
            ts: now(),
          }),
          connIds,
        );

        this.logFileTransferChunkSend({
          transferId,
          accountId,
          chunkIndex: idx,
          attempt,
          offset: start,
          size: slice.byteLength,
          connIds,
        });

        try {
          await this.waitChunkAck({
            transferId,
            chunkIndex: idx,
            timeoutMs: FILE_TRANSFER_ACK_TTL_MS,
          });
          this.logFileTransferChunkAck({
            transferId,
            accountId,
            chunkIndex: idx,
            attempt,
          });
          ok = true;
          break;
        } catch (err) {
          lastErr = err;
          this.logFileTransferChunkAckFail({
            transferId,
            accountId,
            chunkIndex: idx,
            attempt,
            error: err,
          });
          await this.sleepMs(150 * attempt);
        }
      }

      if (!ok) {
        st.status = 'aborted';
        st.terminalAt = now();
        st.error = String((lastErr as any)?.message || lastErr || `chunk-${idx}-failed`);
        this.fileSendTransfers.set(transferId, st);
        ctx.broadcastToConnIds(
          BNCR_FILE_ABORT_EVENT,
          buildFileTransferAbortPayload({
            transferId,
            reason: st.error,
            ts: now(),
          }),
          connIds,
        );
        throw new Error(st.error);
      }
    }

    ctx.broadcastToConnIds(
      BNCR_FILE_COMPLETE_EVENT,
      buildFileTransferCompletePayload({
        transferId,
        ts: now(),
      }),
      connIds,
    );

    this.logFileTransferCompleteSend({
      transferId,
      accountId,
      connIds,
    });

    const done = await this.waitCompleteAck({ transferId, timeoutMs: 60_000 });

    this.logFileTransferCompleteAck({
      transferId,
      accountId,
      payload: done,
    });

    return {
      mode: 'chunk',
      mimeType,
      fileName,
      path: done.path,
    };
  }

  public async enqueueFromReply(params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: ReplyPayloadInput;
    mediaLocalRoots?: readonly string[];
  }) {
    const { accountId, sessionKey, route, payload, mediaLocalRoots } = params;
    const normalized = normalizeReplyPayload(payload, { asString });

    enqueueNormalizedReplyPayload(
      {
        accountId,
        sessionKey,
        route,
        payload: normalized,
        mediaLocalRoots,
      },
      {
        logEnqueueFromReply: (args) => this.logEnqueueFromReply(args),
        hasReplyMediaEntries,
        enqueueReplyMediaEntries: (args) => this.enqueueReplyMediaEntries(args),
        enqueueReplyTextEntry: (args) =>
          enqueueReplyTextEntry(args, {
            enqueueOutbound: (entry) => this.enqueueOutbound(entry),
            buildTextOutboxEntry: (entryArgs) => this.buildTextOutboxEntry(entryArgs),
          }),
      },
    );
  }

  private logEnqueueFromReply(args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: NormalizedReplyPayload;
  }) {
    this.logInfo(
      'outbound',
      `enqueue-from-reply ${JSON.stringify(buildEnqueueFromReplyDebugInfo(args))}`,
      { debugOnly: true },
    );
  }

  private enqueueSingleReplyMediaEntry(args: {
    params: ReplyMediaEntriesParams;
    mediaUrl: string;
    first: boolean;
    currentTime: number;
  }) {
    const normalizedText = normalizeMessageText(args.first ? args.params.payload.text : '');
    const fallback = this.tryBuildMediaDedupeFallback({
      sessionKey: args.params.sessionKey,
      mediaUrl: args.mediaUrl,
      text: normalizedText,
      replyToId: args.params.payload.replyToId,
      currentTime: args.currentTime,
    });

    enqueueSingleReplyMediaEntry(
      {
        params: args.params,
        mediaUrl: args.mediaUrl,
        normalizedText,
        text: args.first ? args.params.payload.text : '',
        fallback,
        currentTime: args.currentTime,
      },
      {
        enqueueReplyMediaFallbackTextEntry: (params) =>
          enqueueReplyMediaFallbackTextEntry(params, {
            logInfo: (scope, message, options) => this.logInfo(scope, message, options),
            enqueueOutbound: (entry) => this.enqueueOutbound(entry),
            buildTextOutboxEntry: (entryParams) => this.buildTextOutboxEntry(entryParams),
          }),
        enqueueReplyMediaFileTransferEntry: (params) =>
          enqueueReplyMediaFileTransferEntry(params, {
            enqueueOutbound: (entry) => this.enqueueOutbound(entry),
            buildFileTransferOutboxEntry: (entryParams) =>
              this.buildFileTransferOutboxEntry(entryParams),
            rememberRecentMediaSend: (entryParams) => this.rememberRecentMediaSend(entryParams),
          }),
      },
    );
  }

  private enqueueReplyMediaEntries(params: ReplyMediaEntriesParams) {
    let first = true;
    const currentTime = now();

    for (const mediaUrl of params.payload.mediaList) {
      this.enqueueSingleReplyMediaEntry({
        params,
        mediaUrl,
        first,
        currentTime,
      });
      first = false;
    }
  }

  handleConnect = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    await this.syncDebugFlag();
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
    const outboundReady = (params as any)?.outboundReady === true;
    const preferredForOutbound = (params as any)?.preferredForOutbound === true;
    const inboundOnly = (params as any)?.inboundOnly === true;

    this.logInfo(
      'connection',
      `connect ${JSON.stringify({
        bridge: this.bridgeId,
        accountId,
        connId,
        clientId,
        outboundReady,
        preferredForOutbound,
        inboundOnly,
        hasContext: Boolean(context),
      })}`,
      { debugOnly: true },
    );

    this.refreshLiveConnectionState({
      accountId,
      connId,
      clientId,
      outboundReady,
      preferredForOutbound,
      inboundOnly,
      context,
    });
    this.incrementCounter(this.connectEventsByAccount, accountId);
    const lease = this.acceptConnection();

    respond(true, {
      channel: CHANNEL_ID,
      accountId,
      bridgeVersion: BRIDGE_VERSION,
      pushEvent: BNCR_PUSH_EVENT,
      online: true,
      isPrimary: this.isPrimaryConnection(accountId, clientId),
      activeConnections: this.activeConnectionCount(accountId),
      pending: Array.from(this.outbox.values()).filter((v) => v.accountId === accountId).length,
      deadLetter: this.deadLetter.filter((v) => v.accountId === accountId).length,
      diagnostics: this.buildExtendedDiagnostics(accountId),
      runtimeFlags: this.buildRuntimeFlags(accountId),
      waiters: {
        messageAck: this.messageAckWaiters.size,
        fileAck: this.fileAckWaiters.size,
      },
      leaseId: lease.leaseId,
      connectionEpoch: lease.connectionEpoch,
      protocolVersion: 2,
      acceptedAt: lease.acceptedAt,
      serverPid: this.gatewayPid,
      bridgeId: this.bridgeId,
      now: now(),
    });

    // WS 一旦在线，立即尝试把离线期间积压队列直推出去
    this.flushPushQueueBestEffort({
      accountId,
      trigger: OUTBOUND_FLUSH_TRIGGER.CONNECT,
      reason: OUTBOUND_FLUSH_REASON.WS_ONLINE,
    });
  };

  handleAck = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    // Structure note (explicit ACK event boundary):
    // Successful ACK events are the authoritative source for removing outbox entries and resolving
    // message-ack waiters. flushPushQueue may wait for ACKs, but it is not the source of truth for
    // final entry deletion. Keep this boundary explicit in future refactors.
    await this.syncDebugFlag();
    const prepared = this.prepareAckHandling({ params, respond, client, context });
    if (!prepared) return;

    const { accountId } = prepared;
    this.lastAckAtGlobal = now();
    this.incrementCounter(this.ackEventsByAccount, accountId);
    this.handleAckOutcome({ params, respond, ...prepared });
  };

  handleActivity = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    // Structure note (activity-driven flush nudge):
    // Activity events refresh liveness/capability state first, then nudge outbound draining.
    // They are not a retry policy engine by themselves; they only give the scheduler a better
    // chance to drain with fresher reachability information.
    await this.syncDebugFlag();
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
    const outboundReady = (params as any)?.outboundReady === true;
    const preferredForOutbound = (params as any)?.preferredForOutbound === true;
    const inboundOnly = (params as any)?.inboundOnly === true;
    if (
      this.shouldIgnoreStaleEvent({
        kind: 'activity',
        payload: params ?? {},
        accountId,
        connId,
        clientId,
      })
    ) {
      respond(true, { accountId, ok: true, event: 'activity', stale: true, ignored: true });
      return;
    }
    this.lastActivityAtGlobal = now();
    this.logInfo(
      'activity',
      `event ${JSON.stringify({
        bridge: this.bridgeId,
        accountId,
        connId,
        clientId,
        outboundReady,
        preferredForOutbound,
        inboundOnly,
        hasContext: Boolean(context),
      })}`,
      { debugOnly: true },
    );
    this.refreshLiveConnectionState({
      accountId,
      connId,
      clientId,
      outboundReady,
      preferredForOutbound,
      inboundOnly,
      context,
    });
    this.incrementCounter(this.activityEventsByAccount, accountId);

    // 轻量活动心跳：仅刷新在线活跃状态，不承担拉取职责。
    respond(true, {
      accountId,
      ok: true,
      event: 'activity',
      activeConnections: this.activeConnectionCount(accountId),
      pending: Array.from(this.outbox.values()).filter((v) => v.accountId === accountId).length,
      deadLetter: this.deadLetter.filter((v) => v.accountId === accountId).length,
      now: now(),
    });
    this.flushPushQueueBestEffort({
      accountId,
      trigger: OUTBOUND_FLUSH_TRIGGER.ACTIVITY,
      reason: OUTBOUND_FLUSH_REASON.ACTIVITY_HEARTBEAT,
    });
  };

  handleDiagnostics = async ({ params, respond }: GatewayRequestHandlerOptions) => {
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const cfg = getOpenClawRuntimeConfig(this.api);
    const runtime = this.getAccountRuntimeSnapshot(accountId);
    const diagnostics = this.buildExtendedDiagnostics(accountId);

    respond(
      true,
      buildDiagnosticsPayload({
        cfg,
        channelId: CHANNEL_ID,
        accountId,
        runtime,
        diagnostics,
        downlinkHealth: this.buildDownlinkHealth(accountId),
        runtimeFlags: this.buildRuntimeFlags(accountId),
        waiters: {
          messageAck: this.messageAckWaiters.size,
          fileAck: this.fileAckWaiters.size,
        },
        activeConnections: this.activeConnectionCount(accountId),
        invalidOutboxSessionKeys: this.countInvalidOutboxSessionKeys(accountId),
        legacyAccountResidue: this.countLegacyAccountResidue(accountId),
        now: now(),
      }),
    );
  };

  handleFileInit = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
    if (
      this.shouldIgnoreStaleEvent({
        kind: 'file.init',
        payload: params ?? {},
        accountId,
        connId,
        clientId,
      })
    ) {
      respond(true, { ok: true, stale: true, ignored: true });
      return;
    }
    this.refreshAcceptedFileTransferLiveState({
      accountId,
      connId,
      clientId,
      context,
    });

    const transferId = asString(params?.transferId || '').trim();
    const sessionKey = asString(params?.sessionKey || '').trim();
    const fileName = asString(params?.fileName || '').trim() || 'file.bin';
    const mimeType = asString(params?.mimeType || '').trim() || 'application/octet-stream';
    const fileSize = finiteNonNegativeNumberOrNull(params?.fileSize);
    const chunkSize = finiteNonNegativeNumberOrNull(params?.chunkSize ?? 256 * 1024);
    const totalChunks = finiteNonNegativeNumberOrNull(params?.totalChunks);
    const fileSha256 = asString(params?.fileSha256 || '').trim();

    if (!transferId || !sessionKey || !fileSize || !chunkSize || !totalChunks) {
      respond(false, { error: 'transferId/sessionKey/fileSize/chunkSize/totalChunks required' });
      return;
    }
    if (fileSize > INBOUND_FILE_TRANSFER_MAX_BYTES) {
      respond(false, {
        error: `fileSize too large size=${fileSize} max=${INBOUND_FILE_TRANSFER_MAX_BYTES}`,
      });
      return;
    }
    if (totalChunks > INBOUND_FILE_TRANSFER_MAX_CHUNKS) {
      respond(false, {
        error: `totalChunks too large total=${totalChunks} max=${INBOUND_FILE_TRANSFER_MAX_CHUNKS}`,
      });
      return;
    }
    const expectedTotalChunks = Math.ceil(fileSize / chunkSize);
    if (totalChunks !== expectedTotalChunks) {
      respond(false, {
        error: `totalChunks mismatch total=${totalChunks} expected=${expectedTotalChunks}`,
      });
      return;
    }

    const normalized = normalizeStoredSessionKey(sessionKey);
    if (!normalized) {
      respond(false, { error: 'invalid sessionKey' });
      return;
    }

    const existing = this.fileRecvTransfers.get(transferId);
    if (existing) {
      respond(true, {
        ok: true,
        transferId,
        status: existing.status,
        duplicated: true,
      });
      return;
    }

    const route =
      parseRouteLike({
        platform: asString(params?.platform || normalized.route.platform),
        groupId: asString(params?.groupId || normalized.route.groupId),
        userId: asString(params?.userId || normalized.route.userId),
      }) || normalized.route;

    this.fileRecvTransfers.set(transferId, {
      transferId,
      accountId,
      sessionKey: normalized.sessionKey,
      route,
      fileName,
      mimeType,
      fileSize,
      chunkSize,
      totalChunks,
      fileSha256,
      startedAt: now(),
      status: 'init',
      bufferByChunk: new Map(),
      receivedChunks: new Set(),
      ownerConnId: connId,
      ownerClientId: clientId,
    });

    respond(true, {
      ok: true,
      transferId,
      status: 'init',
    });
  };

  handleFileChunk = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;

    const transferId = asString(params?.transferId || '').trim();
    const chunkIndex = finiteNonNegativeNumberOrNull(params?.chunkIndex);
    const offset = finiteNonNegativeNumberOrNull(params?.offset ?? 0);
    const size = finiteNonNegativeNumberOrNull(params?.size ?? 0);
    const chunkSha256 = asString(params?.chunkSha256 || '').trim();
    const base64 = asString(params?.base64 || '');

    if (!transferId || chunkIndex == null || !base64) {
      respond(false, { error: 'transferId/chunkIndex/base64 required' });
      return;
    }

    const st = this.fileRecvTransfers.get(transferId);
    if (!st) {
      respond(false, { error: 'transfer not found' });
      return;
    }
    if (st.status === 'completed') {
      respond(true, {
        ok: true,
        transferId,
        status: 'completed',
        path: st.completedPath,
        ignored: true,
        terminal: true,
      });
      return;
    }
    if (chunkIndex >= st.totalChunks) {
      respond(false, {
        error: `chunkIndex out of range index=${chunkIndex} total=${st.totalChunks}`,
      });
      return;
    }

    const staleObserved = this.observeLease('file.chunk', params ?? {});
    if (staleObserved.stale) {
      if (
        !this.matchesTransferOwner({
          ownerConnId: st.ownerConnId,
          ownerClientId: st.ownerClientId,
          connId,
          clientId,
        })
      ) {
        this.logWarn(
          'stale',
          `ignore kind=file.chunk accountId=${accountId} connId=${connId} clientId=${clientId || '-'} transferId=${transferId} reason=owner-mismatch ownerConnId=${st.ownerConnId || '-'} ownerClientId=${st.ownerClientId || '-'}`,
          { debugOnly: true },
        );
        respond(true, { ok: true, stale: true, ignored: true });
        return;
      }
    } else {
      this.refreshAcceptedFileTransferLiveState({
        accountId,
        connId,
        clientId,
        context,
      });
    }

    try {
      const buf = Buffer.from(base64, 'base64');
      if (size != null && size > 0 && buf.length !== size) {
        throw new Error(`chunk size mismatch expected=${size} got=${buf.length}`);
      }
      if (chunkSha256) {
        const digest = createHash('sha256').update(buf).digest('hex');
        if (digest !== chunkSha256) throw new Error('chunk sha256 mismatch');
      }
      st.bufferByChunk.set(chunkIndex, buf);
      st.receivedChunks.add(chunkIndex);
      st.status = 'transferring';
      this.fileRecvTransfers.set(transferId, st);

      respond(
        true,
        staleObserved.stale
          ? {
              ok: true,
              transferId,
              chunkIndex,
              offset,
              received: st.receivedChunks.size,
              totalChunks: st.totalChunks,
              stale: true,
              staleAccepted: true,
            }
          : {
              ok: true,
              transferId,
              chunkIndex,
              offset,
              received: st.receivedChunks.size,
              totalChunks: st.totalChunks,
            },
      );
    } catch (error) {
      respond(false, { error: String((error as any)?.message || error || 'chunk invalid') });
    }
  };

  handleFileComplete = async ({
    params,
    respond,
    client,
    context,
  }: GatewayRequestHandlerOptions) => {
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;

    const transferId = asString(params?.transferId || '').trim();
    if (!transferId) {
      respond(false, { error: 'transferId required' });
      return;
    }

    const st = this.fileRecvTransfers.get(transferId);
    if (!st) {
      respond(false, { error: 'transfer not found' });
      return;
    }

    const staleObserved = this.observeLease('file.complete', params ?? {});
    if (staleObserved.stale) {
      if (
        !this.matchesTransferOwner({
          ownerConnId: st.ownerConnId,
          ownerClientId: st.ownerClientId,
          connId,
          clientId,
        })
      ) {
        this.logWarn(
          'stale',
          `ignore kind=file.complete accountId=${accountId} connId=${connId} clientId=${clientId || '-'} transferId=${transferId} reason=owner-mismatch ownerConnId=${st.ownerConnId || '-'} ownerClientId=${st.ownerClientId || '-'}`,
          { debugOnly: true },
        );
        respond(true, { ok: true, stale: true, ignored: true });
        return;
      }
    } else {
      this.refreshAcceptedFileTransferLiveState({
        accountId,
        connId,
        clientId,
        context,
      });
    }

    try {
      if (st.receivedChunks.size < st.totalChunks) {
        throw new Error(
          `chunk not complete received=${st.receivedChunks.size} total=${st.totalChunks}`,
        );
      }

      const ordered = Array.from(st.bufferByChunk.entries())
        .sort((a, b) => a[0] - b[0])
        .map((x) => x[1]);
      const merged = Buffer.concat(ordered);
      if (st.fileSize > 0 && merged.length !== st.fileSize) {
        throw new Error(`file size mismatch expected=${st.fileSize} got=${merged.length}`);
      }
      const digest = createHash('sha256').update(merged).digest('hex');
      if (st.fileSha256 && digest !== st.fileSha256) {
        throw new Error('file sha256 mismatch');
      }

      const saved = await saveOpenClawChannelMediaBuffer(
        this.api,
        merged,
        st.mimeType,
        'inbound',
        50 * 1024 * 1024,
        st.fileName,
      );
      st.completedPath = saved.path;
      st.status = 'completed';
      st.terminalAt = now();
      this.fileRecvTransfers.set(transferId, st);

      respond(
        true,
        staleObserved.stale
          ? {
              ok: true,
              transferId,
              path: saved.path,
              size: merged.length,
              fileName: st.fileName,
              mimeType: st.mimeType,
              fileSha256: digest,
              stale: true,
              staleAccepted: true,
            }
          : {
              ok: true,
              transferId,
              path: saved.path,
              size: merged.length,
              fileName: st.fileName,
              mimeType: st.mimeType,
              fileSha256: digest,
            },
      );
    } catch (error) {
      st.status = 'aborted';
      st.terminalAt = now();
      st.error = String((error as any)?.message || error || 'complete failed');
      this.fileRecvTransfers.set(transferId, st);
      respond(false, { error: st.error });
    }
  };

  handleFileAbort = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;

    const transferId = asString(params?.transferId || '').trim();
    if (!transferId) {
      respond(false, { error: 'transferId required' });
      return;
    }

    const st = this.fileRecvTransfers.get(transferId);
    if (!st) {
      respond(true, { ok: true, transferId, message: 'not-found' });
      return;
    }
    if (st.status === 'completed') {
      respond(true, {
        ok: true,
        transferId,
        status: 'completed',
        path: st.completedPath,
        ignored: true,
        terminal: true,
      });
      return;
    }

    const staleObserved = this.observeLease('file.abort', params ?? {});
    if (staleObserved.stale) {
      if (
        !this.matchesTransferOwner({
          ownerConnId: st.ownerConnId,
          ownerClientId: st.ownerClientId,
          connId,
          clientId,
        })
      ) {
        this.logWarn(
          'stale',
          `ignore kind=file.abort accountId=${accountId} connId=${connId} clientId=${clientId || '-'} transferId=${transferId} reason=owner-mismatch ownerConnId=${st.ownerConnId || '-'} ownerClientId=${st.ownerClientId || '-'}`,
          { debugOnly: true },
        );
        respond(true, { ok: true, stale: true, ignored: true });
        return;
      }
    } else {
      this.refreshAcceptedFileTransferLiveState({
        accountId,
        connId,
        clientId,
        context,
      });
    }

    st.status = 'aborted';
    st.terminalAt = now();
    st.error = asString(params?.reason || 'aborted');
    this.fileRecvTransfers.set(transferId, st);

    respond(
      true,
      staleObserved.stale
        ? {
            ok: true,
            transferId,
            status: 'aborted',
            stale: true,
            staleAccepted: true,
          }
        : {
            ok: true,
            transferId,
            status: 'aborted',
          },
    );
  };

  handleFileAck = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;

    const transferId = asString(params?.transferId || '').trim();
    const stage = asString(params?.stage || '').trim();
    const ok = params?.ok !== false;
    const chunkIndex = finiteNonNegativeNumberOrNull(params?.chunkIndex);

    this.logInfo(
      'file-ack-inbound',
      JSON.stringify({
        bridge: this.bridgeId,
        accountId,
        connId,
        clientId: clientId || null,
        transferId,
        stage,
        ackStage: stage,
        ackOutcome: ok ? 'acked' : 'failed',
        ok,
        chunkIndex: chunkIndex != null ? chunkIndex : undefined,
        errorCode: asString(params?.errorCode || ''),
        errorMessage: asString(params?.errorMessage || ''),
        path: asString(params?.path || '').trim(),
      }),
      { debugOnly: true },
    );

    if (!transferId || !stage) {
      respond(false, { error: 'transferId/stage required' });
      return;
    }

    const st = this.fileSendTransfers.get(transferId);
    const staleKind =
      stage === 'init'
        ? 'file.init'
        : stage === 'chunk'
          ? 'file.chunk'
          : stage === 'abort'
            ? 'file.abort'
            : 'file.complete';
    const staleObserved = this.observeLease(staleKind, params ?? {});
    if (st?.status === 'completed' || st?.status === 'aborted') {
      respond(
        true,
        staleObserved.stale
          ? {
              ok: true,
              transferId,
              stage,
              state: st.status,
              stale: true,
              ignored: true,
              terminal: true,
            }
          : {
              ok: true,
              transferId,
              stage,
              state: st.status,
              ignored: true,
              terminal: true,
            },
      );
      return;
    }
    if (staleObserved.stale) {
      const sameConn = !!st?.ownerConnId && st.ownerConnId === connId;
      const sameClient =
        !st?.ownerConnId && !!st?.ownerClientId && !!clientId && st.ownerClientId === clientId;
      const adopted =
        !(sameConn || sameClient) &&
        this.tryAdoptTransferOwner({
          accountId,
          transfer: st,
          connId,
          clientId,
        });
      if (!(sameConn || sameClient || adopted)) {
        this.logWarn(
          'stale',
          `ignore kind=file.ack accountId=${accountId} connId=${connId} clientId=${clientId || '-'} transferId=${transferId} stage=${stage} reason=owner-mismatch ownerConnId=${st?.ownerConnId || '-'} ownerClientId=${st?.ownerClientId || '-'}`,
          { debugOnly: true },
        );
        respond(true, { ok: true, stale: true, ignored: true });
        return;
      }
    } else {
      this.refreshAcceptedFileTransferLiveState({
        accountId,
        connId,
        clientId,
        context,
      });
    }

    if (st) {
      if (!ok) {
        const code = asString(params?.errorCode || 'ACK_FAILED');
        const msg = asString(params?.errorMessage || 'ack failed');
        st.error = `${code}:${msg}`;
        if (stage === 'chunk' && chunkIndex != null) st.failedChunks.set(chunkIndex, st.error);
        if (stage === 'complete') {
          st.status = 'aborted';
          st.terminalAt = now();
        }
      } else {
        if (stage === 'chunk' && chunkIndex != null) {
          st.ackedChunks.add(chunkIndex);
          st.status = 'transferring';
        }
        if (stage === 'complete') {
          st.status = 'completed';
          st.terminalAt = now();
          st.completedPath = asString(params?.path || '').trim() || st.completedPath;
        }
      }
      this.fileSendTransfers.set(transferId, st);
    }

    // 唤醒等待中的 chunk/complete ACK
    this.resolveFileAck({
      transferId,
      stage,
      chunkIndex: chunkIndex != null ? chunkIndex : undefined,
      payload: {
        ok,
        transferId,
        stage,
        path: asString(params?.path || '').trim(),
        errorCode: asString(params?.errorCode || ''),
        errorMessage: asString(params?.errorMessage || ''),
      },
      ok,
    });

    respond(
      true,
      staleObserved.stale
        ? {
            ok: true,
            transferId,
            stage,
            state: st?.status || 'late',
            stale: true,
            staleAccepted: true,
          }
        : {
            ok: true,
            transferId,
            stage,
            state: st?.status || 'late',
          },
    );
  };

  handleInbound = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    // Structure note (inbound-driven flush nudge):
    // Inbound acceptance is another explicit wake source for outbound draining. It should stay
    // separate from retry policy so later refactors can reason clearly about "new inbound signal"
    // versus "scheduled retry" versus "ACK-driven continuation".
    await this.syncDebugFlag();
    const parsed = parseBncrInboundParams(params);
    const { accountId, platform, route, msgType, msgId, peer, extracted } = parsed;
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
    const outboundReady = (params as any)?.outboundReady === true;
    const preferredForOutbound = (params as any)?.preferredForOutbound === true;
    const inboundOnly = (params as any)?.inboundOnly === true;
    if (
      this.shouldIgnoreStaleEvent({
        kind: 'inbound',
        payload: params ?? {},
        accountId,
        connId,
        clientId,
      })
    ) {
      respond(
        true,
        buildInboundResponsePayload({
          kind: 'stale-ignored',
          accountId,
          msgId: msgId ?? null,
        }),
      );
      return;
    }
    this.refreshLiveConnectionState({
      accountId,
      connId,
      clientId,
      outboundReady,
      preferredForOutbound,
      inboundOnly,
      context,
    });
    this.logInfo(
      'inbound',
      `lifecycle ${JSON.stringify(
        buildInboundAcceptedLifecycleDebugInfo({
          stage: 'accepted',
          bridge: this.bridgeId,
          accountId,
          connId,
          clientId,
          outboundReady,
          preferredForOutbound,
          inboundOnly,
          onlineAfterSeen: this.isOnline(accountId),
          recentInboundReachable: this.hasRecentInboundReachability(accountId),
          activeConnectionKey: this.activeConnectionByAccount.get(accountId) || null,
          activeConnections: Array.from(this.connections.values())
            .filter((c) => c.accountId === accountId)
            .map((c) => ({
              connId: c.connId,
              clientId: c.clientId,
              connectedAt: c.connectedAt,
              lastSeenAt: c.lastSeenAt,
            })),
        }),
      )}`,
      { debugOnly: true },
    );
    this.lastInboundAtGlobal = now();
    this.incrementCounter(this.inboundEventsByAccount, accountId);

    const cfg = getOpenClawRuntimeConfig(this.api);
    const canonicalAgentId = this.ensureCanonicalAgentId({
      cfg,
      accountId,
      peer,
      channelId: CHANNEL_ID,
    });
    const acceptance = await this.prepareInboundAcceptance({ parsed, canonicalAgentId });
    if (!acceptance.ok) {
      respond(acceptance.status, acceptance.payload);
      return;
    }

    const { sessionKey, inboundText, hasMedia } = acceptance;
    this.logInfo(
      'inbound',
      JSON.stringify({
        accountId,
        msgId: msgId ?? null,
        platform,
        chatType: peer.kind,
        scope: formatDisplayScope(route),
        sessionKey,
        msgType,
        textLen: inboundText.length,
        textPreview: inboundText.slice(0, 120),
        hasMedia,
      }),
      { debugOnly: true },
    );
    this.logInboundSummary({
      accountId,
      route,
      msgType,
      text: inboundText,
      hasMedia,
    });

    respond(
      true,
      buildInboundResponsePayload({
        kind: 'accepted',
        accountId,
        sessionKey,
        msgId: msgId ?? null,
        taskKey: extracted.taskKey ?? null,
      }),
    );
    this.flushPushQueueBestEffort({
      accountId,
      trigger: OUTBOUND_FLUSH_TRIGGER.INBOUND,
      reason: OUTBOUND_FLUSH_REASON.INBOUND_ACCEPTED,
    });

    void dispatchBncrInbound({
      api: this.api,
      channelId: CHANNEL_ID,
      cfg,
      parsed,
      canonicalAgentId,
      rememberSessionRoute: (sessionKey, accountId, route) =>
        this.rememberSessionRoute(sessionKey, accountId, route),
      enqueueFromReply: (args) => this.enqueueFromReply(args),
      setInboundActivity: (accountId, at) => {
        this.lastInboundByAccount.set(accountId, at);
        this.markActivity(accountId, at);
      },
      scheduleSave: () => this.scheduleSave(),
      logger: {
        warn: (msg: string) => emitBncrLogLine('warn', msg),
        error: (msg: string) => emitBncrLogLine('error', msg),
      },
    }).catch((err) => {
      this.logError('inbound', `process failed: ${String(err)}`, { debugOnly: true });
    });
  };

  channelStartAccount = async (ctx: any) => {
    await startBncrStatusWorker(this.buildStatusWorkerRuntime(), ctx);
  };

  channelStopAccount = async (ctx: any) => {
    await stopBncrStatusWorker(this.buildStatusWorkerRuntime(), ctx);
  };

  private logChannelSendEntry(args: {
    kind: 'text' | 'media';
    accountId: string;
    to: string;
    ctx: any;
    payload: {
      text: string;
      mediaUrl: string;
      mediaUrls?: string[];
      asVoice?: boolean;
      audioAsVoice?: boolean;
    };
  }) {
    this.logInfo(
      'outbound',
      `send-entry:${args.kind} ${JSON.stringify({
        accountId: args.accountId,
        to: args.to,
        text: args.payload.text,
        mediaUrl: args.payload.mediaUrl,
        mediaUrls: args.payload.mediaUrls,
        asVoice: args.payload.asVoice,
        audioAsVoice: args.payload.audioAsVoice,
        sessionKey: asString(args.ctx?.sessionKey || ''),
        mirrorSessionKey: asString(args.ctx?.mirror?.sessionKey || ''),
        rawCtx: {
          to: args.ctx?.to,
          accountId: args.ctx?.accountId,
          threadId: args.ctx?.threadId,
          replyToId: args.ctx?.replyToId,
        },
      })}`,
      { debugOnly: true },
    );
  }

  private resolveChannelSendReplyToId(ctx: any) {
    return asString(ctx?.replyToId || ctx?.replyToMessageId || '').trim() || undefined;
  }

  channelSendText = async (ctx: any) => {
    await this.syncDebugFlag();
    const accountId = normalizeAccountId(ctx.accountId);
    const to = asString(ctx.to || '').trim();
    const replyToId = this.resolveChannelSendReplyToId(ctx);

    this.logChannelSendEntry({
      kind: 'text',
      accountId,
      to,
      ctx,
      payload: {
        text: asString(ctx?.text || ''),
        mediaUrl: asString(ctx?.mediaUrl || ''),
      },
    });

    return sendBncrText({
      channelId: CHANNEL_ID,
      accountId,
      to,
      text: asString(ctx.text || ''),
      kind: ctx?.kind,
      replyToId,
      mediaLocalRoots: ctx.mediaLocalRoots,
      resolveVerifiedTarget: (to, accountId) => this.resolveVerifiedTarget(to, accountId),
      rememberSessionRoute: (sessionKey, accountId, route) =>
        this.rememberSessionRoute(sessionKey, accountId, route),
      enqueueFromReply: (args) => this.enqueueFromReply(args),
      createMessageId: () => randomUUID(),
    });
  };

  channelSendMedia = async (ctx: any) => {
    await this.syncDebugFlag();
    const accountId = normalizeAccountId(ctx.accountId);
    const to = asString(ctx.to || '').trim();
    const asVoice = ctx?.asVoice === true;
    const audioAsVoice = ctx?.audioAsVoice === true;
    const replyToId = this.resolveChannelSendReplyToId(ctx);

    this.logChannelSendEntry({
      kind: 'media',
      accountId,
      to,
      ctx,
      payload: {
        text: asString(ctx?.text || ''),
        mediaUrl: asString(ctx?.mediaUrl || ''),
        mediaUrls: Array.isArray(ctx?.mediaUrls) ? ctx.mediaUrls : undefined,
        asVoice,
        audioAsVoice,
      },
    });

    return sendBncrMedia({
      channelId: CHANNEL_ID,
      accountId,
      to,
      text: asString(ctx.text || ''),
      mediaUrl: asString(ctx.mediaUrl || ''),
      mediaUrls: Array.isArray(ctx?.mediaUrls) ? ctx.mediaUrls : undefined,
      asVoice,
      audioAsVoice,
      kind: ctx?.kind,
      replyToId,
      mediaLocalRoots: ctx.mediaLocalRoots,
      resolveVerifiedTarget: (to, accountId) => this.resolveVerifiedTarget(to, accountId),
      rememberSessionRoute: (sessionKey, accountId, route) =>
        this.rememberSessionRoute(sessionKey, accountId, route),
      enqueueFromReply: (args) => this.enqueueFromReply(args),
      createMessageId: () => randomUUID(),
    });
  };

  private async enqueueChannelMessageHandoff(ctx: any, payload: ReplyPayloadInput) {
    const accountId = normalizeAccountId(ctx.accountId);
    const to = asString(ctx.to || '').trim();
    const verified = this.resolveVerifiedTarget(to, accountId);
    this.rememberSessionRoute(verified.sessionKey, accountId, verified.route);
    const before = new Set(this.outbox.keys());
    await this.enqueueFromReply({
      accountId,
      sessionKey: verified.sessionKey,
      route: verified.route,
      payload,
      mediaLocalRoots: ctx.mediaLocalRoots,
    });
    const entries = Array.from(this.outbox.values()).filter(
      (entry) => !before.has(entry.messageId),
    );
    if (!entries.length) {
      throw new Error('bncr channel.message handoff did not enqueue an outbox entry');
    }
    return entries[entries.length - 1];
  }

  channelMessageSendText = async (ctx: any) => {
    const entry = await this.enqueueChannelMessageHandoff(ctx, {
      text: asString(ctx.text || ''),
      kind: ctx?.kind,
      replyToId: this.resolveChannelSendReplyToId(ctx),
    });
    return buildBncrDurableQueuedResult({ entry });
  };

  channelMessageSendMedia = async (ctx: any) => {
    const entry = await this.enqueueChannelMessageHandoff(ctx, {
      text: asString(ctx.text || ''),
      mediaUrl: asString(ctx.mediaUrl || ''),
      mediaUrls: Array.isArray(ctx?.mediaUrls) ? ctx.mediaUrls : undefined,
      asVoice: ctx?.asVoice === true,
      audioAsVoice: ctx?.audioAsVoice === true,
      kind: ctx?.kind,
      replyToId: this.resolveChannelSendReplyToId(ctx),
    });
    return buildBncrDurableQueuedResult({ entry });
  };

  channelMessageSendPayload = async (ctx: any) => {
    const payload = ctx?.payload || {};
    if (!payload || typeof payload !== 'object') {
      throw new Error('bncr channel.message payload must be an object');
    }
    const entry = await this.enqueueChannelMessageHandoff(ctx, {
      text: asString(payload.text || payload.message || payload.caption || ''),
      mediaUrl: asString(payload.mediaUrl || ''),
      mediaUrls: Array.isArray(payload.mediaUrls) ? payload.mediaUrls : undefined,
      asVoice: payload.asVoice === true,
      audioAsVoice: payload.audioAsVoice === true,
      kind: payload.kind,
      replyToId:
        asString(payload.replyToId || ctx?.replyToId || ctx?.replyToMessageId || '').trim() ||
        undefined,
    });
    return buildBncrDurableQueuedResult({ entry });
  };
}

export function createBncrBridge(api: OpenClawPluginApi) {
  return new BncrBridgeRuntime(api);
}

export function createBncrChannelPlugin(getBridge: () => BncrBridgeRuntime) {
  const messageActions: ChannelMessageActionAdapter = {
    describeMessageTool: ({ cfg }) => {
      const channelCfg = cfg?.channels?.[CHANNEL_ID];
      const hasExplicitConfiguredAccount =
        Boolean(channelCfg && typeof channelCfg === 'object') &&
        resolveBncrChannelPolicy(channelCfg).enabled !== false &&
        Boolean(channelCfg.accounts && typeof channelCfg.accounts === 'object') &&
        Object.keys(channelCfg.accounts).some(
          (accountId) => resolveAccount(cfg, accountId).enabled !== false,
        );

      const runtimeBridge = getBridge();
      const hasConnectedRuntime = listAccountIds(cfg).some((accountId) => {
        const resolved = resolveAccount(cfg, accountId);
        const runtime = runtimeBridge.getAccountRuntimeSnapshot(resolved.accountId);
        return Boolean(runtime?.connected);
      });

      if (!hasExplicitConfiguredAccount && !hasConnectedRuntime) {
        return null;
      }

      return {
        actions: ['send'],
        capabilities: [],
      };
    },
    supportsAction: ({ action }) => action === 'send',
    extractToolSend: ({ args }) => extractOpenClawToolSend(args, 'sendMessage'),
    handleAction: async ({ action, params, accountId, mediaLocalRoots }) => {
      if (action !== 'send')
        throw new Error(`Action ${action} is not supported for provider ${CHANNEL_ID}.`);
      const normalized = normalizeBncrSendParams({ params, accountId });

      const runtimeBridge = getBridge();
      const result = normalized.mediaUrl
        ? await sendBncrMedia({
            channelId: CHANNEL_ID,
            accountId: normalized.accountId,
            to: normalized.to,
            text: normalized.caption,
            mediaUrl: normalized.mediaUrl,
            asVoice: normalized.asVoice,
            audioAsVoice: normalized.audioAsVoice,
            mediaLocalRoots,
            resolveVerifiedTarget: (to, accountId) =>
              runtimeBridge.resolveVerifiedTarget(to, accountId),
            rememberSessionRoute: (sessionKey, accountId, route) =>
              runtimeBridge.rememberSessionRoute(sessionKey, accountId, route),
            enqueueFromReply: (args) => runtimeBridge.enqueueFromReply(args as any),
            createMessageId: () => randomUUID(),
          })
        : await sendBncrText({
            channelId: CHANNEL_ID,
            accountId: normalized.accountId,
            to: normalized.to,
            text: normalized.message,
            mediaLocalRoots,
            resolveVerifiedTarget: (to, accountId) =>
              runtimeBridge.resolveVerifiedTarget(to, accountId),
            rememberSessionRoute: (sessionKey, accountId, route) =>
              runtimeBridge.rememberSessionRoute(sessionKey, accountId, route),
            enqueueFromReply: (args) => runtimeBridge.enqueueFromReply(args as any),
            createMessageId: () => randomUUID(),
          });

      return openClawJsonResult({ ok: true, ...result });
    },
  };

  const plugin = {
    id: CHANNEL_ID,
    meta: BNCR_CHANNEL_META,
    actions: messageActions,
    message: {
      receive: BNCR_MESSAGE_RECEIVE_POLICY,
      send: createBncrMessageSend(getBridge),
    },
    capabilities: BNCR_CHANNEL_CAPABILITIES,
    messaging: createBncrMessagingSurface(getBridge),
    configSchema: BncrConfigSchema,
    config: BNCR_CONFIG_SURFACE,
    setup: BNCR_SETUP_SURFACE,
    outbound: createBncrOutboundRuntime(getBridge),
    status: createBncrStatusSurface(getBridge),
    gatewayMethods: BNCR_GATEWAY_METHODS,
    gateway: createBncrGatewayRuntime(getBridge),
  };

  return plugin;
}
