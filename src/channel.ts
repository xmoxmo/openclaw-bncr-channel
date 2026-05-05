import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readBooleanParam } from 'openclaw/plugin-sdk/boolean-param';
import type {
  GatewayRequestHandlerOptions,
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from 'openclaw/plugin-sdk/core';
import {
  applyAccountNameToChannelSection,
  jsonResult,
  setAccountEnabledInConfigSection,
} from 'openclaw/plugin-sdk/core';
import { readJsonFileWithFallback, writeJsonFileAtomically } from 'openclaw/plugin-sdk/json-store';
import { readStringParam } from 'openclaw/plugin-sdk/param-readers';
import { createDefaultChannelRuntimeState } from 'openclaw/plugin-sdk/status-helpers';
import { extractToolSend } from 'openclaw/plugin-sdk/tool-send';
import {
  BNCR_DEFAULT_ACCOUNT_ID,
  CHANNEL_ID,
  listAccountIds,
  normalizeAccountId,
  resolveAccount,
  resolveDefaultDisplayName,
} from './core/accounts.ts';
import { BncrConfigSchema } from './core/config-schema.ts';
import { emitBncrLog, emitBncrLogLine } from './core/logging.ts';
import { buildBncrPermissionSummary } from './core/permissions.ts';
import { resolveBncrChannelPolicy } from './core/policy.ts';
import { probeBncrAccount } from './core/probe.ts';
import {
  buildAccountRuntimeSnapshot,
  buildIntegratedDiagnostics as buildIntegratedDiagnosticsFromRuntime,
  buildStatusHeadlineFromRuntime,
  buildStatusMetaFromRuntime,
} from './core/status.ts';
import {
  buildCanonicalBncrSessionKey,
  formatDisplayScope,
  formatTargetDisplay,
  isLowerHex,
  normalizeInboundSessionKey,
  normalizeStoredSessionKey,
  parseExplicitTarget,
  parseRouteFromDisplayScope,
  parseRouteFromHexScope,
  parseRouteFromScope,
  parseRouteLike,
  parseStrictBncrSessionKey,
  routeKey,
  routeScopeToHex,
  withTaskSessionKey,
} from './core/targets.ts';
import type { BncrConnection, BncrRoute, OutboxEntry } from './core/types.ts';
import { dispatchBncrInbound } from './messaging/inbound/dispatch.ts';
import { checkBncrMessageGate } from './messaging/inbound/gate.ts';
import { parseBncrInboundParams } from './messaging/inbound/parse.ts';
import {
  deleteBncrMessageAction,
  editBncrMessageAction,
  reactBncrMessageAction,
  sendBncrReplyAction,
} from './messaging/outbound/actions.ts';
import {
  buildBncrMediaOutboundFrame,
  resolveBncrOutboundMessageType,
} from './messaging/outbound/media.ts';
import { sendBncrMedia, sendBncrText } from './messaging/outbound/send.ts';
import { resolveBncrOutboundSessionRoute } from './messaging/outbound/session-route.ts';
import {
  looksLikeBncrExplicitTarget,
  resolveBncrOutboundTarget,
} from './messaging/outbound/target-resolver.ts';
const BRIDGE_VERSION = 2;
const BNCR_PUSH_EVENT = 'plugin.bncr.push';
const BNCR_FILE_INIT_EVENT = 'plugin.bncr.file.init';
const BNCR_FILE_CHUNK_EVENT = 'plugin.bncr.file.chunk';
const BNCR_FILE_COMPLETE_EVENT = 'plugin.bncr.file.complete';
const BNCR_FILE_ABORT_EVENT = 'plugin.bncr.file.abort';
const CONNECT_TTL_MS = 120_000;
const RECENT_INBOUND_SEND_WINDOW_MS = 60_000;
const MAX_RETRY = 10;
const PUSH_DRAIN_INTERVAL_MS = 500;
const PUSH_ACK_TIMEOUT_MS = 30_000;
const FILE_FORCE_CHUNK = true; // 统一走 WS 分块，保留 base64 仅作兜底
const FILE_INLINE_THRESHOLD = 5 * 1024 * 1024; // fallback 阈值（仅 FILE_FORCE_CHUNK=false 时生效）
const FILE_CHUNK_SIZE = 256 * 1024; // 256KB
const FILE_CHUNK_RETRY = 3;
const FILE_ACK_TIMEOUT_MS = 30_000;
const FILE_TRANSFER_ACK_TTL_MS = 30_000;
const FILE_TRANSFER_KEEP_MS = 6 * 60 * 60 * 1000;
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
  error?: string;
};

type FileAckPayloadState = {
  payload: Record<string, unknown>;
  ok: boolean;
  at: number;
};

type ChatType = 'direct' | 'group' | (string & {});

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
  const to = readStringParam(paramsObj, 'to', { required: true });
  const resolvedAccountId = normalizeAccountId(
    readStringParam(paramsObj, 'accountId') ?? input.accountId,
  );

  const message = readStringParam(paramsObj, 'message', { allowEmpty: true }) ?? '';
  const caption = readStringParam(paramsObj, 'caption', { allowEmpty: true }) ?? '';
  const mediaUrl =
    readStringParam(paramsObj, 'media', { trim: false }) ??
    readStringParam(paramsObj, 'path', { trim: false }) ??
    readStringParam(paramsObj, 'filePath', { trim: false }) ??
    readStringParam(paramsObj, 'mediaUrl', { trim: false });
  const asVoice = readBooleanParam(paramsObj, 'asVoice') ?? false;
  const audioAsVoice = readBooleanParam(paramsObj, 'audioAsVoice') ?? false;

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
  private channelAccountTimers = new Map<string, NodeJS.Timeout>();
  private canonicalAgentId: string | null = null;
  private canonicalAgentSource: 'startup' | 'runtime' | 'fallback-main' | null = null;
  private canonicalAgentResolvedAt: number | null = null;

  // 内置健康/回归计数（替代独立脚本）
  private startedAt = now();
  private connectEventsByAccount = new Map<string, number>();
  private inboundEventsByAccount = new Map<string, number>();
  private activityEventsByAccount = new Map<string, number>();
  private ackEventsByAccount = new Map<string, number>();

  private saveTimer: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private pushDrainRunningAccounts = new Set<string>();
  private messageAckWaiters = new Map<
    string,
    {
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
      resolve: (payload: Record<string, unknown>) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private earlyFileAcks = new Map<string, FileAckPayloadState>();

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
    const msg = (entry.payload as any)?.message || {};
    const type = asString(msg.type || (entry.payload as any)?.type || 'unknown');
    const text = asString(msg.msg || '');
    const preview = this.summarizeTextPreview(text);
    this.logInfo('outbound', [type, this.summarizeScope(entry.route), preview].join('|'));
  }

  private clearChannelAccountWorker(accountId: string, reason: string) {
    const timer = this.channelAccountTimers.get(accountId);
    if (!timer) return false;
    clearInterval(timer);
    this.channelAccountTimers.delete(accountId);
    this.logInfo(
      'health',
      `status-worker cleared ${JSON.stringify({ bridge: this.bridgeId, accountId, reason })}`,
      { debugOnly: true },
    );
    return true;
  }

  private classifyRegisterTrace(stack: string) {
    if (
      stack.includes('prepareSecretsRuntimeSnapshot') ||
      stack.includes('resolveRuntimeWebTools') ||
      stack.includes('resolvePluginWebSearchProviders')
    ) {
      return 'runtime/webtools';
    }
    if (stack.includes('startGatewayServer') || stack.includes('loadGatewayPlugins')) {
      return 'gateway/startup';
    }
    if (stack.includes('resolvePluginImplicitProviders')) {
      return 'provider/discovery/implicit';
    }
    if (stack.includes('resolvePluginDiscoveryProviders')) {
      return 'provider/discovery/discovery';
    }
    if (stack.includes('resolvePluginProviders')) {
      return 'provider/discovery/providers';
    }
    return 'other';
  }

  private dominantRegisterBucket(sourceBuckets: Record<string, number>) {
    let winner: string | null = null;
    let winnerCount = -1;
    for (const [bucket, count] of Object.entries(sourceBuckets)) {
      if (count > winnerCount) {
        winner = bucket;
        winnerCount = count;
      }
    }
    return winner;
  }

  private captureDriftSnapshot(
    summary: ReturnType<BncrBridgeRuntime['buildRegisterTraceSummary']>,
  ) {
    this.lastDriftSnapshot = {
      capturedAt: now(),
      registerCount: this.registerCount,
      apiGeneration: this.apiGeneration,
      postWarmupRegisterCount: summary.postWarmupRegisterCount,
      apiInstanceId: this.lastApiInstanceId,
      registryFingerprint: this.lastRegistryFingerprint,
      dominantBucket: summary.dominantBucket,
      sourceBuckets: { ...summary.sourceBuckets },
      traceWindowSize: this.registerTraceRecent.length,
      traceRecent: this.registerTraceRecent.map((trace) => ({ ...trace })),
    };
    this.scheduleSave();
  }

  private buildRegisterTraceSummary() {
    const buckets: Record<string, number> = {};
    let warmupCount = 0;
    let postWarmupCount = 0;
    let unexpectedRegisterAfterWarmup = false;
    let lastUnexpectedRegisterAt: number | null = null;
    const baseline = this.firstRegisterAt;

    for (const trace of this.registerTraceRecent) {
      buckets[trace.stackBucket] = (buckets[trace.stackBucket] || 0) + 1;
      const isWarmup = baseline != null && trace.ts - baseline <= REGISTER_WARMUP_WINDOW_MS;
      if (isWarmup) {
        warmupCount += 1;
      } else {
        postWarmupCount += 1;
        unexpectedRegisterAfterWarmup = true;
        lastUnexpectedRegisterAt = trace.ts;
      }
    }

    const dominantBucket = this.dominantRegisterBucket(buckets);
    const likelyRuntimeRegistryDrift = postWarmupCount > 0;
    const likelyStartupFanoutOnly = warmupCount > 0 && postWarmupCount === 0;

    return {
      startupWindowMs: REGISTER_WARMUP_WINDOW_MS,
      traceWindowSize: this.registerTraceRecent.length,
      sourceBuckets: buckets,
      dominantBucket,
      warmupRegisterCount: warmupCount,
      postWarmupRegisterCount: postWarmupCount,
      unexpectedRegisterAfterWarmup,
      lastUnexpectedRegisterAt,
      likelyRuntimeRegistryDrift,
      likelyStartupFanoutOnly,
    };
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
    const stackBucket = this.classifyRegisterTrace(stack);

    const trace = {
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
      stackBucket,
    };
    this.registerTraceRecent.push(trace);
    if (this.registerTraceRecent.length > 12)
      this.registerTraceRecent.splice(0, this.registerTraceRecent.length - 12);

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
    if (!leaseId && connectionEpoch == null) return { stale: false, reason: 'missing' as const };
    const staleByLease =
      !!leaseId && this.primaryLeaseId != null && leaseId !== this.primaryLeaseId;
    const staleByEpoch =
      connectionEpoch != null &&
      this.connectionEpoch > 0 &&
      connectionEpoch !== this.connectionEpoch;
    const stale = staleByLease || staleByEpoch;
    if (!stale) return { stale: false, reason: 'ok' as const };
    this.staleCounters.lastStaleAt = now();
    switch (kind) {
      case 'connect':
        this.staleCounters.staleConnect += 1;
        break;
      case 'inbound':
        this.staleCounters.staleInbound += 1;
        break;
      case 'activity':
        this.staleCounters.staleActivity += 1;
        break;
      case 'ack':
        this.staleCounters.staleAck += 1;
        break;
      case 'file.init':
        this.staleCounters.staleFileInit += 1;
        break;
      case 'file.chunk':
        this.staleCounters.staleFileChunk += 1;
        break;
      case 'file.complete':
        this.staleCounters.staleFileComplete += 1;
        break;
      case 'file.abort':
        this.staleCounters.staleFileAbort += 1;
        break;
    }
    this.logWarn(
      'stale',
      `observed kind=${kind} lease=${leaseId || '-'} epoch=${connectionEpoch ?? '-'} currentLease=${this.primaryLeaseId || '-'} currentEpoch=${this.connectionEpoch}`,
      { debugOnly: true },
    );
    return { stale: true, reason: 'mismatch' as const };
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
    const sameConn = !!params.ownerConnId && params.ownerConnId === params.connId;
    const sameClient =
      !params.ownerConnId &&
      !!params.ownerClientId &&
      !!params.clientId &&
      params.ownerClientId === params.clientId;
    return sameConn || sameClient;
  }

  private buildExtendedDiagnostics(accountId: string) {
    const diagnostics = this.buildIntegratedDiagnostics(accountId) as Record<string, any>;
    return {
      ...diagnostics,
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
        traceRecent: this.registerTraceRecent.slice(),
        traceSummary: this.buildRegisterTraceSummary(),
        lastDriftSnapshot: this.lastDriftSnapshot,
      },
      connection: {
        active: this.activeConnectionCount(accountId),
        primaryLeaseId: this.primaryLeaseId,
        primaryEpoch: this.connectionEpoch || null,
        acceptedConnections: this.acceptedConnections,
        lastConnectAt: this.lastConnectAt,
        lastDisconnectAt: this.lastDisconnectAt,
        lastActivityAt: this.lastActivityAtGlobal,
        lastInboundAt: this.lastInboundAtGlobal,
        lastAckAt: this.lastAckAtGlobal,
        recent: Array.from(this.recentConnections.entries()).map(([leaseId, entry]) => ({
          leaseId,
          epoch: entry.epoch,
          connectedAt: entry.connectedAt,
          lastActivityAt: entry.lastActivityAt,
          isPrimary: entry.isPrimary,
        })),
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
      stale: { ...this.staleCounters },
    };
  }

  isDebugEnabled(): boolean {
    return BNCR_DEBUG_VERBOSE;
  }

  startService = async (ctx: OpenClawPluginServiceContext, debug?: boolean) => {
    this.statePath = path.join(ctx.stateDir, 'bncr-bridge-state.json');
    await this.loadState();
    try {
      const cfg = this.api.runtime.config.current();
      this.initializeCanonicalAgentId(cfg);
    } catch {
      // ignore startup canonical agent initialization errors
    }
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
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    await this.flushState();
    this.logInfo('debug', 'service stopped', { debugOnly: true });
  };

  shutdown() {
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
    }
    this.messageAckWaiters.clear();
    for (const waiter of this.fileAckWaiters.values()) {
      clearTimeout(waiter.timer);
    }
    this.fileAckWaiters.clear();
    this.earlyFileAcks.clear();
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
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
      const cfg = this.api.runtime.config.current();
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
      const resolved = this.api.runtime.channel.routing.resolveAgentRoute({
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
    this.canonicalAgentSource = 'startup';
    this.canonicalAgentResolvedAt = now();
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
      this.canonicalAgentSource = 'runtime';
      this.canonicalAgentResolvedAt = now();
      return agentId;
    }

    this.canonicalAgentId = 'main';
    this.canonicalAgentSource = 'fallback-main';
    this.canonicalAgentResolvedAt = now();
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
    const acc = normalizeAccountId(accountId);
    return buildIntegratedDiagnosticsFromRuntime({
      accountId: acc,
      connected: this.isOnline(acc),
      pending: Array.from(this.outbox.values()).filter((v) => v.accountId === acc).length,
      deadLetter: this.deadLetter.filter((v) => v.accountId === acc).length,
      activeConnections: this.activeConnectionCount(acc),
      connectEvents: this.getCounter(this.connectEventsByAccount, acc),
      inboundEvents: this.getCounter(this.inboundEventsByAccount, acc),
      activityEvents: this.getCounter(this.activityEventsByAccount, acc),
      ackEvents: this.getCounter(this.ackEventsByAccount, acc),
      startedAt: this.startedAt,
      lastSession: this.lastSessionByAccount.get(acc) || null,
      lastActivityAt: this.lastActivityByAccount.get(acc) || null,
      lastInboundAt: this.lastInboundByAccount.get(acc) || null,
      lastOutboundAt: this.lastOutboundByAccount.get(acc) || null,
      sessionRoutesCount: Array.from(this.sessionRoutes.values()).filter((v) => v.accountId === acc)
        .length,
      invalidOutboxSessionKeys: this.countInvalidOutboxSessionKeys(acc),
      legacyAccountResidue: this.countLegacyAccountResidue(acc),
      channelRoot: path.join(process.cwd(), 'plugins', 'bncr'),
    });
  }

  private async loadState() {
    if (!this.statePath) return;
    const loaded = await readJsonFileWithFallback(this.statePath, {
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
        createdAt: Number(entry.createdAt || now()),
        retryCount: Number(entry.retryCount || 0),
        nextAttemptAt: Number(entry.nextAttemptAt || now()),
        lastAttemptAt: entry.lastAttemptAt ? Number(entry.lastAttemptAt) : undefined,
        lastError: entry.lastError ? asString(entry.lastError) : undefined,
      };

      this.outbox.set(migratedEntry.messageId, migratedEntry);
    }

    this.deadLetter = [];
    for (const entry of Array.isArray(data.deadLetter) ? data.deadLetter : []) {
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
        createdAt: Number(entry.createdAt || now()),
        retryCount: Number(entry.retryCount || 0),
        nextAttemptAt: Number(entry.nextAttemptAt || now()),
        lastAttemptAt: entry.lastAttemptAt ? Number(entry.lastAttemptAt) : undefined,
        lastError: entry.lastError ? asString(entry.lastError) : undefined,
      });
    }

    this.sessionRoutes.clear();
    this.routeAliases.clear();
    for (const item of data.sessionRoutes || []) {
      const normalized = normalizeStoredSessionKey(
        asString(item?.sessionKey || ''),
        this.canonicalAgentId,
      );
      if (!normalized) continue;

      const route = parseRouteLike(item?.route) || normalized.route;
      const accountId = normalizeAccountId(item?.accountId);
      const updatedAt = Number(item?.updatedAt || now());

      const info = {
        accountId,
        route,
        updatedAt,
      };

      this.sessionRoutes.set(normalized.sessionKey, info);
      this.routeAliases.set(routeKey(accountId, route), info);
    }

    this.lastSessionByAccount.clear();
    for (const item of data.lastSessionByAccount || []) {
      const accountId = normalizeAccountId(item?.accountId);
      const normalized = normalizeStoredSessionKey(
        asString(item?.sessionKey || ''),
        this.canonicalAgentId,
      );
      const updatedAt = Number(item?.updatedAt || 0);
      if (!normalized || !Number.isFinite(updatedAt) || updatedAt <= 0) continue;

      this.lastSessionByAccount.set(accountId, {
        sessionKey: normalized.sessionKey,
        // 展示统一为 Bncr-platform:group:user
        scope: formatDisplayScope(normalized.route),
        updatedAt,
      });
    }

    this.lastActivityByAccount.clear();
    for (const item of data.lastActivityByAccount || []) {
      const accountId = normalizeAccountId(item?.accountId);
      const updatedAt = Number(item?.updatedAt || 0);
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) continue;
      this.lastActivityByAccount.set(accountId, updatedAt);
    }

    this.lastInboundByAccount.clear();
    for (const item of data.lastInboundByAccount || []) {
      const accountId = normalizeAccountId(item?.accountId);
      const updatedAt = Number(item?.updatedAt || 0);
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) continue;
      this.lastInboundByAccount.set(accountId, updatedAt);
    }

    this.lastOutboundByAccount.clear();
    for (const item of data.lastOutboundByAccount || []) {
      const accountId = normalizeAccountId(item?.accountId);
      const updatedAt = Number(item?.updatedAt || 0);
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) continue;
      this.lastOutboundByAccount.set(accountId, updatedAt);
    }

    this.lastDriftSnapshot =
      data.lastDriftSnapshot && typeof data.lastDriftSnapshot === 'object'
        ? {
            capturedAt: Number((data.lastDriftSnapshot as any).capturedAt || 0),
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
            traceWindowSize: Number((data.lastDriftSnapshot as any).traceWindowSize || 0),
            traceRecent: Array.isArray((data.lastDriftSnapshot as any).traceRecent)
              ? [...((data.lastDriftSnapshot as any).traceRecent as Array<Record<string, unknown>>)]
              : [],
          }
        : null;

    // 兼容旧状态文件：若尚未持久化 lastSession*/lastActivity*，从 sessionRoutes 回填。
    if (this.lastSessionByAccount.size === 0 && this.sessionRoutes.size > 0) {
      for (const [sessionKey, info] of this.sessionRoutes.entries()) {
        const acc = normalizeAccountId(info.accountId);
        const updatedAt = Number(info.updatedAt || 0);
        if (!Number.isFinite(updatedAt) || updatedAt <= 0) continue;

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
      .slice(-1000);

    const data: PersistedState = {
      outbox: Array.from(this.outbox.values()),
      deadLetter: this.deadLetter.slice(-1000),
      sessionRoutes,
      lastSessionByAccount: Array.from(this.lastSessionByAccount.entries()).map(
        ([accountId, v]) => ({
          accountId,
          sessionKey: v.sessionKey,
          scope: v.scope,
          updatedAt: v.updatedAt,
        }),
      ),
      lastActivityByAccount: Array.from(this.lastActivityByAccount.entries()).map(
        ([accountId, updatedAt]) => ({
          accountId,
          updatedAt,
        }),
      ),
      lastInboundByAccount: Array.from(this.lastInboundByAccount.entries()).map(
        ([accountId, updatedAt]) => ({
          accountId,
          updatedAt,
        }),
      ),
      lastOutboundByAccount: Array.from(this.lastOutboundByAccount.entries()).map(
        ([accountId, updatedAt]) => ({
          accountId,
          updatedAt,
        }),
      ),
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

    await writeJsonFileAtomically(this.statePath, data);
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
    if (context) this.gatewayContext = context;
  }

  private resolveOutboxPushOwner(accountId: string): BncrConnection | null {
    const acc = normalizeAccountId(accountId);
    const t = now();
    const primaryKey = this.activeConnectionByAccount.get(acc);
    if (!primaryKey) return null;
    const primary = this.connections.get(primaryKey);
    if (!primary?.connId) return null;
    if (t - primary.lastSeenAt > CONNECT_TTL_MS) return null;
    return primary;
  }

  private resolvePushConnIds(accountId: string): Set<string> {
    const acc = normalizeAccountId(accountId);
    const t = now();
    const connIds = new Set<string>();

    const primaryKey = this.activeConnectionByAccount.get(acc);
    if (primaryKey) {
      const primary = this.connections.get(primaryKey);
      if (primary?.connId && t - primary.lastSeenAt <= CONNECT_TTL_MS) {
        connIds.add(primary.connId);
      }
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
    const t = now();
    const lastInboundAt = this.lastInboundByAccount.get(acc) || 0;
    const lastActivityAt = this.lastActivityByAccount.get(acc) || 0;
    const lastReachableAt = Math.max(lastInboundAt, lastActivityAt);
    return lastReachableAt > 0 && t - lastReachableAt <= RECENT_INBOUND_SEND_WINDOW_MS;
  }

  private resolveRecentInboundConnIds(accountId: string): Set<string> {
    const acc = normalizeAccountId(accountId);
    const t = now();
    const connIds = new Set<string>();
    if (!this.hasRecentInboundReachability(acc)) return connIds;

    for (const c of this.connections.values()) {
      if (c.accountId !== acc) continue;
      if (!c.connId) continue;
      if (t - c.lastSeenAt > CONNECT_TTL_MS * 2) continue;
      connIds.add(c.connId);
    }

    return connIds;
  }

  private isRecentlyReachableConn(accountId: string, connId?: string, clientId?: string): boolean {
    const acc = normalizeAccountId(accountId);
    const cid = asString(connId || '').trim();
    const client = asString(clientId || '').trim() || undefined;
    if (!cid) return false;

    const recentConnIds = this.resolveRecentInboundConnIds(acc);
    if (recentConnIds.has(cid)) return true;

    const activeKey = this.activeConnectionByAccount.get(acc);
    if (!activeKey) return false;
    const active = this.connections.get(activeKey);
    if (!active?.connId) return false;
    if (active.connId !== cid) return false;
    if (client && active.clientId && active.clientId !== client) return false;
    return true;
  }

  private tryAdoptTransferOwner(args: {
    accountId: string;
    transfer:
      | FileSendTransferState
      | FileRecvTransferState
      | undefined;
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
    const messageId = randomUUID();
    return {
      messageId,
      accountId: normalizeAccountId(params.accountId),
      sessionKey: params.sessionKey,
      route: params.route,
      payload: {
        type: 'message.outbound',
        sessionKey: params.sessionKey,
        _meta: {
          kind: 'file-transfer',
          mediaUrl: params.mediaUrl,
          mediaLocalRoots: params.mediaLocalRoots ? Array.from(params.mediaLocalRoots) : undefined,
          text: asString(params.text || ''),
          asVoice: params.asVoice === true,
          audioAsVoice: params.audioAsVoice === true,
          finalEvent: BNCR_PUSH_EVENT,
          replyToId: asString(params.replyToId || '').trim() || undefined,
          messageKind: params.kind,
        },
      },
      createdAt: now(),
      retryCount: 0,
      nextAttemptAt: now(),
    };
  }

  private async tryPushEntry(entry: OutboxEntry): Promise<boolean> {
    const meta = isPlainObject(entry.payload?._meta) ? entry.payload._meta : null;
    if (meta?.kind === 'file-transfer') {
      const ctx = this.gatewayContext;
      if (!ctx) {
        entry.lastError = 'gateway context unavailable';
        this.outbox.set(entry.messageId, entry);
        this.logInfo(
          'outbox',
          `push-skip ${JSON.stringify({
            messageId: entry.messageId,
            accountId: entry.accountId,
            kind: 'file-transfer',
            reason: 'no-gateway-context',
          })}`,
          { debugOnly: true },
        );
        return false;
      }

      const owner = this.resolveOutboxPushOwner(entry.accountId);
      let connIds = owner?.connId
        ? new Set([owner.connId])
        : this.resolvePushConnIds(entry.accountId);
      const recentInboundReachable = this.hasRecentInboundReachability(entry.accountId);
      if (!connIds.size && recentInboundReachable) {
        connIds = this.resolveRecentInboundConnIds(entry.accountId);
      }
      if (!connIds.size) {
        entry.lastError = 'no active bncr client for file chunk transfer';
        this.outbox.set(entry.messageId, entry);
        this.logInfo(
          'outbox',
          `push-skip ${JSON.stringify({
            messageId: entry.messageId,
            accountId: entry.accountId,
            kind: 'file-transfer',
            reason: 'no-active-connection',
            recentInboundReachable,
          })}`,
          { debugOnly: true },
        );
        return false;
      }

      const mediaUrl = asString(meta.mediaUrl || '').trim();
      if (!mediaUrl) {
        entry.lastError = 'file transfer mediaUrl missing';
        this.outbox.set(entry.messageId, entry);
        this.logInfo(
          'outbox',
          `push-fail ${JSON.stringify({
            messageId: entry.messageId,
            accountId: entry.accountId,
            kind: 'file-transfer',
            error: entry.lastError,
          })}`,
          { debugOnly: true },
        );
        return false;
      }

      try {
        const media = await this.transferMediaToBncrClient({
          accountId: entry.accountId,
          sessionKey: entry.sessionKey,
          route: entry.route,
          mediaUrl,
          mediaLocalRoots: Array.isArray(meta.mediaLocalRoots)
            ? meta.mediaLocalRoots.filter((v): v is string => typeof v === 'string')
            : undefined,
        });
        const wantsVoice = meta.asVoice === true || meta.audioAsVoice === true;
        const frame = buildBncrMediaOutboundFrame({
          messageId: entry.messageId,
          sessionKey: entry.sessionKey,
          route: entry.route,
          media,
          mediaUrl,
          mediaMsg: asString(meta.text || ''),
          fileName: resolveOutboundFileName({
            mediaUrl,
            fileName: media.fileName,
            mimeType: media.mimeType,
          }),
          hintedType: wantsVoice ? 'voice' : undefined,
          kind:
            meta.messageKind === 'tool' ||
            meta.messageKind === 'block' ||
            meta.messageKind === 'final'
              ? meta.messageKind
              : undefined,
          replyToId: asString(meta.replyToId || '').trim() || undefined,
          now: now(),
        });

        ctx.broadcastToConnIds(
          BNCR_PUSH_EVENT,
          {
            ...frame,
            idempotencyKey: entry.messageId,
          },
          connIds,
        );
        entry.lastPushAt = now();
        entry.lastPushConnId =
          owner?.connId || (connIds.size === 1 ? Array.from(connIds)[0] : undefined);
        entry.lastPushClientId = owner?.clientId;
        entry.lastError = undefined;
        this.outbox.set(entry.messageId, entry);
        this.lastOutboundByAccount.set(entry.accountId, entry.lastPushAt);
        this.markActivity(entry.accountId, entry.lastPushAt);
        this.scheduleSave();
        this.logInfo(
          'outbox',
          `push-ok ${JSON.stringify({
            messageId: entry.messageId,
            accountId: entry.accountId,
            kind: 'file-transfer',
            connIds: Array.from(connIds),
            ownerConnId: entry.lastPushConnId || '',
            ownerClientId: entry.lastPushClientId || '',
            recentInboundReachable,
            event: BNCR_PUSH_EVENT,
          })}`,
          { debugOnly: true },
        );
        return true;
      } catch (error) {
        entry.lastError = asString((error as any)?.message || error || 'file-transfer-error');
        this.outbox.set(entry.messageId, entry);
        this.scheduleSave();
        this.logInfo(
          'outbox',
          `push-fail ${JSON.stringify({
            messageId: entry.messageId,
            accountId: entry.accountId,
            kind: 'file-transfer',
            retryable: this.isRetryableFileTransferError(error),
            error: entry.lastError,
          })}`,
          { debugOnly: true },
        );
        if (!this.isRetryableFileTransferError(error)) {
          this.moveToDeadLetter(entry, entry.lastError || 'file-transfer-failed');
        }
        return false;
      }
    }

    const ctx = this.gatewayContext;
    if (!ctx) {
      this.logInfo(
        'outbox',
        `push-skip ${JSON.stringify({
          messageId: entry.messageId,
          accountId: entry.accountId,
          reason: 'no-gateway-context',
        })}`,
        { debugOnly: true },
      );
      return false;
    }

    const owner = this.resolveOutboxPushOwner(entry.accountId);
    let connIds = owner?.connId
      ? new Set([owner.connId])
      : this.resolvePushConnIds(entry.accountId);
    const recentInboundReachable = this.hasRecentInboundReachability(entry.accountId);
    if (!connIds.size && recentInboundReachable) {
      connIds = this.resolveRecentInboundConnIds(entry.accountId);
    }
    if (!connIds.size) {
      this.logInfo(
        'outbox',
        `push-skip ${JSON.stringify({
          messageId: entry.messageId,
          accountId: entry.accountId,
          reason: 'no-active-connection',
          recentInboundReachable,
        })}`,
        { debugOnly: true },
      );
      return false;
    }

    try {
      const payload = {
        ...entry.payload,
        idempotencyKey: entry.messageId,
      };

      ctx.broadcastToConnIds(BNCR_PUSH_EVENT, payload, connIds);
      entry.lastPushAt = now();
      entry.lastPushConnId =
        owner?.connId || (connIds.size === 1 ? Array.from(connIds)[0] : undefined);
      entry.lastPushClientId = owner?.clientId;
      this.outbox.set(entry.messageId, entry);
      this.logInfo(
        'outbox',
        `push-ok ${JSON.stringify({
          messageId: entry.messageId,
          accountId: entry.accountId,
          connIds: Array.from(connIds),
          ownerConnId: entry.lastPushConnId || '',
          ownerClientId: entry.lastPushClientId || '',
          recentInboundReachable,
          event: BNCR_PUSH_EVENT,
        })}`,
        { debugOnly: true },
      );
      this.lastOutboundByAccount.set(entry.accountId, entry.lastPushAt);
      this.markActivity(entry.accountId, entry.lastPushAt);
      this.scheduleSave();
      return true;
    } catch (error) {
      entry.lastError = asString((error as any)?.message || error || 'push-error');
      this.outbox.set(entry.messageId, entry);
      this.logInfo(
        'outbox',
        `push-fail ${JSON.stringify({
          messageId: entry.messageId,
          accountId: entry.accountId,
          error: entry.lastError,
        })}`,
        { debugOnly: true },
      );
      return false;
    }
  }

  private schedulePushDrain(delayMs = 0) {
    if (this.pushTimer) return;
    const delay = Math.max(0, Math.min(Number(delayMs || 0), 30_000));
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.flushPushQueue();
    }, delay);
  }

  private isOutboundAckRequired(accountId?: string) {
    try {
      const cfg = this.api.runtime.config.current();
      const channelCfg = (cfg as any)?.channels?.[CHANNEL_ID];
      const accountCfg =
        accountId && channelCfg?.accounts && typeof channelCfg.accounts === 'object'
          ? (channelCfg.accounts as Record<string, any>)[normalizeAccountId(accountId)]
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

  private buildRuntimeFlags(accountId?: string) {
    let ackPolicySource: 'channel' | 'default' = 'default';
    try {
      const cfg = this.api.runtime.config.current();
      const global = (cfg as any)?.channels?.[CHANNEL_ID]?.outboundRequireAck;
      if (typeof global === 'boolean') ackPolicySource = 'channel';
    } catch {
      // keep default source
    }
    return {
      outboundRequireAck: this.isOutboundAckRequired(accountId),
      ackPolicySource,
      messageAckTimeoutMs: PUSH_ACK_TIMEOUT_MS,
      fileAckTimeoutMs: FILE_ACK_TIMEOUT_MS,
      debugVerbose: BNCR_DEBUG_VERBOSE,
    };
  }

  private async flushPushQueue(accountId?: string): Promise<void> {
    const filterAcc = accountId ? normalizeAccountId(accountId) : null;
    const targetAccounts = filterAcc
      ? [filterAcc]
      : Array.from(
          new Set(
            Array.from(this.outbox.values()).map((entry) => normalizeAccountId(entry.accountId)),
          ),
        );
    this.logInfo(
      'outbox',
      `flush ${JSON.stringify({
        bridge: this.bridgeId,
        accountId: filterAcc,
        targetAccounts,
        outboxSize: this.outbox.size,
      })}`,
      { debugOnly: true },
    );

    let globalNextDelay: number | null = null;

    for (const acc of targetAccounts) {
      if (!acc || this.pushDrainRunningAccounts.has(acc)) continue;
      const online = this.isOnline(acc);
      const recentInboundReachable = this.hasRecentInboundReachability(acc);
      this.logInfo(
        'outbox',
        `online ${JSON.stringify({
          bridge: this.bridgeId,
          accountId: acc,
          online,
          recentInboundReachable,
          connections: Array.from(this.connections.values()).map((c) => ({
            accountId: c.accountId,
            connId: c.connId,
            clientId: c.clientId,
            lastSeenAt: c.lastSeenAt,
          })),
        })}`,
        { debugOnly: true },
      );
      this.pushDrainRunningAccounts.add(acc);
      try {
        let localNextDelay: number | null = null;

        while (true) {
          const t = now();
          const entries = Array.from(this.outbox.values())
            .filter((entry) => normalizeAccountId(entry.accountId) === acc)
            .sort((a, b) => a.createdAt - b.createdAt);

          if (!entries.length) break;

          const entry = entries.find((item) => item.nextAttemptAt <= t);
          if (!entry) {
            const wait = Math.max(0, entries[0].nextAttemptAt - t);
            localNextDelay = localNextDelay == null ? wait : Math.min(localNextDelay, wait);
            break;
          }

          const onlineNow = this.isOnline(acc) || this.hasRecentInboundReachability(acc);
          const pushed = await this.tryPushEntry(entry);
          if (pushed) {
            const requireAck = this.isOutboundAckRequired(acc);
            let ackResult: 'acked' | 'timeout' = requireAck ? 'timeout' : 'acked';
            if (onlineNow && requireAck) {
              ackResult = await this.waitForMessageAck(entry.messageId, PUSH_ACK_TIMEOUT_MS);
            }

            this.logInfo(
              'outbox',
              `ack ${JSON.stringify({
                messageId: entry.messageId,
                accountId: entry.accountId,
                requireAck,
                ackResult,
                onlineNow,
              })}`,
              { debugOnly: true },
            );

            if (!this.outbox.has(entry.messageId)) {
              await this.sleepMs(PUSH_DRAIN_INTERVAL_MS);
              continue;
            }

            if (onlineNow && (!requireAck || ackResult !== 'timeout')) {
              await this.sleepMs(PUSH_DRAIN_INTERVAL_MS);
              continue;
            }

            entry.retryCount += 1;
            entry.lastAttemptAt = now();
            if (entry.retryCount > MAX_RETRY) {
              this.moveToDeadLetter(
                entry,
                entry.lastError || (requireAck ? 'push-ack-timeout' : 'push-delivery-unconfirmed'),
              );
              continue;
            }
            entry.nextAttemptAt = now() + backoffMs(entry.retryCount);
            entry.lastError = requireAck ? 'push-ack-timeout' : 'push-delivery-unconfirmed';
            this.outbox.set(entry.messageId, entry);
            this.scheduleSave();

            const wait = Math.max(0, entry.nextAttemptAt - now());
            localNextDelay = localNextDelay == null ? wait : Math.min(localNextDelay, wait);
            await this.sleepMs(PUSH_DRAIN_INTERVAL_MS);
            break;
          }

          if (!this.outbox.has(entry.messageId)) {
            await this.sleepMs(PUSH_DRAIN_INTERVAL_MS);
            continue;
          }

          const nextAttempt = entry.retryCount + 1;
          if (nextAttempt > MAX_RETRY) {
            this.moveToDeadLetter(entry, entry.lastError || 'push-retry-limit');
            continue;
          }

          entry.retryCount = nextAttempt;
          entry.lastAttemptAt = t;
          entry.nextAttemptAt = t + backoffMs(nextAttempt);
          entry.lastError = entry.lastError || 'push-retry';
          this.outbox.set(entry.messageId, entry);
          this.scheduleSave();

          const wait = Math.max(0, entry.nextAttemptAt - t);
          localNextDelay = localNextDelay == null ? wait : Math.min(localNextDelay, wait);
          break;
        }

        if (localNextDelay != null) {
          globalNextDelay =
            globalNextDelay == null ? localNextDelay : Math.min(globalNextDelay, localNextDelay);
        }
      } finally {
        this.pushDrainRunningAccounts.delete(acc);
      }
    }

    if (globalNextDelay != null) this.schedulePushDrain(globalNextDelay);
  }

  private async waitForMessageAck(messageId: string, waitMs: number): Promise<'acked' | 'timeout'> {
    const key = asString(messageId).trim();
    const timeoutMs = Math.max(0, Math.min(waitMs, 25_000));
    if (!key || !timeoutMs) return 'timeout';

    return await new Promise<'acked' | 'timeout'>((resolve) => {
      const timer = setTimeout(() => {
        this.messageAckWaiters.delete(key);
        resolve('timeout');
      }, timeoutMs);

      this.messageAckWaiters.set(key, { resolve, timer });
    });
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
    for (const [id, st] of this.fileSendTransfers.entries()) {
      if (t - st.startedAt > FILE_TRANSFER_KEEP_MS) this.fileSendTransfers.delete(id);
    }
    for (const [id, st] of this.fileRecvTransfers.entries()) {
      if (t - st.startedAt > FILE_TRANSFER_KEEP_MS) this.fileRecvTransfers.delete(id);
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
    const previousActiveConn = previousActiveKey ? this.connections.get(previousActiveKey) || null : null;

    const nextConn: BncrConnection = {
      accountId: acc,
      connId,
      clientId: asString(clientId || '').trim() || undefined,
      connectedAt: prev?.connectedAt || t,
      lastSeenAt: t,
    };

    this.connections.set(key, nextConn);
    this.logInfo(
      'connection',
      `seen ${JSON.stringify({
        bridge: this.bridgeId,
        accountId: acc,
        connId,
        clientId: nextConn.clientId,
        connectedAt: nextConn.connectedAt,
        lastSeenAt: nextConn.lastSeenAt,
      })}`,
      { debugOnly: true },
    );

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
            })),
        })}`,
        { debugOnly: true },
      );
      return;
    }

    const curConn = this.connections.get(current);
    if (
      !curConn ||
      t - curConn.lastSeenAt > CONNECT_TTL_MS ||
      nextConn.connectedAt >= curConn.connectedAt
    ) {
      this.activeConnectionByAccount.set(acc, key);
      this.logInfo(
        'connection',
        `seen:promote ${JSON.stringify({
          bridge: this.bridgeId,
          accountId: acc,
          reason: !curConn
            ? 'current-missing'
            : t - curConn.lastSeenAt > CONNECT_TTL_MS
              ? 'current-stale'
              : 'newer-or-equal-connectedAt',
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
            })),
        })}`,
        { debugOnly: true },
      );
    }
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
        cfg: this.api.runtime.config?.get?.() || {},
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
    const idx = Number.isFinite(Number(chunkIndex)) ? String(Number(chunkIndex)) : '-';
    return `${transferId}|${stage}|${idx}`;
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
    const timeoutMs = Math.max(
      1_000,
      Math.min(Number(params.timeoutMs || FILE_ACK_TIMEOUT_MS), 120_000),
    );

    const cached = this.earlyFileAcks.get(key);
    if (cached) {
      this.earlyFileAcks.delete(key);
      this.logInfo(
        'file-ack-cache-hit',
        JSON.stringify({
          bridge: this.bridgeId,
          transferId,
          stage,
          chunkIndex:
            Number.isFinite(Number(params.chunkIndex)) ? Number(params.chunkIndex) : undefined,
          key,
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

    this.logInfo(
      'file-ack-wait',
      JSON.stringify({
        bridge: this.bridgeId,
        transferId,
        stage,
        chunkIndex:
          Number.isFinite(Number(params.chunkIndex)) ? Number(params.chunkIndex) : undefined,
        key,
        timeoutMs,
      }),
      { debugOnly: true },
    );

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fileAckWaiters.delete(key);
        this.logWarn(
          'file-ack-timeout',
          JSON.stringify({
            bridge: this.bridgeId,
            transferId,
            stage,
            chunkIndex:
              Number.isFinite(Number(params.chunkIndex)) ? Number(params.chunkIndex) : undefined,
            key,
            timeoutMs,
          }),
          { debugOnly: true },
        );
        reject(new Error(`file ack timeout: ${key}`));
      }, timeoutMs);
      this.fileAckWaiters.set(key, { resolve, reject, timer });
    });
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
    const waiter = this.fileAckWaiters.get(key);
    if (!waiter) {
      this.earlyFileAcks.set(key, {
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
          chunkIndex:
            Number.isFinite(Number(params.chunkIndex)) ? Number(params.chunkIndex) : undefined,
          key,
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
        chunkIndex:
          Number.isFinite(Number(params.chunkIndex)) ? Number(params.chunkIndex) : undefined,
        key,
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

  private pushFileEventToAccount(
    accountId: string,
    event: string,
    payload: Record<string, unknown>,
  ) {
    const connIds = this.resolvePushConnIds(accountId);
    if (!connIds.size || !this.gatewayContext) {
      throw new Error(`no active bncr connection for account=${accountId}`);
    }
    const normalizedEvent =
      event === 'bncr.file.init'
        ? BNCR_FILE_INIT_EVENT
        : event === 'bncr.file.chunk'
          ? BNCR_FILE_CHUNK_EVENT
          : event === 'bncr.file.complete'
            ? BNCR_FILE_COMPLETE_EVENT
            : event === 'bncr.file.abort'
              ? BNCR_FILE_ABORT_EVENT
              : event;
    this.gatewayContext.broadcastToConnIds(normalizedEvent, payload, connIds);
  }

  private resolveInboundFileType(mimeType: string, fileName: string): string {
    const mt = asString(mimeType).toLowerCase();
    const fn = asString(fileName).toLowerCase();
    if (mt.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(fn)) return 'image';
    if (mt.startsWith('video/') || /\.(mp4|mov|mkv|avi|webm)$/.test(fn)) return 'video';
    if (mt.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/.test(fn)) return 'audio';
    return mt || 'file';
  }

  private resolveInboundFilesDir(): string {
    const dir = path.join(process.cwd(), '.openclaw', 'media', 'inbound', 'bncr');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async materializeRecvTransfer(
    st: FileRecvTransferState,
  ): Promise<{ path: string; fileSha256: string }> {
    const dir = this.resolveInboundFilesDir();
    const safeName = asString(st.fileName).trim() || `${st.transferId}.bin`;
    const finalPath = path.join(dir, safeName);

    const ordered: Buffer[] = [];
    for (let i = 0; i < st.totalChunks; i++) {
      const chunk = st.bufferByChunk.get(i);
      if (!chunk) throw new Error(`missing chunk ${i}`);
      ordered.push(chunk);
    }
    const merged = Buffer.concat(ordered);
    if (Number(st.fileSize || 0) > 0 && merged.length !== Number(st.fileSize || 0)) {
      throw new Error(`size mismatch expected=${st.fileSize} got=${merged.length}`);
    }

    const sha = createHash('sha256').update(merged).digest('hex');
    if (st.fileSha256 && sha !== st.fileSha256) {
      throw new Error(`sha256 mismatch expected=${st.fileSha256} got=${sha}`);
    }

    fs.writeFileSync(finalPath, merged);
    return { path: finalPath, fileSha256: sha };
  }

  private buildStatusMeta(accountId: string) {
    const acc = normalizeAccountId(accountId);
    return buildStatusMetaFromRuntime({
      accountId: acc,
      connected: this.isOnline(acc),
      pending: Array.from(this.outbox.values()).filter((v) => v.accountId === acc).length,
      deadLetter: this.deadLetter.filter((v) => v.accountId === acc).length,
      activeConnections: this.activeConnectionCount(acc),
      connectEvents: this.getCounter(this.connectEventsByAccount, acc),
      inboundEvents: this.getCounter(this.inboundEventsByAccount, acc),
      activityEvents: this.getCounter(this.activityEventsByAccount, acc),
      ackEvents: this.getCounter(this.ackEventsByAccount, acc),
      startedAt: this.startedAt,
      lastSession: this.lastSessionByAccount.get(acc) || null,
      lastActivityAt: this.lastActivityByAccount.get(acc) || null,
      lastInboundAt: this.lastInboundByAccount.get(acc) || null,
      lastOutboundAt: this.lastOutboundByAccount.get(acc) || null,
      sessionRoutesCount: Array.from(this.sessionRoutes.values()).filter((v) => v.accountId === acc)
        .length,
      invalidOutboxSessionKeys: this.countInvalidOutboxSessionKeys(acc),
      legacyAccountResidue: this.countLegacyAccountResidue(acc),
      channelRoot: path.join(process.cwd(), 'plugins', 'bncr'),
    });
  }

  getAccountRuntimeSnapshot(accountId: string) {
    const acc = normalizeAccountId(accountId);
    return buildAccountRuntimeSnapshot({
      accountId: acc,
      connected: this.isOnline(acc),
      pending: Array.from(this.outbox.values()).filter((v) => v.accountId === acc).length,
      deadLetter: this.deadLetter.filter((v) => v.accountId === acc).length,
      activeConnections: this.activeConnectionCount(acc),
      connectEvents: this.getCounter(this.connectEventsByAccount, acc),
      inboundEvents: this.getCounter(this.inboundEventsByAccount, acc),
      activityEvents: this.getCounter(this.activityEventsByAccount, acc),
      ackEvents: this.getCounter(this.ackEventsByAccount, acc),
      startedAt: this.startedAt,
      lastSession: this.lastSessionByAccount.get(acc) || null,
      lastActivityAt: this.lastActivityByAccount.get(acc) || null,
      lastInboundAt: this.lastInboundByAccount.get(acc) || null,
      lastOutboundAt: this.lastOutboundByAccount.get(acc) || null,
      sessionRoutesCount: Array.from(this.sessionRoutes.values()).filter((v) => v.accountId === acc)
        .length,
      invalidOutboxSessionKeys: this.countInvalidOutboxSessionKeys(acc),
      legacyAccountResidue: this.countLegacyAccountResidue(acc),
      running: true,
      channelRoot: path.join(process.cwd(), 'plugins', 'bncr'),
    });
  }

  private buildStatusHeadline(accountId: string): string {
    const acc = normalizeAccountId(accountId);
    return buildStatusHeadlineFromRuntime({
      accountId: acc,
      connected: this.isOnline(acc),
      pending: Array.from(this.outbox.values()).filter((v) => v.accountId === acc).length,
      deadLetter: this.deadLetter.filter((v) => v.accountId === acc).length,
      activeConnections: this.activeConnectionCount(acc),
      connectEvents: this.getCounter(this.connectEventsByAccount, acc),
      inboundEvents: this.getCounter(this.inboundEventsByAccount, acc),
      activityEvents: this.getCounter(this.activityEventsByAccount, acc),
      ackEvents: this.getCounter(this.ackEventsByAccount, acc),
      startedAt: this.startedAt,
      lastSession: this.lastSessionByAccount.get(acc) || null,
      lastActivityAt: this.lastActivityByAccount.get(acc) || null,
      lastInboundAt: this.lastInboundByAccount.get(acc) || null,
      lastOutboundAt: this.lastOutboundByAccount.get(acc) || null,
      sessionRoutesCount: Array.from(this.sessionRoutes.values()).filter((v) => v.accountId === acc)
        .length,
      invalidOutboxSessionKeys: this.countInvalidOutboxSessionKeys(acc),
      legacyAccountResidue: this.countLegacyAccountResidue(acc),
      channelRoot: path.join(process.cwd(), 'plugins', 'bncr'),
    });
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
    const msg = (entry.payload as any)?.message || {};
    const type = asString(msg.type || (entry.payload as any)?.type || 'unknown');
    const text = asString(msg.msg || '');
    const displayScope = formatDisplayScope(entry.route);
    this.logInfo(
      'outbound',
      JSON.stringify({
        bridge: this.bridgeId,
        messageId: entry.messageId,
        accountId: entry.accountId,
        sessionKey: entry.sessionKey,
        scope: displayScope,
        type,
        textLen: text.length,
        textPreview: text.slice(0, 120),
      }),
      { debugOnly: true },
    );
    this.logOutboundSummary(entry);
    this.outbox.set(entry.messageId, entry);
    this.scheduleSave();
    this.flushPushQueue(entry.accountId);
  }

  private moveToDeadLetter(entry: OutboxEntry, reason: string) {
    const dead: OutboxEntry = {
      ...entry,
      lastError: reason,
    };
    this.deadLetter.push(dead);
    if (this.deadLetter.length > 1000) this.deadLetter = this.deadLetter.slice(-1000);
    this.outbox.delete(entry.messageId);
    this.resolveMessageAck(entry.messageId, 'timeout');
    this.scheduleSave();
  }

  private collectDue(accountId: string, maxBatch: number): Array<Record<string, unknown>> {
    const due: Array<Record<string, unknown>> = [];
    const t = now();
    const key = normalizeAccountId(accountId);

    for (const entry of this.outbox.values()) {
      if (entry.accountId !== key) continue;
      if (entry.nextAttemptAt > t) continue;

      const nextAttempt = entry.retryCount + 1;
      if (nextAttempt > MAX_RETRY) {
        this.moveToDeadLetter(entry, 'retry-limit');
        continue;
      }

      entry.retryCount = nextAttempt;
      entry.lastAttemptAt = t;
      entry.nextAttemptAt = t + backoffMs(nextAttempt);
      this.outbox.set(entry.messageId, entry);

      due.push({
        ...entry.payload,
        _meta: {
          retryCount: entry.retryCount,
          nextAttemptAt: entry.nextAttemptAt,
        },
      });

      if (due.length >= maxBatch) break;
    }

    if (due.length) this.scheduleSave();
    return due;
  }

  private async payloadMediaToBase64(
    mediaUrl: string,
    mediaLocalRoots?: readonly string[],
  ): Promise<{ mediaBase64: string; mimeType?: string; fileName?: string }> {
    const loaded = await this.api.runtime.media.loadWebMedia(mediaUrl, {
      localRoots: mediaLocalRoots,
      maxBytes: 20 * 1024 * 1024,
    });
    return {
      mediaBase64: loaded.buffer.toString('base64'),
      mimeType: loaded.contentType,
      fileName: loaded.fileName,
    };
  }

  private async sleepMs(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
  }

  private waitChunkAck(params: {
    transferId: string;
    chunkIndex: number;
    timeoutMs?: number;
  }): Promise<void> {
    const { transferId, chunkIndex } = params;
    const timeoutMs = Math.max(
      1_000,
      Math.min(Number(params.timeoutMs || FILE_TRANSFER_ACK_TTL_MS), 60_000),
    );
    const started = now();

    return new Promise<void>((resolve, reject) => {
      const tick = async () => {
        const st = this.fileSendTransfers.get(transferId);
        if (!st) {
          reject(new Error('transfer state missing'));
          return;
        }
        if (st.failedChunks.has(chunkIndex)) {
          reject(new Error(st.failedChunks.get(chunkIndex) || `chunk ${chunkIndex} failed`));
          return;
        }
        if (st.ackedChunks.has(chunkIndex)) {
          resolve();
          return;
        }
        if (now() - started >= timeoutMs) {
          reject(new Error(`chunk ack timeout index=${chunkIndex}`));
          return;
        }
        await this.sleepMs(120);
        void tick();
      };
      void tick();
    });
  }

  private waitCompleteAck(params: {
    transferId: string;
    timeoutMs?: number;
  }): Promise<{ path: string }> {
    const { transferId } = params;
    const timeoutMs = Math.max(2_000, Math.min(Number(params.timeoutMs || 60_000), 120_000));
    const started = now();

    return new Promise<{ path: string }>((resolve, reject) => {
      const tick = async () => {
        const st = this.fileSendTransfers.get(transferId);
        if (!st) {
          reject(new Error('transfer state missing'));
          return;
        }
        if (st.status === 'aborted') {
          reject(new Error(st.error || 'transfer aborted'));
          return;
        }
        if (st.status === 'completed' && st.completedPath) {
          resolve({ path: st.completedPath });
          return;
        }
        if (now() - started >= timeoutMs) {
          reject(new Error('complete ack timeout'));
          return;
        }
        await this.sleepMs(150);
        void tick();
      };
      void tick();
    });
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
    const loaded = await this.api.runtime.media.loadWebMedia(params.mediaUrl, {
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
    const directConnIds = this.resolvePushConnIds(params.accountId);
    const recentConnIds = recentInboundReachable
      ? this.resolveRecentInboundConnIds(params.accountId)
      : new Set<string>();
    const accountId = normalizeAccountId(params.accountId);
    const activeConnectionKey = this.activeConnectionByAccount.get(accountId) || null;
    const accountConnections = Array.from(this.connections.values())
      .filter((c) => c.accountId === accountId)
      .map((c) => ({
        connId: c.connId,
        clientId: c.clientId,
        connectedAt: c.connectedAt,
        lastSeenAt: c.lastSeenAt,
      }));
    this.logInfo(
      'file-chunk-diag',
      JSON.stringify({
        bridge: this.bridgeId,
        accountId,
        sessionKey: params.sessionKey,
        mediaUrl: params.mediaUrl,
        hasGatewayContext: Boolean(ctx),
        activeConnectionKey,
        ownerConnId: owner?.connId || null,
        ownerClientId: owner?.clientId || null,
        directConnIds: Array.from(directConnIds),
        recentInboundReachable,
        recentConnIds: Array.from(recentConnIds),
        accountConnections,
      }),
      { debugOnly: true },
    );
    if (!ctx) throw new Error('gateway context unavailable');

    let connIds = directConnIds;
    if (!connIds.size && recentInboundReachable) {
      connIds = recentConnIds;
    }
    if (!connIds.size) throw new Error('no active bncr client for file chunk transfer');

    const transferId = randomUUID();
    const chunkSize = 256 * 1024;
    const totalChunks = Math.ceil(size / chunkSize);
    const fileSha256 = createHash('sha256').update(loaded.buffer).digest('hex');

    this.logInfo(
      'file-transfer-start',
      JSON.stringify({
        bridge: this.bridgeId,
        transferId,
        accountId,
        sessionKey: params.sessionKey,
        mediaUrl: params.mediaUrl,
        fileName,
        mimeType,
        fileSize: size,
        chunkSize,
        totalChunks,
        connIds: Array.from(connIds),
        ownerConnId: owner?.connId || null,
        ownerClientId: owner?.clientId || null,
      }),
      { debugOnly: true },
    );

    const st: FileSendTransferState = {
      transferId,
      accountId: normalizeAccountId(params.accountId),
      sessionKey: params.sessionKey,
      route: params.route,
      fileName,
      mimeType: mimeType || 'application/octet-stream',
      fileSize: size,
      chunkSize,
      totalChunks,
      fileSha256,
      startedAt: now(),
      status: 'init',
      ackedChunks: new Set(),
      failedChunks: new Map(),
      ownerConnId: owner?.connId,
      ownerClientId: owner?.clientId,
    };
    this.fileSendTransfers.set(transferId, st);

    ctx.broadcastToConnIds(
      BNCR_FILE_INIT_EVENT,
      {
        transferId,
        direction: 'oc2bncr',
        sessionKey: params.sessionKey,
        platform: params.route.platform,
        groupId: params.route.groupId,
        userId: params.route.userId,
        fileName,
        mimeType,
        fileSize: size,
        chunkSize,
        totalChunks,
        fileSha256,
        ts: now(),
      },
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
          {
            transferId,
            chunkIndex: idx,
            offset: start,
            size: slice.byteLength,
            chunkSha256,
            base64: slice.toString('base64'),
            ts: now(),
          },
          connIds,
        );

        this.logInfo(
          'file-transfer-chunk-send',
          JSON.stringify({
            bridge: this.bridgeId,
            transferId,
            accountId,
            chunkIndex: idx,
            attempt,
            offset: start,
            size: slice.byteLength,
            connIds: Array.from(connIds),
          }),
          { debugOnly: true },
        );

        try {
          await this.waitChunkAck({
            transferId,
            chunkIndex: idx,
            timeoutMs: FILE_TRANSFER_ACK_TTL_MS,
          });
          this.logInfo(
            'file-transfer-chunk-ack',
            JSON.stringify({
              bridge: this.bridgeId,
              transferId,
              accountId,
              chunkIndex: idx,
              attempt,
            }),
            { debugOnly: true },
          );
          ok = true;
          break;
        } catch (err) {
          lastErr = err;
          this.logWarn(
            'file-transfer-chunk-ack-fail',
            JSON.stringify({
              bridge: this.bridgeId,
              transferId,
              accountId,
              chunkIndex: idx,
              attempt,
              error: asString((err as Error)?.message || err),
            }),
            { debugOnly: true },
          );
          await this.sleepMs(150 * attempt);
        }
      }

      if (!ok) {
        st.status = 'aborted';
        st.error = String((lastErr as any)?.message || lastErr || `chunk-${idx}-failed`);
        this.fileSendTransfers.set(transferId, st);
        ctx.broadcastToConnIds(
          BNCR_FILE_ABORT_EVENT,
          {
            transferId,
            reason: st.error,
            ts: now(),
          },
          connIds,
        );
        throw new Error(st.error);
      }
    }

    ctx.broadcastToConnIds(
      BNCR_FILE_COMPLETE_EVENT,
      {
        transferId,
        ts: now(),
      },
      connIds,
    );

    this.logInfo(
      'file-transfer-complete-send',
      JSON.stringify({
        bridge: this.bridgeId,
        transferId,
        accountId,
        connIds: Array.from(connIds),
      }),
      { debugOnly: true },
    );

    const done = await this.waitCompleteAck({ transferId, timeoutMs: 60_000 });

    this.logInfo(
      'file-transfer-complete-ack',
      JSON.stringify({
        bridge: this.bridgeId,
        transferId,
        accountId,
        payload: done,
      }),
      { debugOnly: true },
    );

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
    payload: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      asVoice?: boolean;
      audioAsVoice?: boolean;
      kind?: 'tool' | 'block' | 'final';
      replyToId?: string;
    };
    mediaLocalRoots?: readonly string[];
  }) {
    const { accountId, sessionKey, route, payload, mediaLocalRoots } = params;

    const mediaList = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];

    if (mediaList.length > 0) {
      let first = true;
      for (const mediaUrl of mediaList) {
        this.enqueueOutbound(
          this.buildFileTransferOutboxEntry({
            accountId,
            sessionKey,
            route,
            mediaUrl,
            mediaLocalRoots,
            text: first ? asString(payload.text || '') : '',
            asVoice: payload.asVoice,
            audioAsVoice: payload.audioAsVoice,
            kind: payload.kind,
            replyToId: asString(payload.replyToId || '').trim() || undefined,
          }),
        );
        first = false;
      }
      return;
    }

    const text = asString(payload.text || '').trim();
    if (!text) return;

    const messageId = randomUUID();
    const frame = {
      type: 'message.outbound',
      messageId,
      idempotencyKey: messageId,
      sessionKey,
      replyToId: asString(payload.replyToId || '').trim() || undefined,
      message: {
        platform: route.platform,
        groupId: route.groupId,
        userId: route.userId,
        type: 'text',
        kind: payload.kind,
        msg: text,
        path: '',
        base64: '',
        fileName: '',
      },
      ts: now(),
    };

    this.enqueueOutbound({
      messageId,
      accountId: normalizeAccountId(accountId),
      sessionKey,
      route,
      payload: frame,
      createdAt: now(),
      retryCount: 0,
      nextAttemptAt: now(),
    });
  }

  handleConnect = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    await this.syncDebugFlag();
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;

    this.logInfo(
      'connection',
      `connect ${JSON.stringify({
        bridge: this.bridgeId,
        accountId,
        connId,
        clientId,
        hasContext: Boolean(context),
      })}`,
      { debugOnly: true },
    );

    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);
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
    this.flushPushQueue(accountId);
  };

  handleAck = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    await this.syncDebugFlag();
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
      return;
    }

    const entry = this.outbox.get(messageId);
    if (!entry) {
      respond(true, { ok: true, message: 'already-acked-or-missing', stale: staleObserved.stale });
      return;
    }

    if (entry.accountId !== accountId) {
      respond(false, { error: 'account mismatch' });
      return;
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
        return;
      }
    } else {
      this.rememberGatewayContext(context);
      this.markSeen(accountId, connId, clientId);
    }
    this.lastAckAtGlobal = now();
    this.incrementCounter(this.ackEventsByAccount, accountId);

    const ok = params?.ok !== false;
    const fatal = params?.fatal === true;

    if (ok) {
      this.outbox.delete(messageId);
      this.scheduleSave();
      this.resolveMessageAck(messageId, 'acked');
      respond(
        true,
        staleObserved.stale ? { ok: true, stale: true, staleAccepted: true } : { ok: true },
      );
      this.flushPushQueue(accountId);
      return;
    }

    if (fatal) {
      this.moveToDeadLetter(entry, asString(params?.error || 'fatal-ack'));
      respond(
        true,
        staleObserved.stale
          ? { ok: true, movedToDeadLetter: true, stale: true, staleAccepted: true }
          : { ok: true, movedToDeadLetter: true },
      );
      return;
    }

    entry.nextAttemptAt = now() + 1_000;
    entry.lastError = asString(params?.error || 'retryable-ack');
    this.outbox.set(messageId, entry);
    this.scheduleSave();

    respond(
      true,
      staleObserved.stale
        ? { ok: true, willRetry: true, stale: true, staleAccepted: true }
        : { ok: true, willRetry: true },
    );
  };

  handleActivity = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    await this.syncDebugFlag();
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
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
        hasContext: Boolean(context),
      })}`,
      { debugOnly: true },
    );
    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);
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
    this.flushPushQueue(accountId);
  };

  handleDiagnostics = async ({ params, respond }: GatewayRequestHandlerOptions) => {
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const cfg = this.api.runtime.config.current();
    const runtime = this.getAccountRuntimeSnapshot(accountId);
    const diagnostics = this.buildExtendedDiagnostics(accountId);
    const permissions = buildBncrPermissionSummary(cfg ?? {});
    const probe = probeBncrAccount({
      accountId,
      connected: Boolean(runtime?.connected),
      pending: Number(runtime?.meta?.pending ?? 0),
      deadLetter: Number(runtime?.meta?.deadLetter ?? 0),
      activeConnections: this.activeConnectionCount(accountId),
      invalidOutboxSessionKeys: this.countInvalidOutboxSessionKeys(accountId),
      legacyAccountResidue: this.countLegacyAccountResidue(accountId),
      lastActivityAt: runtime?.meta?.lastActivityAt ?? null,
      structure: {
        coreComplete: true,
        inboundComplete: true,
        outboundComplete: true,
      },
    });

    respond(true, {
      channel: CHANNEL_ID,
      accountId,
      runtime,
      diagnostics,
      runtimeFlags: this.buildRuntimeFlags(accountId),
      waiters: {
        messageAck: this.messageAckWaiters.size,
        fileAck: this.fileAckWaiters.size,
      },
      permissions,
      probe,
      now: now(),
    });
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
    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);

    const transferId = asString(params?.transferId || '').trim();
    const sessionKey = asString(params?.sessionKey || '').trim();
    const fileName = asString(params?.fileName || '').trim() || 'file.bin';
    const mimeType = asString(params?.mimeType || '').trim() || 'application/octet-stream';
    const fileSize = Number(params?.fileSize || 0);
    const chunkSize = Number(params?.chunkSize || 256 * 1024);
    const totalChunks = Number(params?.totalChunks || 0);
    const fileSha256 = asString(params?.fileSha256 || '').trim();

    if (!transferId || !sessionKey || !fileSize || !chunkSize || !totalChunks) {
      respond(false, { error: 'transferId/sessionKey/fileSize/chunkSize/totalChunks required' });
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
    const chunkIndex = Number(params?.chunkIndex ?? -1);
    const offset = Number(params?.offset ?? 0);
    const size = Number(params?.size ?? 0);
    const chunkSha256 = asString(params?.chunkSha256 || '').trim();
    const base64 = asString(params?.base64 || '');

    if (!transferId || chunkIndex < 0 || !base64) {
      respond(false, { error: 'transferId/chunkIndex/base64 required' });
      return;
    }

    const st = this.fileRecvTransfers.get(transferId);
    if (!st) {
      respond(false, { error: 'transfer not found' });
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
      this.rememberGatewayContext(context);
      this.markSeen(accountId, connId, clientId);
      this.markActivity(accountId);
    }

    try {
      const buf = Buffer.from(base64, 'base64');
      if (size > 0 && buf.length !== size) {
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
      this.rememberGatewayContext(context);
      this.markSeen(accountId, connId, clientId);
      this.markActivity(accountId);
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

      const saved = await this.api.runtime.channel.media.saveMediaBuffer(
        merged,
        st.mimeType,
        'inbound',
        50 * 1024 * 1024,
        st.fileName,
      );
      st.completedPath = saved.path;
      st.status = 'completed';
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
      this.rememberGatewayContext(context);
      this.markSeen(accountId, connId, clientId);
      this.markActivity(accountId);
    }

    st.status = 'aborted';
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
    const chunkIndex = Number(params?.chunkIndex ?? -1);

    this.logInfo(
      'file-ack-inbound',
      JSON.stringify({
        bridge: this.bridgeId,
        accountId,
        connId,
        clientId: clientId || null,
        transferId,
        stage,
        ok,
        chunkIndex: chunkIndex >= 0 ? chunkIndex : undefined,
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
      this.rememberGatewayContext(context);
      this.markSeen(accountId, connId, clientId);
      this.markActivity(accountId);
    }

    if (st) {
      if (!ok) {
        const code = asString(params?.errorCode || 'ACK_FAILED');
        const msg = asString(params?.errorMessage || 'ack failed');
        st.error = `${code}:${msg}`;
        if (stage === 'chunk' && chunkIndex >= 0) st.failedChunks.set(chunkIndex, st.error);
        if (stage === 'complete') st.status = 'aborted';
      } else {
        if (stage === 'chunk' && chunkIndex >= 0) {
          st.ackedChunks.add(chunkIndex);
          st.status = 'transferring';
        }
        if (stage === 'complete') {
          st.status = 'completed';
          st.completedPath = asString(params?.path || '').trim() || st.completedPath;
        }
      }
      this.fileSendTransfers.set(transferId, st);
    }

    // 唤醒等待中的 chunk/complete ACK
    this.resolveFileAck({
      transferId,
      stage,
      chunkIndex: chunkIndex >= 0 ? chunkIndex : undefined,
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
    await this.syncDebugFlag();
    const parsed = parseBncrInboundParams(params);
    const {
      accountId,
      platform,
      groupId,
      userId,
      sessionKeyfromroute,
      route,
      text,
      msgType,
      mediaBase64,
      mediaPathFromTransfer,
      mimeType,
      fileName,
      msgId,
      dedupKey,
      peer,
      extracted,
    } = parsed;
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
    if (
      this.shouldIgnoreStaleEvent({
        kind: 'inbound',
        payload: params ?? {},
        accountId,
        connId,
        clientId,
      })
    ) {
      respond(true, {
        accepted: false,
        stale: true,
        ignored: true,
        accountId,
        msgId: msgId ?? null,
      });
      return;
    }
    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);
    this.logInfo(
      'inbound',
      `lifecycle ${JSON.stringify({
        stage: 'accepted',
        bridge: this.bridgeId,
        accountId,
        connId,
        clientId,
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
      })}`,
      { debugOnly: true },
    );
    this.lastInboundAtGlobal = now();
    this.incrementCounter(this.inboundEventsByAccount, accountId);

    if (!platform || (!userId && !groupId)) {
      respond(false, { error: 'platform/groupId/userId required' });
      return;
    }
    if (this.markInboundDedupSeen(dedupKey)) {
      respond(true, {
        accepted: true,
        duplicated: true,
        accountId,
        msgId: msgId ?? null,
      });
      return;
    }

    const cfg = this.api.runtime.config.current();
    const gate = checkBncrMessageGate({
      parsed,
      cfg,
      account: resolveAccount(cfg, accountId),
    });
    if (!gate.allowed) {
      respond(true, {
        accepted: false,
        accountId,
        msgId: msgId ?? null,
        reason: gate.reason,
      });
      return;
    }

    const canonicalAgentId = this.ensureCanonicalAgentId({
      cfg,
      accountId,
      peer,
      channelId: CHANNEL_ID,
    });
    const resolvedRoute = this.api.runtime.channel.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId,
      peer,
    });
    const baseSessionKey =
      normalizeInboundSessionKey(sessionKeyfromroute, route, canonicalAgentId) ||
      resolvedRoute.sessionKey;
    const taskSessionKey = withTaskSessionKey(baseSessionKey, extracted.taskKey);
    const sessionKey = taskSessionKey || baseSessionKey;
    const inboundText = asString(extracted.text || text || '');
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
        hasMedia: Boolean(mediaBase64 || mediaPathFromTransfer),
      }),
      { debugOnly: true },
    );
    this.logInboundSummary({
      accountId,
      route,
      msgType,
      text: inboundText,
      hasMedia: Boolean(mediaBase64 || mediaPathFromTransfer),
    });

    respond(true, {
      accepted: true,
      accountId,
      sessionKey,
      msgId: msgId ?? null,
      taskKey: extracted.taskKey ?? null,
    });
    this.flushPushQueue(accountId);

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
    const accountId = normalizeAccountId(ctx.accountId);
    this.clearChannelAccountWorker(accountId, 'start-replace');

    const tick = () => {
      const previous = ctx.getStatus?.() || {};
      const onlineByConn = this.isOnline(accountId);
      const recentInboundReachable = this.hasRecentInboundReachability(accountId);
      const connected = onlineByConn || recentInboundReachable;
      const lastActAt =
        this.lastActivityByAccount.get(accountId) ||
        this.lastInboundByAccount.get(accountId) ||
        this.lastOutboundByAccount.get(accountId) ||
        previous?.lastEventAt ||
        null;
      this.logInfo(
        'health',
        `status-tick ${JSON.stringify({
          bridge: this.bridgeId,
          accountId,
          connected,
          onlineByConn,
          recentInboundReachable,
          lastActivityAt: this.lastActivityByAccount.get(accountId) || null,
          lastInboundAt: this.lastInboundByAccount.get(accountId) || null,
          lastOutboundAt: this.lastOutboundByAccount.get(accountId) || null,
          chosenLastEventAt: lastActAt,
          activeConnectionKey: this.activeConnectionByAccount.get(accountId) || null,
          activeConnections: Array.from(this.connections.values())
            .filter((c) => c.accountId === accountId)
            .map((c) => ({
              connId: c.connId,
              clientId: c.clientId,
              connectedAt: c.connectedAt,
              lastSeenAt: c.lastSeenAt,
            })),
        })}`,
        { debugOnly: true },
      );

      ctx.setStatus?.({
        ...previous,
        accountId,
        running: true,
        connected,
        lastEventAt: lastActAt,
        // 状态映射：在线=linked，离线=configured
        mode: connected ? 'linked' : 'configured',
        lastError: previous?.lastError ?? null,
        meta: this.buildStatusMeta(accountId),
      });
    };

    tick();
    const timer = setInterval(tick, 5_000);
    this.channelAccountTimers.set(accountId, timer);

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (reason: string) => {
        if (settled) return;
        settled = true;
        const activeTimer = this.channelAccountTimers.get(accountId);
        if (activeTimer === timer) {
          clearInterval(timer);
          this.channelAccountTimers.delete(accountId);
        } else {
          clearInterval(timer);
        }
        this.logInfo(
          'health',
          `status-worker finished ${JSON.stringify({ bridge: this.bridgeId, accountId, reason })}`,
          { debugOnly: true },
        );
        resolve();
      };

      const onAbort = () => finish('abort');

      if (ctx.abortSignal?.aborted) {
        onAbort();
        return;
      }

      ctx.abortSignal?.addEventListener?.('abort', onAbort, { once: true });
    });
  };

  channelStopAccount = async (ctx: any) => {
    const accountId = normalizeAccountId(ctx?.accountId);
    const cleared = this.clearChannelAccountWorker(accountId, 'explicit-stop');
    const previous = ctx?.getStatus?.() || {};
    ctx?.setStatus?.({
      ...previous,
      accountId,
      running: false,
      restartPending: false,
      lastStopAt: Date.now(),
      meta: this.buildStatusMeta(accountId),
    });
    this.logInfo(
      'health',
      `status-stop ${JSON.stringify({ bridge: this.bridgeId, accountId, cleared })}`,
      { debugOnly: true },
    );
  };

  channelSendText = async (ctx: any) => {
    await this.syncDebugFlag();
    const accountId = normalizeAccountId(ctx.accountId);
    const to = asString(ctx.to || '').trim();

    this.logInfo(
      'outbound',
      `send-entry:text ${JSON.stringify({
        accountId,
        to,
        text: asString(ctx?.text || ''),
        mediaUrl: asString(ctx?.mediaUrl || ''),
        sessionKey: asString(ctx?.sessionKey || ''),
        mirrorSessionKey: asString(ctx?.mirror?.sessionKey || ''),
        rawCtx: {
          to: ctx?.to,
          accountId: ctx?.accountId,
          threadId: ctx?.threadId,
          replyToId: ctx?.replyToId,
        },
      })}`,
      { debugOnly: true },
    );

    return sendBncrText({
      channelId: CHANNEL_ID,
      accountId,
      to,
      text: asString(ctx.text || ''),
      replyToId: asString(ctx?.replyToId || ctx?.replyToMessageId || '').trim() || undefined,
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

    this.logInfo(
      'outbound',
      `send-entry:media ${JSON.stringify({
        accountId,
        to,
        text: asString(ctx?.text || ''),
        mediaUrl: asString(ctx?.mediaUrl || ''),
        mediaUrls: Array.isArray(ctx?.mediaUrls) ? ctx.mediaUrls : undefined,
        asVoice,
        audioAsVoice,
        sessionKey: asString(ctx?.sessionKey || ''),
        mirrorSessionKey: asString(ctx?.mirror?.sessionKey || ''),
        rawCtx: {
          to: ctx?.to,
          accountId: ctx?.accountId,
          threadId: ctx?.threadId,
          replyToId: ctx?.replyToId,
        },
      })}`,
      { debugOnly: true },
    );

    return sendBncrMedia({
      channelId: CHANNEL_ID,
      accountId,
      to,
      text: asString(ctx.text || ''),
      mediaUrl: asString(ctx.mediaUrl || ''),
      asVoice,
      audioAsVoice,
      replyToId: asString(ctx?.replyToId || ctx?.replyToMessageId || '').trim() || undefined,
      mediaLocalRoots: ctx.mediaLocalRoots,
      resolveVerifiedTarget: (to, accountId) => this.resolveVerifiedTarget(to, accountId),
      rememberSessionRoute: (sessionKey, accountId, route) =>
        this.rememberSessionRoute(sessionKey, accountId, route),
      enqueueFromReply: (args) => this.enqueueFromReply(args),
      createMessageId: () => randomUUID(),
    });
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
    extractToolSend: ({ args }) => extractToolSend(args, 'sendMessage'),
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

      return jsonResult({ ok: true, ...result });
    },
  };

  const plugin = {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: 'Bncr',
      selectionLabel: 'Bncr Client',
      docsPath: '/channels/bncr',
      blurb: 'Bncr Channel.',
      aliases: ['bncr'],
    },
    actions: messageActions,
    capabilities: {
      chatTypes: ['direct'] as ChatType[],
      media: true,
      reply: true,
      nativeCommands: true,
    },
    messaging: {
      // 接收任意标签输入；不在 normalize 阶段做格式门槛，统一下沉到发送前验证。
      normalizeTarget: (raw: string) => {
        const input = asString(raw).trim();
        return input || undefined;
      },
      parseExplicitTarget: ({ raw, accountId, cfg }: any) => {
        const resolvedAccountId = normalizeAccountId(
          asString(accountId || BNCR_DEFAULT_ACCOUNT_ID),
        );
        const runtimeBridge = getBridge();
        const canonicalAgentId =
          runtimeBridge.canonicalAgentId ||
          runtimeBridge.ensureCanonicalAgentId({ cfg, accountId: resolvedAccountId });
        return parseExplicitTarget(asString(raw).trim(), { canonicalAgentId });
      },
      formatTargetDisplay: ({ target }: any) => {
        return formatTargetDisplay(target);
      },
      resolveSessionTarget: ({ id, accountId, cfg }: any) => {
        const raw = asString(id).trim();
        if (!raw) return undefined;
        const resolvedAccountId = normalizeAccountId(
          asString(accountId || BNCR_DEFAULT_ACCOUNT_ID),
        );
        const runtimeBridge = getBridge();
        const canonicalAgentId =
          runtimeBridge.canonicalAgentId ||
          runtimeBridge.ensureCanonicalAgentId({ cfg, accountId: resolvedAccountId });

        let parsed = parseExplicitTarget(raw, { canonicalAgentId });
        if (!parsed) {
          const route = runtimeBridge.resolveRouteBySession(raw, resolvedAccountId);
          if (route) {
            parsed = parseExplicitTarget(formatDisplayScope(route), { canonicalAgentId });
          }
        }
        return parsed?.displayScope || undefined;
      },
      resolveOutboundSessionRoute: (params: any) => {
        const accountId = normalizeAccountId(
          asString(params?.accountId || BNCR_DEFAULT_ACCOUNT_ID),
        );
        const runtimeBridge = getBridge();
        const canonicalAgentId =
          runtimeBridge.canonicalAgentId ||
          runtimeBridge.ensureCanonicalAgentId({ cfg: params?.cfg, accountId });
        return resolveBncrOutboundSessionRoute({
          ...params,
          canonicalAgentId,
          resolveRouteBySession: (raw: string, acc: string) =>
            runtimeBridge.resolveRouteBySession(raw, acc),
        });
      },
      targetResolver: {
        looksLikeId: (raw: string, normalized?: string) => {
          return looksLikeBncrExplicitTarget(asString(normalized || raw).trim());
        },
        resolveTarget: async ({ accountId, input, normalized }) => {
          const runtimeBridge = getBridge();
          const resolved = resolveBncrOutboundTarget({
            target: asString(normalized || input).trim(),
            accountId: normalizeAccountId(asString(accountId || BNCR_DEFAULT_ACCOUNT_ID)),
            resolveRouteBySession: (raw: string, acc: string) =>
              runtimeBridge.resolveRouteBySession(raw, acc),
          });
          if (!resolved) return null;
          return {
            to: resolved.displayScope,
            kind: resolved.kind,
            display: resolved.displayScope,
            source: 'normalized' as const,
          };
        },
        hint: 'Standard to=Bncr:<platform>:<group>:<user> or Bncr:<platform>:<user>; sessionKey keeps existing strict/legacy compatibility, canonical sessionKey=agent:<agentId>:bncr:direct:<hex>',
      },
    },
    configSchema: BncrConfigSchema,
    config: {
      listAccountIds,
      resolveAccount,
      setAccountEnabled: ({ cfg, accountId, enabled }: any) =>
        setAccountEnabledInConfigSection({
          cfg,
          sectionKey: CHANNEL_ID,
          accountId,
          enabled,
          allowTopLevel: true,
        }),
      isEnabled: (account: any, cfg: any) => {
        const policy = resolveBncrChannelPolicy(cfg?.channels?.[CHANNEL_ID] || {});
        return policy.enabled !== false && account?.enabled !== false;
      },
      isConfigured: () => true,
      describeAccount: (account: any) => {
        const displayName = resolveDefaultDisplayName(account?.name, account?.accountId);
        return {
          accountId: account.accountId,
          name: displayName,
          enabled: account.enabled !== false,
          configured: true,
        };
      },
    },
    setup: {
      applyAccountName: ({ cfg, accountId, name }: any) =>
        applyAccountNameToChannelSection({
          cfg,
          channelKey: CHANNEL_ID,
          accountId,
          name,
          alwaysUseAccounts: true,
        }),
      applyAccountConfig: ({ cfg, accountId }: any) => {
        const next = { ...(cfg || {}) } as any;
        next.channels = next.channels || {};
        next.channels[CHANNEL_ID] = next.channels[CHANNEL_ID] || {};
        next.channels[CHANNEL_ID].accounts = next.channels[CHANNEL_ID].accounts || {};
        next.channels[CHANNEL_ID].accounts[accountId] = {
          ...(next.channels[CHANNEL_ID].accounts[accountId] || {}),
          enabled: true,
        };
        return next;
      },
    },
    outbound: {
      deliveryMode: 'gateway' as const,
      sendText: async (ctx: any) => getBridge().channelSendText(ctx),
      sendMedia: async (ctx: any) => getBridge().channelSendMedia(ctx),
      replyAction: async (ctx: any) =>
        sendBncrReplyAction({
          accountId: normalizeAccountId(ctx?.accountId),
          to: asString(ctx?.to || '').trim(),
          text: asString(ctx?.text || ''),
          replyToMessageId:
            asString(ctx?.replyToId || ctx?.replyToMessageId || '').trim() || undefined,
          sendText: async ({ accountId, to, text }) =>
            getBridge().channelSendText({ accountId, to, text }),
        }),
      deleteAction: async (ctx: any) =>
        deleteBncrMessageAction({
          accountId: normalizeAccountId(ctx?.accountId),
          targetMessageId: asString(ctx?.messageId || ctx?.targetMessageId || '').trim(),
        }),
      reactAction: async (ctx: any) =>
        reactBncrMessageAction({
          accountId: normalizeAccountId(ctx?.accountId),
          targetMessageId: asString(ctx?.messageId || ctx?.targetMessageId || '').trim(),
          emoji: asString(ctx?.emoji || '').trim(),
        }),
      editAction: async (ctx: any) =>
        editBncrMessageAction({
          accountId: normalizeAccountId(ctx?.accountId),
          targetMessageId: asString(ctx?.messageId || ctx?.targetMessageId || '').trim(),
          text: asString(ctx?.text || ''),
        }),
    },
    status: {
      defaultRuntime: createDefaultChannelRuntimeState(BNCR_DEFAULT_ACCOUNT_ID, {
        mode: 'ws-offline',
      }),
      buildChannelSummary: async ({ defaultAccountId }: any) => {
        return getBridge().getChannelSummary(defaultAccountId || BNCR_DEFAULT_ACCOUNT_ID);
      },
      buildAccountSnapshot: async ({ account, runtime }: any) => {
        const runtimeBridge = getBridge();
        const rt = runtime || runtimeBridge.getAccountRuntimeSnapshot(account?.accountId);
        const meta = rt?.meta || {};

        const pending = Number(rt?.pending ?? meta.pending ?? 0);
        const deadLetter = Number(rt?.deadLetter ?? meta.deadLetter ?? 0);
        const lastSessionKey = rt?.lastSessionKey ?? meta.lastSessionKey ?? null;
        const lastSessionScope = rt?.lastSessionScope ?? meta.lastSessionScope ?? null;
        const lastSessionAt = rt?.lastSessionAt ?? meta.lastSessionAt ?? null;
        const lastSessionAgo = rt?.lastSessionAgo ?? meta.lastSessionAgo ?? '-';
        const lastActivityAt = rt?.lastActivityAt ?? meta.lastActivityAt ?? null;
        const lastActivityAgo = rt?.lastActivityAgo ?? meta.lastActivityAgo ?? '-';
        const lastInboundAt = rt?.lastInboundAt ?? meta.lastInboundAt ?? null;
        const lastInboundAgo = rt?.lastInboundAgo ?? meta.lastInboundAgo ?? '-';
        const lastOutboundAt = rt?.lastOutboundAt ?? meta.lastOutboundAt ?? null;
        const lastOutboundAgo = rt?.lastOutboundAgo ?? meta.lastOutboundAgo ?? '-';
        const diagnostics = rt?.diagnostics ?? meta.diagnostics ?? null;
        // 右侧状态字段统一：离线时也显示 Status（避免出现 configured 文案）
        const normalizedMode = rt?.mode === 'linked' ? 'linked' : 'Status';

        const displayName = resolveDefaultDisplayName(account?.name, account?.accountId);

        return {
          accountId: account.accountId,
          // default 名不可隐藏时，统一展示稳定默认值
          name: displayName,
          enabled: account.enabled !== false,
          configured: true,
          linked: Boolean(rt?.connected),
          running: rt?.running ?? false,
          connected: rt?.connected ?? false,
          lastEventAt: rt?.lastEventAt ?? null,
          lastError: rt?.lastError ?? null,
          mode: normalizedMode,
          pending,
          deadLetter,
          healthSummary: runtimeBridge.getStatusHeadline(account?.accountId),
          lastSessionKey,
          lastSessionScope,
          lastSessionAt,
          lastSessionAgo,
          lastActivityAt,
          lastActivityAgo,
          lastInboundAt,
          lastInboundAgo,
          lastOutboundAt,
          lastOutboundAgo,
          diagnostics,
        };
      },
      resolveAccountState: ({ enabled, configured, account, cfg, runtime }: any) => {
        if (!enabled) return 'disabled';
        const resolved = resolveAccount(cfg, account?.accountId);
        if (!(resolved.enabled && configured)) return 'not configured';
        const rt = runtime || getBridge().getAccountRuntimeSnapshot(account?.accountId);
        return rt?.connected ? 'linked' : 'configured';
      },
    },
    gatewayMethods: [
      'bncr.connect',
      'bncr.inbound',
      'bncr.activity',
      'bncr.ack',
      'bncr.diagnostics',
      'bncr.file.init',
      'bncr.file.chunk',
      'bncr.file.complete',
      'bncr.file.abort',
      'bncr.file.ack',
    ],
    gateway: {
      startAccount: async (ctx: any) => getBridge().channelStartAccount(ctx),
      stopAccount: async (ctx: any) => getBridge().channelStopAccount(ctx),
    },
  };

  return plugin;
}
