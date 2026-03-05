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

const CHANNEL_ID = 'bncr';
const BNCR_DEFAULT_ACCOUNT_ID = 'Primary';
const BRIDGE_VERSION = 2;
const BNCR_PUSH_EVENT = 'bncr.push';
const CONNECT_TTL_MS = 120_000;
const MAX_RETRY = 10;

const BncrConfigSchema = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      accounts: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: true,
          properties: {
            enabled: { type: 'boolean' },
            name: { type: 'string' },
          },
        },
      },
    },
  },
};

type BncrRoute = {
  platform: string;
  groupId: string;
  userId: string;
};

type BncrConnection = {
  accountId: string;
  connId: string;
  clientId?: string;
  connectedAt: number;
  lastSeenAt: number;
};

type OutboxEntry = {
  messageId: string;
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  payload: Record<string, unknown>;
  createdAt: number;
  retryCount: number;
  nextAttemptAt: number;
  lastAttemptAt?: number;
  lastError?: string;
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

function normalizeAccountId(accountId?: string | null): string {
  const v = asString(accountId || '').trim();
  return v || BNCR_DEFAULT_ACCOUNT_ID;
}

function parseRouteFromScope(scope: string): BncrRoute | null {
  const parts = asString(scope).trim().split(':');
  if (parts.length < 3) return null;
  const [platform, groupId, userId] = parts;
  if (!platform || !groupId || !userId) return null;
  return { platform, groupId, userId };
}

function parseRouteFromDisplayScope(scope: string): BncrRoute | null {
  const raw = asString(scope).trim();
  if (!raw) return null;

  // 支持展示标签：Bncr-platform:group:user
  const stripped = raw.replace(/^Bncr-/i, '');
  return parseRouteFromScope(stripped);
}

function formatDisplayScope(route: BncrRoute): string {
  return `Bncr-${route.platform}:${route.groupId}:${route.userId}`;
}

function isLowerHex(input: string): boolean {
  const raw = asString(input).trim();
  return !!raw && /^[0-9a-f]+$/.test(raw) && raw.length % 2 === 0;
}

function routeScopeToHex(route: BncrRoute): string {
  const raw = `${route.platform}:${route.groupId}:${route.userId}`;
  return Buffer.from(raw, 'utf8').toString('hex').toLowerCase();
}

function parseRouteFromHexScope(scopeHex: string): BncrRoute | null {
  const rawHex = asString(scopeHex).trim().toLowerCase();
  if (!isLowerHex(rawHex)) return null;

  try {
    const decoded = Buffer.from(rawHex, 'hex').toString('utf8');
    return parseRouteFromScope(decoded);
  } catch {
    return null;
  }
}

function parseRouteLike(input: unknown): BncrRoute | null {
  const platform = asString((input as any)?.platform || '').trim();
  const groupId = asString((input as any)?.groupId || '').trim();
  const userId = asString((input as any)?.userId || '').trim();
  if (!platform || !groupId || !userId) return null;
  return { platform, groupId, userId };
}

function parseLegacySessionKeyToStrict(input: string): string | null {
  const raw = asString(input).trim();
  if (!raw) return null;

  const directLegacy = raw.match(/^agent:main:bncr:direct:([0-9a-fA-F]+):0$/);
  if (directLegacy?.[1]) {
    const route = parseRouteFromHexScope(directLegacy[1].toLowerCase());
    if (route) return buildFallbackSessionKey(route);
  }

  const bncrLegacy = raw.match(/^bncr:([0-9a-fA-F]+):0$/);
  if (bncrLegacy?.[1]) {
    const route = parseRouteFromHexScope(bncrLegacy[1].toLowerCase());
    if (route) return buildFallbackSessionKey(route);
  }

  const agentLegacy = raw.match(/^agent:main:bncr:([0-9a-fA-F]+):0$/);
  if (agentLegacy?.[1]) {
    const route = parseRouteFromHexScope(agentLegacy[1].toLowerCase());
    if (route) return buildFallbackSessionKey(route);
  }

  if (isLowerHex(raw.toLowerCase())) {
    const route = parseRouteFromHexScope(raw.toLowerCase());
    if (route) return buildFallbackSessionKey(route);
  }

  return null;
}

function isLegacyNoiseRoute(route: BncrRoute): boolean {
  const platform = asString(route.platform).trim().toLowerCase();
  const groupId = asString(route.groupId).trim().toLowerCase();
  const userId = asString(route.userId).trim().toLowerCase();

  // 明确排除历史污染：agent:main:bncr（不是实际外部会话路由）
  if (platform === 'agent' && groupId === 'main' && userId === 'bncr') return true;

  // 明确排除嵌套遗留：bncr:<hex>:0（非真实外部 peer）
  if (platform === 'bncr' && userId === '0' && isLowerHex(groupId)) return true;

  return false;
}

function normalizeStoredSessionKey(input: string): { sessionKey: string; route: BncrRoute } | null {
  const raw = asString(input).trim();
  if (!raw) return null;

  let taskKey: string | null = null;
  let base = raw;

  const taskTagged = raw.match(/^(.*):task:([a-z0-9_-]{1,32})$/i);
  if (taskTagged) {
    base = asString(taskTagged[1]).trim();
    taskKey = normalizeTaskKey(taskTagged[2]);
  }

  const strict = parseStrictBncrSessionKey(base);
  if (strict) {
    if (isLegacyNoiseRoute(strict.route)) return null;
    return {
      sessionKey: taskKey ? `${strict.sessionKey}:task:${taskKey}` : strict.sessionKey,
      route: strict.route,
    };
  }

  const migrated = parseLegacySessionKeyToStrict(base);
  if (!migrated) return null;

  const parsed = parseStrictBncrSessionKey(migrated);
  if (!parsed) return null;
  if (isLegacyNoiseRoute(parsed.route)) return null;

  return {
    sessionKey: taskKey ? `${parsed.sessionKey}:task:${taskKey}` : parsed.sessionKey,
    route: parsed.route,
  };
}

const BNCR_SESSION_KEY_PREFIX = 'agent:main:bncr:direct:';

function hex2utf8SessionKey(str: string): { sessionKey: string; scope: string } {
  const raw = {
    sessionKey: '',
    scope: '',
  };
  if (!str) return raw;

  const strarr = asString(str).trim().split(':');
  const newarr: string[] = [];

  for (const s of strarr) {
    const part = asString(s).trim();
    if (!part) {
      newarr.push(part);
      continue;
    }

    const decoded = Buffer.from(part, 'hex').toString('utf8');
    if (decoded?.split(':')?.length === 3) {
      newarr.push(decoded);
      raw.scope = decoded;
    } else {
      newarr.push(part);
    }
  }

  raw.sessionKey = newarr.join(':').trim();
  return raw;
}

function parseStrictBncrSessionKey(input: string): { sessionKey: string; scopeHex: string; route: BncrRoute } | null {
  const raw = asString(input).trim();
  if (!raw) return null;
  if (!raw.startsWith(BNCR_SESSION_KEY_PREFIX)) return null;

  const parts = raw.split(':');
  // 仅接受：agent:main:bncr:direct:<hexScope>
  if (parts.length !== 5) return null;
  if (parts[0] !== 'agent' || parts[1] !== 'main' || parts[2] !== 'bncr' || parts[3] !== 'direct') {
    return null;
  }

  const scopeHex = asString(parts[4]).trim().toLowerCase();
  if (!isLowerHex(scopeHex)) return null;

  const decoded = hex2utf8SessionKey(raw);
  const route = parseRouteFromScope(decoded.scope);
  if (!route) return null;

  return {
    sessionKey: raw,
    scopeHex,
    route,
  };
}

function normalizeInboundSessionKey(scope: string, route: BncrRoute): string | null {
  const raw = asString(scope).trim();
  if (!raw) return buildFallbackSessionKey(route);

  const parsed = parseStrictBncrSessionKey(raw);
  if (!parsed) return null;
  return parsed.sessionKey;
}

function normalizeTaskKey(input: unknown): string | null {
  const raw = asString(input).trim().toLowerCase();
  if (!raw) return null;

  const normalized = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return normalized || null;
}

function extractInlineTaskKey(text: string): { taskKey: string | null; text: string } {
  const raw = asString(text);
  if (!raw) return { taskKey: null, text: '' };

  // 形如：#task:xxx 或 /task:xxx
  const tagged = raw.match(/^\s*(?:#task|\/task)\s*[:=]\s*([a-zA-Z0-9_-]{1,32})\s*\n?\s*([\s\S]*)$/i);
  if (tagged) {
    return {
      taskKey: normalizeTaskKey(tagged[1]),
      text: asString(tagged[2]),
    };
  }

  // 形如：/task xxx 后跟正文
  const spaced = raw.match(/^\s*\/task\s+([a-zA-Z0-9_-]{1,32})\s+([\s\S]*)$/i);
  if (spaced) {
    return {
      taskKey: normalizeTaskKey(spaced[1]),
      text: asString(spaced[2]),
    };
  }

  return { taskKey: null, text: raw };
}

function withTaskSessionKey(sessionKey: string, taskKey?: string | null): string {
  const base = asString(sessionKey).trim();
  const tk = normalizeTaskKey(taskKey);
  if (!base || !tk) return base;

  if (/:task:[a-z0-9_-]+(?:$|:)/i.test(base)) return base;
  return `${base}:task:${tk}`;
}

function buildFallbackSessionKey(route: BncrRoute): string {
  return `${BNCR_SESSION_KEY_PREFIX}${routeScopeToHex(route)}`;
}

function backoffMs(retryCount: number): number {
  // 1s,2s,4s,8s... capped by retry count checks
  return Math.max(1_000, 1_000 * 2 ** Math.max(0, retryCount - 1));
}

function inboundDedupKey(params: {
  accountId: string;
  platform: string;
  groupId: string;
  userId: string;
  msgId?: string;
  text?: string;
  mediaBase64?: string;
}): string {
  const accountId = normalizeAccountId(params.accountId);
  const platform = asString(params.platform).trim().toLowerCase();
  const groupId = asString(params.groupId).trim();
  const userId = asString(params.userId).trim();
  const msgId = asString(params.msgId || '').trim();

  if (msgId) return `${accountId}|${platform}|${groupId}|${userId}|msg:${msgId}`;

  const text = asString(params.text || '').trim();
  const media = asString(params.mediaBase64 || '');
  const digest = createHash('sha1').update(`${text}\n${media.slice(0, 256)}`).digest('hex').slice(0, 16);
  return `${accountId}|${platform}|${groupId}|${userId}|hash:${digest}`;
}

function resolveChatType(route: BncrRoute): 'direct' | 'group' {
  return route.groupId === '0' ? 'direct' : 'group';
}

function routeKey(accountId: string, route: BncrRoute): string {
  return `${accountId}:${route.platform}:${route.groupId}:${route.userId}`.toLowerCase();
}

class BncrBridgeRuntime {
  private api: OpenClawPluginApi;
  private statePath: string | null = null;

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

  private saveTimer: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private waiters = new Map<string, Array<() => void>>();
  private gatewayContext: GatewayRequestHandlerOptions['context'] | null = null;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
  }

  startService = async (ctx: OpenClawPluginServiceContext) => {
    this.statePath = path.join(ctx.stateDir, 'bncr-bridge-state.json');
    await this.loadState();
    this.api.logger.info('bncr-channel service started');
  };

  stopService = async () => {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    await this.flushState();
    this.api.logger.info('bncr-channel service stopped');
  };

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushState();
    }, 300);
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
    if (!ctx) return false;

    const connIds = this.resolvePushConnIds(entry.accountId);
    if (!connIds.size) return false;

    try {
      const payload = {
        ...entry.payload,
        idempotencyKey: entry.messageId,
      };

      ctx.broadcastToConnIds(BNCR_PUSH_EVENT, payload, connIds);
      this.outbox.delete(entry.messageId);
      this.lastOutboundByAccount.set(entry.accountId, now());
      this.markActivity(entry.accountId);
      this.scheduleSave();
      return true;
    } catch (error) {
      entry.lastError = asString((error as any)?.message || error || 'push-error');
      this.outbox.set(entry.messageId, entry);
      return false;
    }
  }

  private schedulePushDrain(delayMs = 0) {
    if (this.pushTimer) return;
    const delay = Math.max(0, Math.min(Number(delayMs || 0), 30_000));
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.flushPushQueue();
    }, delay);
  }

  private flushPushQueue(accountId?: string) {
    const t = now();
    const filterAcc = accountId ? normalizeAccountId(accountId) : null;
    const entries = Array.from(this.outbox.values())
      .filter((entry) => (filterAcc ? entry.accountId === filterAcc : true))
      .sort((a, b) => a.createdAt - b.createdAt);

    let changed = false;
    let nextDelay: number | null = null;

    for (const entry of entries) {
      if (!this.isOnline(entry.accountId)) continue;

      if (entry.nextAttemptAt > t) {
        const wait = entry.nextAttemptAt - t;
        nextDelay = nextDelay == null ? wait : Math.min(nextDelay, wait);
        continue;
      }

      const pushed = this.tryPushEntry(entry);
      if (pushed) {
        changed = true;
        continue;
      }

      const nextAttempt = entry.retryCount + 1;
      if (nextAttempt > MAX_RETRY) {
        this.moveToDeadLetter(entry, entry.lastError || 'push-retry-limit');
        changed = true;
        continue;
      }

      entry.retryCount = nextAttempt;
      entry.lastAttemptAt = t;
      entry.nextAttemptAt = t + backoffMs(nextAttempt);
      entry.lastError = entry.lastError || 'push-retry';
      this.outbox.set(entry.messageId, entry);
      changed = true;

      const wait = entry.nextAttemptAt - t;
      nextDelay = nextDelay == null ? wait : Math.min(nextDelay, wait);
    }

    if (changed) this.scheduleSave();
    if (nextDelay != null) this.schedulePushDrain(nextDelay);
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
      if (c.lastSeenAt < staleBefore) this.connections.delete(key);
    }

    // 清理去重窗口（90s）
    const dedupWindowMs = 90_000;
    for (const [key, ts] of this.recentInbound.entries()) {
      if (t - ts > dedupWindowMs) this.recentInbound.delete(key);
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
  // 1) 先接受任意标签输入（strict / platform:group:user / Bncr-platform:group:user）
  // 2) 再通过已知会话路由反查“真实 sessionKey”
  // 3) 若反查不到或不属于 bncr，会直接失败（禁止拼凑 key 发送）
  private resolveVerifiedTarget(rawTarget: string, accountId: string): { sessionKey: string; route: BncrRoute; displayScope: string } {
    const acc = normalizeAccountId(accountId);
    const raw = asString(rawTarget).trim();
    if (!raw) throw new Error('bncr invalid target(empty)');

    this.api.logger.info?.(`[bncr-target-incoming] raw=${raw} accountId=${acc}`);

    let route: BncrRoute | null = null;

    const strict = parseStrictBncrSessionKey(raw);
    if (strict) {
      route = strict.route;
    } else {
      route = parseRouteFromDisplayScope(raw) || this.resolveRouteBySession(raw, acc);
    }

    if (!route) {
      this.api.logger.warn?.(`[bncr-target-invalid] raw=${raw} accountId=${acc} reason=unparseable-or-unknown`);
      throw new Error(`bncr invalid target(label/sessionKey required): ${raw}`);
    }

    const wantedRouteKey = routeKey(acc, route);
    let best: { sessionKey: string; route: BncrRoute; updatedAt: number } | null = null;

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

    if (!best) {
      this.api.logger.warn?.(`[bncr-target-miss] raw=${raw} accountId=${acc} sessionRoutes=${this.sessionRoutes.size}`);
      throw new Error(`bncr target not found in known sessions: ${raw}`);
    }

    return {
      sessionKey: best.sessionKey,
      route: best.route,
      displayScope: formatDisplayScope(best.route),
    };
  }

  private markActivity(accountId: string, at = now()) {
    this.lastActivityByAccount.set(normalizeAccountId(accountId), at);
  }

  private fmtAgo(ts?: number | null): string {
    if (!ts || !Number.isFinite(ts) || ts <= 0) return '-';
    const diff = Math.max(0, now() - ts);
    if (diff < 1_000) return 'just now';
    if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  private buildStatusMeta(accountId: string) {
    const acc = normalizeAccountId(accountId);
    const pending = Array.from(this.outbox.values()).filter((v) => v.accountId === acc).length;
    const dead = this.deadLetter.filter((v) => v.accountId === acc).length;
    const last = this.lastSessionByAccount.get(acc);
    const lastActAt = this.lastActivityByAccount.get(acc) || null;
    const lastInboundAt = this.lastInboundByAccount.get(acc) || null;
    const lastOutboundAt = this.lastOutboundByAccount.get(acc) || null;

    const lastSessionAgo = this.fmtAgo(last?.updatedAt || null);
    const lastActivityAgo = this.fmtAgo(lastActAt);
    const lastInboundAgo = this.fmtAgo(lastInboundAt);
    const lastOutboundAgo = this.fmtAgo(lastOutboundAt);

    return {
      pending,
      deadLetter: dead,
      lastSessionKey: last?.sessionKey || null,
      lastSessionScope: last?.scope || null,
      lastSessionAt: last?.updatedAt || null,
      lastSessionAgo,
      lastActivityAt: lastActAt,
      lastActivityAgo,
      lastInboundAt,
      lastInboundAgo,
      lastOutboundAt,
      lastOutboundAgo,
    };
  }

  getAccountRuntimeSnapshot(accountId: string) {
    const acc = normalizeAccountId(accountId);
    const connected = this.isOnline(acc);
    const lastEventAt = this.lastActivityByAccount.get(acc) || null;
    const lastInboundAt = this.lastInboundByAccount.get(acc) || null;
    const lastOutboundAt = this.lastOutboundByAccount.get(acc) || null;
    return {
      accountId: acc,
      running: true,
      connected,
      linked: connected,
      lastEventAt,
      lastInboundAt,
      lastOutboundAt,
      // 状态映射：在线=linked，离线=configured
      mode: connected ? 'linked' : 'configured',
      meta: this.buildStatusMeta(acc),
    };
  }

  getChannelSummary(defaultAccountId: string) {
    const runtime = this.getAccountRuntimeSnapshot(defaultAccountId);
    if (runtime.connected) {
      return { linked: true };
    }

    // 顶层汇总不绑定某个 accountId：任一账号在线都应显示 linked
    const t = now();
    for (const c of this.connections.values()) {
      if (t - c.lastSeenAt <= CONNECT_TTL_MS) {
        return { linked: true };
      }
    }

    return { linked: false };
  }

  private enqueueOutbound(entry: OutboxEntry) {
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
        const media = await this.payloadMediaToBase64(mediaUrl, mediaLocalRoots);
        const messageId = randomUUID();
        const mediaMsg = first ? asString(payload.text || '') : '';
        const frame = {
          type: 'message.outbound',
          messageId,
          idempotencyKey: messageId,
          sessionKey,
          message: {
            platform: route.platform,
            groupId: route.groupId,
            userId: route.userId,
            type: media.mimeType,
            msg: mediaMsg,
            path: mediaUrl,
            base64: media.mediaBase64,
            fileName: media.fileName,
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

    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);

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

    const messageId = asString(params?.messageId || '').trim();
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
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);

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

  handleInbound = async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
    const accountId = normalizeAccountId(asString(params?.accountId || ''));
    const connId = asString(client?.connId || '').trim() || `no-conn-${Date.now()}`;
    const clientId = asString((params as any)?.clientId || '').trim() || undefined;
    this.rememberGatewayContext(context);
    this.markSeen(accountId, connId, clientId);
    this.markActivity(accountId);

    const platform = asString(params?.platform || '').trim();
    const groupId = asString(params?.groupId || '0').trim() || '0';
    const userId = asString(params?.userId || '').trim();
    const sessionKeyfromroute = asString(params?.sessionKey || '').trim();

    if (!platform || (!userId && !groupId)) {
      respond(false, { error: 'platform/groupId/userId required' });
      return;
    }

    const route: BncrRoute = {
      platform,
      groupId,
      userId,
    };

    const text = asString(params?.msg || '');
    const msgType = asString(params?.type || 'text') || 'text';
    const mediaBase64 = asString(params?.base64 || '');
    const mimeType = asString(params?.mimeType || '').trim() || undefined;
    const fileName = asString(params?.fileName || '').trim() || undefined;
    const msgId = asString(params?.msgId || '').trim() || undefined;

    const dedupKey = inboundDedupKey({
      accountId,
      platform,
      groupId,
      userId,
      msgId,
      text,
      mediaBase64,
    });
    if (this.markInboundDedupSeen(dedupKey)) {
      respond(true, {
        accepted: true,
        duplicated: true,
        accountId,
        msgId: msgId ?? null,
      });
      return;
    }

    const peer = {
      kind: resolveChatType(route),
      id: route.groupId === '0' ? route.userId : route.groupId,
    } as const;

    const cfg = await this.api.runtime.config.loadConfig();
    const resolvedRoute = this.api.runtime.channel.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId,
      peer,
    });

    const baseSessionKey = normalizeInboundSessionKey(sessionKeyfromroute, route) || resolvedRoute.sessionKey;

    // 轻量任务拆分：允许在消息前缀中声明 task key，将任务分流到子会话，降低单会话上下文压力。
    // 支持：#task:foo / /task:foo / /task foo <正文>
    const extracted = extractInlineTaskKey(text);
    const agentText = extracted.text;
    const taskSessionKey = withTaskSessionKey(baseSessionKey, extracted.taskKey);
    const sessionKey = taskSessionKey || baseSessionKey;

    this.rememberSessionRoute(baseSessionKey, accountId, route);
    if (taskSessionKey && taskSessionKey !== baseSessionKey) {
      this.rememberSessionRoute(taskSessionKey, accountId, route);
    }

    // 先回 ACK，后异步处理 AI 回复
    respond(true, {
      accepted: true,
      accountId,
      sessionKey,
      msgId: msgId ?? null,
      taskKey: extracted.taskKey ?? null,
    });

    void (async () => {
      try {
        const storePath = this.api.runtime.channel.session.resolveStorePath(cfg?.session?.store, {
          agentId: resolvedRoute.agentId,
        });

        let mediaPath: string | undefined;
        if (mediaBase64) {
          const mediaBuf = Buffer.from(mediaBase64, 'base64');
          const saved = await this.api.runtime.channel.media.saveMediaBuffer(
            mediaBuf,
            mimeType,
            'inbound',
            30 * 1024 * 1024,
            fileName,
          );
          mediaPath = saved.path;
        }

        const rawBody = agentText || (msgType === 'text' ? '' : `[${msgType}]`);
        const body = this.api.runtime.channel.reply.formatAgentEnvelope({
          channel: 'Bncr',
          from: `${platform}:${groupId}:${userId}`,
          timestamp: Date.now(),
          previousTimestamp: this.api.runtime.channel.session.readSessionUpdatedAt({
            storePath,
            sessionKey,
          }),
          envelope: this.api.runtime.channel.reply.resolveEnvelopeFormatOptions(cfg),
          body: rawBody,
        });

        const displayTo = formatDisplayScope(route);
        const ctxPayload = this.api.runtime.channel.reply.finalizeInboundContext({
          Body: body,
          BodyForAgent: rawBody,
          RawBody: rawBody,
          CommandBody: rawBody,
          MediaPath: mediaPath,
          MediaType: mimeType,
          From: `${CHANNEL_ID}:${platform}:${groupId}:${userId}`,
          To: displayTo,
          SessionKey: sessionKey,
          AccountId: accountId,
          ChatType: peer.kind,
          ConversationLabel: displayTo,
          SenderId: userId,
          Provider: CHANNEL_ID,
          Surface: CHANNEL_ID,
          MessageSid: msgId,
          Timestamp: Date.now(),
          OriginatingChannel: CHANNEL_ID,
          OriginatingTo: displayTo,
        });

        await this.api.runtime.channel.session.recordInboundSession({
          storePath,
          sessionKey,
          ctx: ctxPayload,
          onRecordError: (err) => {
            this.api.logger.warn?.(`bncr: record session failed: ${String(err)}`);
          },
        });

        // 记录真正的业务活动时间（入站已完成解析并落会话）
        const inboundAt = now();
        this.lastInboundByAccount.set(accountId, inboundAt);
        this.markActivity(accountId, inboundAt);
        this.scheduleSave();

        await this.api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          // BNCR 侧仅推送最终回复，不要流式 block 推送
          replyOptions: {
            disableBlockStreaming: true,
          },
          dispatcherOptions: {
            deliver: async (
              payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
              info?: { kind?: 'tool' | 'block' | 'final' },
            ) => {
              // 过滤掉流式 block/tool，仅投递 final
              if (info?.kind && info.kind !== 'final') return;

              await this.enqueueFromReply({
                accountId,
                sessionKey,
                route,
                payload,
              });
            },
            onError: (err: unknown) => {
              this.api.logger.error?.(`bncr reply failed: ${String(err)}`);
            },
          },
        });
      } catch (err) {
        this.api.logger.error?.(`bncr inbound process failed: ${String(err)}`);
      }
    })();
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

    const verified = this.resolveVerifiedTarget(to, accountId);

    this.rememberSessionRoute(verified.sessionKey, accountId, verified.route);

    await this.enqueueFromReply({
      accountId,
      sessionKey: verified.sessionKey,
      route: verified.route,
      payload: {
        text: asString(ctx.text || ''),
      },
      mediaLocalRoots: ctx.mediaLocalRoots,
    });

    return { channel: CHANNEL_ID, messageId: randomUUID(), chatId: verified.sessionKey };
  };

  channelSendMedia = async (ctx: any) => {
    const accountId = normalizeAccountId(ctx.accountId);
    const to = asString(ctx.to || '').trim();

    const verified = this.resolveVerifiedTarget(to, accountId);

    this.rememberSessionRoute(verified.sessionKey, accountId, verified.route);

    await this.enqueueFromReply({
      accountId,
      sessionKey: verified.sessionKey,
      route: verified.route,
      payload: {
        text: asString(ctx.text || ''),
        mediaUrl: asString(ctx.mediaUrl || ''),
      },
      mediaLocalRoots: ctx.mediaLocalRoots,
    });

    return { channel: CHANNEL_ID, messageId: randomUUID(), chatId: verified.sessionKey };
  };
}

function resolveDefaultDisplayName(rawName: unknown, accountId: string): string {
  const raw = asString(rawName || '').trim();
  // 统一兜底：空名 / 与 accountId 重复 / 历史默认名 => Monitor
  if (!raw || raw === accountId || /^bncr$/i.test(raw) || /^status$/i.test(raw) || /^runtime$/i.test(raw)) return 'Monitor';
  return raw;
}

function resolveAccount(cfg: any, accountId?: string | null) {
  const accounts = cfg?.channels?.[CHANNEL_ID]?.accounts || {};
  let key = normalizeAccountId(accountId);

  // 若请求的 accountId 不存在（例如框架仍传 default），回退到首个已配置账号
  if (!accounts[key]) {
    const first = Object.keys(accounts)[0];
    if (first) key = first;
  }

  const account = accounts[key] || {};
  const displayName = resolveDefaultDisplayName(account?.name, key);
  return {
    accountId: key,
    // accountId(default) 无法隐藏时，给稳定默认名，避免空名或 default(default)
    name: displayName,
    enabled: account?.enabled !== false,
  };
}

function listAccountIds(cfg: any): string[] {
  const ids = Object.keys(cfg?.channels?.[CHANNEL_ID]?.accounts || {});
  return ids.length ? ids : [BNCR_DEFAULT_ACCOUNT_ID];
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
      nativeCommands: false,
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
        hint: 'Any label accepted; will be validated against known bncr sessions before send',
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
      isEnabled: (account: any) => account?.enabled !== false,
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
    gatewayMethods: ['bncr.connect', 'bncr.inbound', 'bncr.activity', 'bncr.ack'],
    gateway: {
      startAccount: bridge.channelStartAccount,
      stopAccount: bridge.channelStopAccount,
    },
  };

  return plugin;
}
