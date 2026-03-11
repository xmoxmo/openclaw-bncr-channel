import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
  GatewayRequestHandlerOptions,
  ChatType,
} from 'openclaw/plugin-sdk';
import {
  createDefaultChannelRuntimeState,
  setAccountEnabledInConfigSection,
  applyAccountNameToChannelSection,
  writeJsonFileAtomically,
  readJsonFileWithFallback,
} from 'openclaw/plugin-sdk';
import { CHANNEL_ID, BNCR_DEFAULT_ACCOUNT_ID, normalizeAccountId, resolveDefaultDisplayName, resolveAccount, listAccountIds } from './core/accounts.js';
import type { BncrRoute, BncrConnection, OutboxEntry } from './core/types.js';
import {
  parseRouteFromScope,
  parseRouteFromDisplayScope,
  formatDisplayScope,
  isLowerHex,
  routeScopeToHex,
  parseRouteFromHexScope,
  parseRouteLike,
  parseLegacySessionKeyToStrict,
  normalizeStoredSessionKey,
  parseStrictBncrSessionKey,
  normalizeInboundSessionKey,
  withTaskSessionKey,
  buildFallbackSessionKey,
  routeKey,
} from './core/targets.js';
import { parseBncrInboundParams } from './messaging/inbound/parse.js';
import { dispatchBncrInbound } from './messaging/inbound/dispatch.js';
import { checkBncrMessageGate } from './messaging/inbound/gate.js';
import { sendBncrText, sendBncrMedia } from './messaging/outbound/send.js';
import { buildBncrMediaOutboundFrame, resolveBncrOutboundMessageType } from './messaging/outbound/media.js';
import { sendBncrReplyAction, deleteBncrMessageAction, reactBncrMessageAction, editBncrMessageAction } from './messaging/outbound/actions.js';
import {
  buildIntegratedDiagnostics as buildIntegratedDiagnosticsFromRuntime,
  buildStatusHeadlineFromRuntime,
  buildStatusMetaFromRuntime,
  buildAccountRuntimeSnapshot,
} from './core/status.js';
import { probeBncrAccount } from './core/probe.js';
import { BncrConfigSchema } from './core/config-schema.js';
import { resolveBncrChannelPolicy } from './core/policy.js';
import { buildBncrPermissionSummary } from './core/permissions.js';
const BRIDGE_VERSION = 2;
const BNCR_PUSH_EVENT = 'bncr.push';
const CONNECT_TTL_MS = 120_000;
const MAX_RETRY = 10;
const PUSH_DRAIN_INTERVAL_MS = 500;
const FILE_FORCE_CHUNK = true; // 统一走 WS 分块，保留 base64 仅作兜底
const FILE_INLINE_THRESHOLD = 5 * 1024 * 1024; // fallback 阈值（仅 FILE_FORCE_CHUNK=false 时生效）
const FILE_CHUNK_SIZE = 256 * 1024; // 256KB
const FILE_CHUNK_RETRY = 3;
const FILE_ACK_TIMEOUT_MS = 30_000;
const FILE_TRANSFER_ACK_TTL_MS = 30_000;
const FILE_TRANSFER_KEEP_MS = 6 * 60 * 60 * 1000;
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
  completedPath?: string;
  error?: string;
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
};

function now() {
  return Date.now();
}

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
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
  const cleaned = base.replace(/[\\/:*?"<>|\x00-\x1F]+/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function buildTimestampFileName(mimeType?: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const ext = fileExtFromMime(mimeType) || '.bin';
  return `bncr_${ts}_${Math.random().toString(16).slice(2, 8)}${ext}`;
}

function resolveOutboundFileName(params: { mediaUrl?: string; fileName?: string; mimeType?: string }): string {
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

  private connections = new Map<string, BncrConnection>(); // connectionKey -> connection
  private activeConnectionByAccount = new Map<string, string>(); // accountId -> connectionKey
  private outbox = new Map<string, OutboxEntry>(); // messageId -> entry
  private deadLetter: OutboxEntry[] = [];

  private sessionRoutes = new Map<string, { accountId: string; route: BncrRoute; updatedAt: number }>();
  private routeAliases = new Map<string, { accountId: string; route: BncrRoute; updatedAt: number }>();

  private recentInbound = new Map<string, number>();
  private lastSessionByAccount = new Map<string, { sessionKey: string; scope: string; updatedAt: number }>();
  private lastActivityByAccount = new Map<string, number>();
  private lastInboundByAccount = new Map<string, number>();
  private lastOutboundByAccount = new Map<string, number>();

  // 内置健康/回归计数（替代独立脚本）
  private startedAt = now();
  private connectEventsByAccount = new Map<string, number>();
  private inboundEventsByAccount = new Map<string, number>();
  private activityEventsByAccount = new Map<string, number>();
  private ackEventsByAccount = new Map<string, number>();

  private saveTimer: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private pushDrainRunningAccounts = new Set<string>();
  private waiters = new Map<string, Array<() => void>>();
  private gatewayContext: GatewayRequestHandlerOptions['context'] | null = null;

  // 文件互传状态（V1：尽力而为，重连不续传）
  private fileSendTransfers = new Map<string, FileSendTransferState>(); // OpenClaw -> Bncr（服务端发起）
  private fileRecvTransfers = new Map<string, FileRecvTransferState>(); // Bncr -> OpenClaw（客户端发起）
  private fileAckWaiters = new Map<string, {
    resolve: (payload: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(api: OpenClawPluginApi) {
    this.api = api;
  }

  isDebugEnabled(): boolean {
    try {
      const cfg = (this.api.runtime.config?.get?.() as any) || {};
      return Boolean(cfg?.channels?.[CHANNEL_ID]?.debug?.verbose);
    } catch {
      return false;
    }
  }

  startService = async (ctx: OpenClawPluginServiceContext, debug?: boolean) => {
    this.statePath = path.join(ctx.stateDir, 'bncr-bridge-state.json');
    await this.loadState();
    if (typeof debug === 'boolean') BNCR_DEBUG_VERBOSE = debug;
    const bootDiag = this.buildIntegratedDiagnostics(BNCR_DEFAULT_ACCOUNT_ID);
    if (BNCR_DEBUG_VERBOSE) {
      this.api.logger.info(`bncr-channel service started (bridge=${this.bridgeId} diag.ok=${bootDiag.regression.ok} routes=${bootDiag.regression.totalKnownRoutes} pending=${bootDiag.health.pending} dead=${bootDiag.health.deadLetter} debug=${BNCR_DEBUG_VERBOSE})`);
    }
  };

  stopService = async () => {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    await this.flushState();
    if (BNCR_DEBUG_VERBOSE) {
      this.api.logger.info('bncr-channel service stopped');
    }
  };

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

  private syncDebugFlag() {
    const next = this.isDebugEnabled();
    if (next !== BNCR_DEBUG_VERBOSE) {
      BNCR_DEBUG_VERBOSE = next;
      this.api.logger.info?.(`[bncr-debug] verbose=${BNCR_DEBUG_VERBOSE}`);
    }
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
    const mismatched = (raw?: string | null) => asString(raw || '').trim() && normalizeAccountId(raw) !== acc;

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
      sessionRoutesCount: Array.from(this.sessionRoutes.values()).filter((v) => v.accountId === acc).length,
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
      const normalized = normalizeStoredSessionKey(sessionKey);
      if (!normalized) continue;

      const route = parseRouteLike(entry.route) || normalized.route;
      const payload = (entry.payload && typeof entry.payload === 'object') ? { ...entry.payload } : {};
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
      const normalized = normalizeStoredSessionKey(sessionKey);
      if (!normalized) continue;

      const route = parseRouteLike(entry.route) || normalized.route;
      const payload = (entry.payload && typeof entry.payload === 'object') ? { ...entry.payload } : {};
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
      const normalized = normalizeStoredSessionKey(asString(item?.sessionKey || ''));
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
      const normalized = normalizeStoredSessionKey(asString(item?.sessionKey || ''));
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
      lastSessionByAccount: Array.from(this.lastSessionByAccount.entries()).map(([accountId, v]) => ({
        accountId,
        sessionKey: v.sessionKey,
        scope: v.scope,
        updatedAt: v.updatedAt,
      })),
      lastActivityByAccount: Array.from(this.lastActivityByAccount.entries()).map(([accountId, updatedAt]) => ({
        accountId,
        updatedAt,
      })),
      lastInboundByAccount: Array.from(this.lastInboundByAccount.entries()).map(([accountId, updatedAt]) => ({
        accountId,
        updatedAt,
      })),
      lastOutboundByAccount: Array.from(this.lastOutboundByAccount.entries()).map(([accountId, updatedAt]) => ({
        accountId,
        updatedAt,
      })),
    };

    await writeJsonFileAtomically(this.statePath, data);
  }

  private wakeAccountWaiters(accountId: string) {
    const key = normalizeAccountId(accountId);
    const waits = this.waiters.get(key);
    if (!waits?.length) return;
    this.waiters.delete(key);
    for (const resolve of waits) resolve();
  }

  private rememberGatewayContext(context: GatewayRequestHandlerOptions['context']) {
    if (context) this.gatewayContext = context;
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

  private tryPushEntry(entry: OutboxEntry): boolean {
    const ctx = this.gatewayContext;
    if (!ctx) {
      if (BNCR_DEBUG_VERBOSE) {
        this.api.logger.info?.(
          `[bncr-outbox-push-skip] ${JSON.stringify({
            messageId: entry.messageId,
            accountId: entry.accountId,
            reason: 'no-gateway-context',
          })}`,
        );
      }
      return false;
    }

    const connIds = this.resolvePushConnIds(entry.accountId);
    if (!connIds.size) {
      if (BNCR_DEBUG_VERBOSE) {
        this.api.logger.info?.(
          `[bncr-outbox-push-skip] ${JSON.stringify({
            messageId: entry.messageId,
            accountId: entry.accountId,
            reason: 'no-active-connection',
          })}`,
        );
      }
      return false;
    }

    try {
      const payload = {
        ...entry.payload,
        idempotencyKey: entry.messageId,
      };

      ctx.broadcastToConnIds(BNCR_PUSH_EVENT, payload, connIds);
      if (BNCR_DEBUG_VERBOSE) {
        this.api.logger.info?.(
          `[bncr-outbox-push-ok] ${JSON.stringify({
            messageId: entry.messageId,
            accountId: entry.accountId,
            connIds: Array.from(connIds),
            event: BNCR_PUSH_EVENT,
          })}`,
        );
      }
      this.outbox.delete(entry.messageId);
      this.lastOutboundByAccount.set(entry.accountId, now());
      this.markActivity(entry.accountId);
      this.scheduleSave();
      return true;
    } catch (error) {
      entry.lastError = asString((error as any)?.message || error || 'push-error');
      this.outbox.set(entry.messageId, entry);
      if (BNCR_DEBUG_VERBOSE) {
        this.api.logger.info?.(
          `[bncr-outbox-push-fail] ${JSON.stringify({
            messageId: entry.messageId,
            accountId: entry.accountId,
            error: entry.lastError,
          })}`,
        );
      }
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

  private async flushPushQueue(accountId?: string): Promise<void> {
    const filterAcc = accountId ? normalizeAccountId(accountId) : null;
    const targetAccounts = filterAcc
      ? [filterAcc]
      : Array.from(new Set(Array.from(this.outbox.values()).map((entry) => normalizeAccountId(entry.accountId))));
    if (BNCR_DEBUG_VERBOSE) {
      this.api.logger.info?.(
        `[bncr-outbox-flush] ${JSON.stringify({
          bridge: this.bridgeId,
          accountId: filterAcc,
          targetAccounts,
          outboxSize: this.outbox.size,
        })}`,
      );
    }

    let globalNextDelay: number | null = null;

    for (const acc of targetAccounts) {
      if (!acc || this.pushDrainRunningAccounts.has(acc)) continue;
      const online = this.isOnline(acc);
      if (BNCR_DEBUG_VERBOSE) {
        this.api.logger.info?.(
          `[bncr-outbox-online] ${JSON.stringify({
            bridge: this.bridgeId,
            accountId: acc,
            online,
            connections: Array.from(this.connections.values()).map((c) => ({
              accountId: c.accountId,
              connId: c.connId,
              clientId: c.clientId,
              lastSeenAt: c.lastSeenAt,
            })),
          })}`,
        );
      }
      if (!online) {
        const ctx = this.gatewayContext;
        const directConnIds = Array.from(this.connections.values())
          .filter((c) => normalizeAccountId(c.accountId) === acc && c.connId)
          .map((c) => c.connId as string);

        if (BNCR_DEBUG_VERBOSE) {
          this.api.logger.info?.(
            `[bncr-outbox-direct-push] ${JSON.stringify({
              bridge: this.bridgeId,
              accountId: acc,
              outboxSize: this.outbox.size,
              hasGatewayContext: Boolean(ctx),
              connCount: directConnIds.length,
            })}`,
          );
        }

        if (!ctx) {
          if (BNCR_DEBUG_VERBOSE) {
            this.api.logger.info?.(
              `[bncr-outbox-direct-push-skip] ${JSON.stringify({
                bridge: this.bridgeId,
                accountId: acc,
                reason: 'no-gateway-context',
              })}`,
            );
          }
          continue;
        }

        if (!directConnIds.length) {
          if (BNCR_DEBUG_VERBOSE) {
            this.api.logger.info?.(
              `[bncr-outbox-direct-push-skip] ${JSON.stringify({
                accountId: acc,
                reason: 'no-connection',
              })}`,
            );
          }
          continue;
        }

        const directPayloads = this.collectDue(acc, 50);
        if (!directPayloads.length) continue;

        try {
          ctx.broadcastToConnIds(BNCR_PUSH_EVENT, {
            forcePush: true,
            items: directPayloads,
          }, new Set(directConnIds));

          const pushedIds = directPayloads
            .map((item: any) => asString(item?.messageId || item?.idempotencyKey || '').trim())
            .filter(Boolean);
          for (const id of pushedIds) this.outbox.delete(id);
          if (pushedIds.length) this.scheduleSave();

          if (BNCR_DEBUG_VERBOSE) {
            this.api.logger.info?.(
              `[bncr-outbox-direct-push-ok] ${JSON.stringify({
                bridge: this.bridgeId,
                accountId: acc,
                count: directPayloads.length,
                connCount: directConnIds.length,
                dropped: pushedIds.length,
              })}`,
            );
          }
        } catch (error) {
          if (BNCR_DEBUG_VERBOSE) {
            this.api.logger.info?.(
              `[bncr-outbox-direct-push-fail] ${JSON.stringify({
                accountId: acc,
                error: asString((error as any)?.message || error || 'direct-push-error'),
              })}`,
            );
          }
        }
        continue;
      }

      this.pushDrainRunningAccounts.add(acc);
      try {
        let localNextDelay: number | null = null;

        while (true) {
          const t = now();
          const entries = Array.from(this.outbox.values())
            .filter((entry) => normalizeAccountId(entry.accountId) === acc)
            .sort((a, b) => a.createdAt - b.createdAt);

          if (!entries.length) break;
          if (!this.isOnline(acc)) break;

          const entry = entries.find((item) => item.nextAttemptAt <= t);
          if (!entry) {
            const wait = Math.max(0, entries[0].nextAttemptAt - t);
            localNextDelay = localNextDelay == null ? wait : Math.min(localNextDelay, wait);
            break;
          }

          const pushed = this.tryPushEntry(entry);
          if (pushed) {
            this.scheduleSave();
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
          globalNextDelay = globalNextDelay == null ? localNextDelay : Math.min(globalNextDelay, localNextDelay);
        }
      } finally {
        this.pushDrainRunningAccounts.delete(acc);
      }
    }

    if (globalNextDelay != null) this.schedulePushDrain(globalNextDelay);
  }

  private async waitForOutbound(accountId: string, waitMs: number): Promise<void> {
    const key = normalizeAccountId(accountId);
    const timeoutMs = Math.max(0, Math.min(waitMs, 25_000));
    if (!timeoutMs) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const arr = this.waiters.get(key) || [];
        this.waiters.set(
          key,
          arr.filter((fn) => fn !== done),
        );
        resolve();
      }, timeoutMs);

      const done = () => {
        clearTimeout(timer);
        resolve();
      };

      const arr = this.waiters.get(key) || [];
      arr.push(done);
      this.waiters.set(key, arr);
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
        if (BNCR_DEBUG_VERBOSE) {
          this.api.logger.info?.(
            `[bncr-conn-gc] ${JSON.stringify({
              bridge: this.bridgeId,
              key,
              accountId: c.accountId,
              connId: c.connId,
              clientId: c.clientId,
              lastSeenAt: c.lastSeenAt,
              staleBefore,
            })}`,
          );
        }
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
  }

  private markSeen(accountId: string, connId: string, clientId?: string) {
    this.gcTransientState();

    const acc = normalizeAccountId(accountId);
    const key = this.connectionKey(acc, clientId);
    const t = now();
    const prev = this.connections.get(key);

    const nextConn: BncrConnection = {
      accountId: acc,
      connId,
      clientId: asString(clientId || '').trim() || undefined,
      connectedAt: prev?.connectedAt || t,
      lastSeenAt: t,
    };

    this.connections.set(key, nextConn);
    if (BNCR_DEBUG_VERBOSE) {
      this.api.logger.info?.(
        `[bncr-conn-seen] ${JSON.stringify({
          bridge: this.bridgeId,
          accountId: acc,
          connId,
          clientId: nextConn.clientId,
          connectedAt: nextConn.connectedAt,
          lastSeenAt: nextConn.lastSeenAt,
        })}`,
      );
    }

    const current = this.activeConnectionByAccount.get(acc);
    if (!current) {
      this.activeConnectionByAccount.set(acc, key);
      return;
    }

    const curConn = this.connections.get(current);
    if (!curConn || t - curConn.lastSeenAt > CONNECT_TTL_MS || nextConn.connectedAt >= curConn.connectedAt) {
      this.activeConnectionByAccount.set(acc, key);
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
    // 同步维护旧格式与新格式，便于平滑切换
    this.sessionRoutes.set(buildFallbackSessionKey(route), info);

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
  private resolveVerifiedTarget(rawTarget: string, accountId: string): { sessionKey: string; route: BncrRoute; displayScope: string } {
    const acc = normalizeAccountId(accountId);
    const raw = asString(rawTarget).trim();
    if (!raw) throw new Error('bncr invalid target(empty)');

    if (BNCR_DEBUG_VERBOSE) {
      this.api.logger.info?.(`[bncr-target-incoming] raw=${raw} accountId=${acc}`);
    }

    let route: BncrRoute | null = null;

    const strict = parseStrictBncrSessionKey(raw);
    if (strict) {
      route = strict.route;
    } else {
      route = parseRouteFromDisplayScope(raw) || this.resolveRouteBySession(raw, acc);
    }

    if (!route) {
      this.api.logger.warn?.(
        `[bncr-target-invalid] raw=${raw} accountId=${acc} reason=unparseable-or-unknown standardTo=Bncr:<platform>:<groupId>:<userId>|Bncr:<platform>:<userId> standardSessionKey=agent:main:bncr:direct:<hex(scope)>`,
      );
      throw new Error(`bncr invalid target(standard: Bncr:<platform>:<groupId>:<userId> | Bncr:<platform>:<userId>): ${raw}`);
    }

    const wantedRouteKey = routeKey(acc, route);
    let best: { sessionKey: string; route: BncrRoute; updatedAt: number } | null = null;

    if (BNCR_DEBUG_VERBOSE) {
      this.api.logger.info?.(`[bncr-target-incoming-route] raw=${raw} accountId=${acc} route=${JSON.stringify(route)}`);
      this.api.logger.info?.(`[bncr-target-incoming-sessionRoutes] raw=${raw} accountId=${acc} sessionRoutes=${JSON.stringify(this.sessionRoutes.entries())}`);
    }

    for (const [key, info] of this.sessionRoutes.entries()) {
      if (normalizeAccountId(info.accountId) !== acc) continue;
      const parsed = parseStrictBncrSessionKey(key);
      if (!parsed) continue;
      if (routeKey(acc, parsed.route) !== wantedRouteKey) continue;

      const updatedAt = Number(info.updatedAt || 0);
      if (!best || updatedAt >= best.updatedAt) {
        best = {
          sessionKey: parsed.sessionKey,
          route: parsed.route,
          updatedAt,
        };
      }
    }

    // 直接根据raw生成标准sessionkey
    if (!best) {
      const updatedAt = 0;
      best = {
        sessionKey: `agent:main:bncr:direct:${routeScopeToHex(route)}`,
        route,
        updatedAt,
      };
    }

    if (BNCR_DEBUG_VERBOSE) {
      this.api.logger.info?.(`[bncr-target-incoming-best] raw=${raw} accountId=${acc} best=${JSON.stringify(best)}`);
    }

    if (!best) {
      this.api.logger.warn?.(`[bncr-target-miss] raw=${raw} accountId=${acc} sessionRoutes=${this.sessionRoutes.size}`);
      throw new Error(`bncr target not found in known sessions: ${raw}`);
    }

    // 发送链路命中目标时，同步刷新 lastSession，避免状态页显示过期会话。
    this.lastSessionByAccount.set(acc, {
      sessionKey: best.sessionKey,
      scope: formatDisplayScope(best.route),
      updatedAt: now(),
    });
    this.scheduleSave();

    return {
      sessionKey: best.sessionKey,
      route: best.route,
      displayScope: formatDisplayScope(best.route),
    };
  }

  private markActivity(accountId: string, at = now()) {
    this.lastActivityByAccount.set(normalizeAccountId(accountId), at);
  }

  private fileAckKey(transferId: string, stage: string, chunkIndex?: number): string {
    const idx = Number.isFinite(Number(chunkIndex)) ? String(Number(chunkIndex)) : '-';
    return `${transferId}|${stage}|${idx}`;
  }

  private waitForFileAck(params: { transferId: string; stage: string; chunkIndex?: number; timeoutMs?: number }) {
    const transferId = asString(params.transferId).trim();
    const stage = asString(params.stage).trim();
    const key = this.fileAckKey(transferId, stage, params.chunkIndex);
    const timeoutMs = Math.max(1_000, Math.min(Number(params.timeoutMs || FILE_ACK_TIMEOUT_MS), 120_000));

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fileAckWaiters.delete(key);
        reject(new Error(`file ack timeout: ${key}`));
      }, timeoutMs);
      this.fileAckWaiters.set(key, { resolve, reject, timer });
    });
  }

  private resolveFileAck(params: { transferId: string; stage: string; chunkIndex?: number; payload: Record<string, unknown>; ok: boolean }) {
    const transferId = asString(params.transferId).trim();
    const stage = asString(params.stage).trim();
    const key = this.fileAckKey(transferId, stage, params.chunkIndex);
    const waiter = this.fileAckWaiters.get(key);
    if (!waiter) return false;
    this.fileAckWaiters.delete(key);
    clearTimeout(waiter.timer);
    if (params.ok) waiter.resolve(params.payload);
    else waiter.reject(new Error(asString(params.payload?.errorMessage || params.payload?.error || 'file ack failed')));
    return true;
  }

  private pushFileEventToAccount(accountId: string, event: string, payload: Record<string, unknown>) {
    const connIds = this.resolvePushConnIds(accountId);
    if (!connIds.size || !this.gatewayContext) {
      throw new Error(`no active bncr connection for account=${accountId}`);
    }
    this.gatewayContext.broadcastToConnIds(event, payload, connIds);
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

  private async materializeRecvTransfer(st: FileRecvTransferState): Promise<{ path: string; fileSha256: string }> {
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
      sessionRoutesCount: Array.from(this.sessionRoutes.values()).filter((v) => v.accountId === acc).length,
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
      sessionRoutesCount: Array.from(this.sessionRoutes.values()).filter((v) => v.accountId === acc).length,
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
      sessionRoutesCount: Array.from(this.sessionRoutes.values()).filter((v) => v.accountId === acc).length,
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
    if (BNCR_DEBUG_VERBOSE) {
      const msg = (entry.payload as any)?.message || {};
      const type = asString(msg.type || (entry.payload as any)?.type || 'unknown');
      const text = asString(msg.msg || '');
      this.api.logger.info?.(
        `[bncr-outbox-enqueue] ${JSON.stringify({
          bridge: this.bridgeId,
          messageId: entry.messageId,
          accountId: entry.accountId,
          sessionKey: entry.sessionKey,
          route: entry.route,
          type,
          textLen: text.length,
        })}`,
      );
    }
    this.outbox.set(entry.messageId, entry);
    this.scheduleSave();
    this.wakeAccountWaiters(entry.accountId);
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
    const timeoutMs = Math.max(1_000, Math.min(Number(params.timeoutMs || FILE_TRANSFER_ACK_TTL_MS), 60_000));
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
  }): Promise<{ mode: 'base64' | 'chunk'; mimeType?: string; fileName?: string; mediaBase64?: string; path?: string }> {
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
    if (!ctx) throw new Error('gateway context unavailable');

    const connIds = this.resolvePushConnIds(params.accountId);
    if (!connIds.size) throw new Error('no active bncr client for file chunk transfer');

    const transferId = randomUUID();
    const chunkSize = 256 * 1024;
    const totalChunks = Math.ceil(size / chunkSize);
    const fileSha256 = createHash('sha256').update(loaded.buffer).digest('hex');

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
    };
    this.fileSendTransfers.set(transferId, st);

    ctx.broadcastToConnIds('bncr.file.init', {
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
    }, connIds);

    // 逐块发送并等待 ACK
    for (let idx = 0; idx < totalChunks; idx++) {
      const start = idx * chunkSize;
      const end = Math.min(start + chunkSize, size);
      const slice = loaded.buffer.subarray(start, end);
      const chunkSha256 = createHash('sha256').update(slice).digest('hex');

      let ok = false;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        ctx.broadcastToConnIds('bncr.file.chunk', {
          transferId,
          chunkIndex: idx,
          offset: start,
          size: slice.byteLength,
          chunkSha256,
          base64: slice.toString('base64'),
          ts: now(),
        }, connIds);

        try {
          await this.waitChunkAck({ transferId, chunkIndex: idx, timeoutMs: FILE_TRANSFER_ACK_TTL_MS });
          ok = true;
          break;
        } catch (err) {
          lastErr = err;
          await this.sleepMs(150 * attempt);
        }
      }

      if (!ok) {
        st.status = 'aborted';
        st.error = String((lastErr as any)?.message || lastErr || `chunk-${idx}-failed`);
        this.fileSendTransfers.set(transferId, st);
        ctx.broadcastToConnIds('bncr.file.abort', {
          transferId,
          reason: st.error,
          ts: now(),
        }, connIds);
        throw new Error(st.error);
      }
    }

    ctx.broadcastToConnIds('bncr.file.complete', {
      transferId,
      ts: now(),
    }, connIds);

    const done = await this.waitCompleteAck({ transferId, timeoutMs: 60_000 });

    return {
      mode: 'chunk',
      mimeType,
      fileName,
      path: done.path,
    };
  }

  private async enqueueFromReply(params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
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
        const media = await this.transferMediaToBncrClient({
          accountId,
          sessionKey,
          route,
          mediaUrl,
          mediaLocalRoots,
        });
        const messageId = randomUUID();
        const mediaMsg = first ? asString(payload.text || '') : '';
        const frame = buildBncrMediaOutboundFrame({
          messageId,
          sessionKey,
          route,
          media,
          mediaUrl,
          mediaMsg,
          fileName: resolveOutboundFileName({
            mediaUrl,
            fileName: media.fileName,
            mimeType: media.mimeType,
          }),
          now: now(),
        });

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
      message: {
        platform: route.platform,
        groupId: route.groupId,
        userId: route.userId,
        type: 'text',
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
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;

    if (BNCR_DEBUG_VERBOSE) {
      this.api.logger.info?.(
        `[bncr-connect] ${JSON.stringify({
          bridge: this.bridgeId,
          accountId,
          connId,
          clientId,
          hasContext: Boolean(context),
        })}`,
      );
    }

    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);
    this.incrementCounter(this.connectEventsByAccount, accountId);

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
      diagnostics: this.buildIntegratedDiagnostics(accountId),
      now: now(),
    });

    // WS 一旦在线，立即尝试把离线期间积压队列直推出去
    this.flushPushQueue(accountId);
  };

  handleAck = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.incrementCounter(this.ackEventsByAccount, accountId);

    const messageId = asString(params?.messageId || '').trim();
    if (BNCR_DEBUG_VERBOSE) {
      this.api.logger.info?.(
        `[bncr-outbox-ack] ${JSON.stringify({
          accountId,
          messageId,
          ok: params?.ok !== false,
          fatal: params?.fatal === true,
          error: asString(params?.error || ''),
        })}`,
      );
    }
    if (!messageId) {
      respond(false, { error: 'messageId required' });
      return;
    }

    const entry = this.outbox.get(messageId);
    if (!entry) {
      respond(true, { ok: true, message: 'already-acked-or-missing' });
      return;
    }

    if (entry.accountId !== accountId) {
      respond(false, { error: 'account mismatch' });
      return;
    }

    const ok = params?.ok !== false;
    const fatal = params?.fatal === true;

    if (ok) {
      this.outbox.delete(messageId);
      this.scheduleSave();
      respond(true, { ok: true });
      return;
    }

    if (fatal) {
      this.moveToDeadLetter(entry, asString(params?.error || 'fatal-ack'));
      respond(true, { ok: true, movedToDeadLetter: true });
      return;
    }

    entry.nextAttemptAt = now() + 1_000;
    entry.lastError = asString(params?.error || 'retryable-ack');
    this.outbox.set(messageId, entry);
    this.scheduleSave();

    respond(true, { ok: true, willRetry: true });
  };

  handleActivity = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    this.syncDebugFlag();
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
    if (BNCR_DEBUG_VERBOSE) {
      this.api.logger.info?.(
        `[bncr-activity] ${JSON.stringify({
          bridge: this.bridgeId,
          accountId,
          connId,
          clientId,
          hasContext: Boolean(context),
        })}`,
      );
    }
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
  };

  handleDiagnostics = async ({ params, respond }: GatewayRequestHandlerOptions) => {
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const cfg = await this.api.runtime.config.loadConfig();
    const runtime = this.getAccountRuntimeSnapshot(accountId);
    const diagnostics = this.buildIntegratedDiagnostics(accountId);
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
      permissions,
      probe,
      now: now(),
    });
  };

  handleFileInit = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
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

    const route = parseRouteLike({
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
    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);

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

      respond(true, {
        ok: true,
        transferId,
        chunkIndex,
        offset,
        received: st.receivedChunks.size,
        totalChunks: st.totalChunks,
      });
    } catch (error) {
      respond(false, { error: String((error as any)?.message || error || 'chunk invalid') });
    }
  };

  handleFileComplete = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);

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

    try {
      if (st.receivedChunks.size < st.totalChunks) {
        throw new Error(`chunk not complete received=${st.receivedChunks.size} total=${st.totalChunks}`);
      }

      const ordered = Array.from(st.bufferByChunk.entries()).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
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

      respond(true, {
        ok: true,
        transferId,
        path: saved.path,
        size: merged.length,
        fileName: st.fileName,
        mimeType: st.mimeType,
        fileSha256: digest,
      });
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
    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);

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

    st.status = 'aborted';
    st.error = asString(params?.reason || 'aborted');
    this.fileRecvTransfers.set(transferId, st);

    respond(true, {
      ok: true,
      transferId,
      status: 'aborted',
    });
  };

  handleFileAck = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);

    const transferId = asString(params?.transferId || '').trim();
    const stage = asString(params?.stage || '').trim();
    const ok = params?.ok !== false;
    const chunkIndex = Number(params?.chunkIndex ?? -1);

    if (!transferId || !stage) {
      respond(false, { error: 'transferId/stage required' });
      return;
    }

    const st = this.fileSendTransfers.get(transferId);
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

    respond(true, {
      ok: true,
      transferId,
      stage,
      state: st?.status || 'late',
    });
  };

  handleInbound = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    const parsed = parseBncrInboundParams(params);
    const { accountId, platform, groupId, userId, sessionKeyfromroute, route, text, msgType, mediaBase64, mediaPathFromTransfer, mimeType, fileName, msgId, dedupKey, peer, extracted } = parsed;
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);
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

    const cfg = await this.api.runtime.config.loadConfig();
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

    const baseSessionKey = normalizeInboundSessionKey(sessionKeyfromroute, route)
      || this.api.runtime.channel.routing.resolveAgentRoute({
        cfg,
        channel: CHANNEL_ID,
        accountId,
        peer,
      }).sessionKey;
    const taskSessionKey = withTaskSessionKey(baseSessionKey, extracted.taskKey);
    const sessionKey = taskSessionKey || baseSessionKey;

    respond(true, {
      accepted: true,
      accountId,
      sessionKey,
      msgId: msgId ?? null,
      taskKey: extracted.taskKey ?? null,
    });

    void dispatchBncrInbound({
      api: this.api,
      channelId: CHANNEL_ID,
      cfg,
      parsed,
      rememberSessionRoute: (sessionKey, accountId, route) => this.rememberSessionRoute(sessionKey, accountId, route),
      enqueueFromReply: (args) => this.enqueueFromReply(args),
      setInboundActivity: (accountId, at) => {
        this.lastInboundByAccount.set(accountId, at);
        this.markActivity(accountId, at);
      },
      scheduleSave: () => this.scheduleSave(),
      logger: this.api.logger,
    }).catch((err) => {
      this.api.logger.error?.(`bncr inbound process failed: ${String(err)}`);
    });
  };

  channelStartAccount = async (ctx: any) => {
    const accountId = normalizeAccountId(ctx.accountId);

    const tick = () => {
      const connected = this.isOnline(accountId);
      const previous = ctx.getStatus?.() || {};
      const lastActAt = this.lastActivityByAccount.get(accountId) || previous?.lastEventAt || null;

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

    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearInterval(timer);
        resolve();
      };

      if (ctx.abortSignal?.aborted) {
        onAbort();
        return;
      }

      ctx.abortSignal?.addEventListener?.('abort', onAbort, { once: true });
    });
  };

  channelStopAccount = async (_ctx: any) => {
    // no-op
  };

  channelSendText = async (ctx: any) => {
    const accountId = normalizeAccountId(ctx.accountId);
    const to = asString(ctx.to || '').trim();

    if (BNCR_DEBUG_VERBOSE) {
      this.api.logger.info?.(
        `[bncr-send-entry:text] ${JSON.stringify({
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
      );
    }

    return sendBncrText({
      channelId: CHANNEL_ID,
      accountId,
      to,
      text: asString(ctx.text || ''),
      mediaLocalRoots: ctx.mediaLocalRoots,
      resolveVerifiedTarget: (to, accountId) => this.resolveVerifiedTarget(to, accountId),
      rememberSessionRoute: (sessionKey, accountId, route) => this.rememberSessionRoute(sessionKey, accountId, route),
      enqueueFromReply: (args) => this.enqueueFromReply(args),
      createMessageId: () => randomUUID(),
    });
  };

  channelSendMedia = async (ctx: any) => {
    const accountId = normalizeAccountId(ctx.accountId);
    const to = asString(ctx.to || '').trim();

    if (BNCR_DEBUG_VERBOSE) {
      this.api.logger.info?.(
        `[bncr-send-entry:media] ${JSON.stringify({
          accountId,
          to,
          text: asString(ctx?.text || ''),
          mediaUrl: asString(ctx?.mediaUrl || ''),
          mediaUrls: Array.isArray(ctx?.mediaUrls) ? ctx.mediaUrls : undefined,
          sessionKey: asString(ctx?.sessionKey || ''),
          mirrorSessionKey: asString(ctx?.mirror?.sessionKey || ''),
          rawCtx: {
            to: ctx?.to,
            accountId: ctx?.accountId,
            threadId: ctx?.threadId,
            replyToId: ctx?.replyToId,
          },
        })}`,
      );
    }

    return sendBncrMedia({
      channelId: CHANNEL_ID,
      accountId,
      to,
      text: asString(ctx.text || ''),
      mediaUrl: asString(ctx.mediaUrl || ''),
      mediaLocalRoots: ctx.mediaLocalRoots,
      resolveVerifiedTarget: (to, accountId) => this.resolveVerifiedTarget(to, accountId),
      rememberSessionRoute: (sessionKey, accountId, route) => this.rememberSessionRoute(sessionKey, accountId, route),
      enqueueFromReply: (args) => this.enqueueFromReply(args),
      createMessageId: () => randomUUID(),
    });
  };
}

export function createBncrBridge(api: OpenClawPluginApi) {
  return new BncrBridgeRuntime(api);
}

export function createBncrChannelPlugin(bridge: BncrBridgeRuntime) {
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
      targetResolver: {
        looksLikeId: (raw: string, normalized?: string) => {
          return Boolean(asString(normalized || raw).trim());
        },
        hint: 'Standard to=Bncr:<platform>:<group>:<user> or Bncr:<platform>:<user>; sessionKey keeps existing strict/legacy compatibility, canonical sessionKey=agent:main:bncr:direct:<hex>',
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
      textChunkLimit: 4000,
      sendText: bridge.channelSendText,
      sendMedia: bridge.channelSendMedia,
      replyAction: async (ctx: any) => sendBncrReplyAction({
        accountId: normalizeAccountId(ctx?.accountId),
        to: asString(ctx?.to || '').trim(),
        text: asString(ctx?.text || ''),
        replyToMessageId: asString(ctx?.replyToId || ctx?.replyToMessageId || '').trim() || undefined,
        sendText: async ({ accountId, to, text }) => bridge.channelSendText({ accountId, to, text }),
      }),
      deleteAction: async (ctx: any) => deleteBncrMessageAction({
        accountId: normalizeAccountId(ctx?.accountId),
        targetMessageId: asString(ctx?.messageId || ctx?.targetMessageId || '').trim(),
      }),
      reactAction: async (ctx: any) => reactBncrMessageAction({
        accountId: normalizeAccountId(ctx?.accountId),
        targetMessageId: asString(ctx?.messageId || ctx?.targetMessageId || '').trim(),
        emoji: asString(ctx?.emoji || '').trim(),
      }),
      editAction: async (ctx: any) => editBncrMessageAction({
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
        return bridge.getChannelSummary(defaultAccountId || BNCR_DEFAULT_ACCOUNT_ID);
      },
      buildAccountSnapshot: async ({ account, runtime }: any) => {
        const rt = runtime || bridge.getAccountRuntimeSnapshot(account?.accountId);
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
        const normalizedMode = rt?.mode === 'linked'
          ? 'linked'
          : 'Status';

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
          healthSummary: bridge.getStatusHeadline(account?.accountId),
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
        const rt = runtime || bridge.getAccountRuntimeSnapshot(account?.accountId);
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
      startAccount: bridge.channelStartAccount,
      stopAccount: bridge.channelStopAccount,
    },
  };

  return plugin;
}
