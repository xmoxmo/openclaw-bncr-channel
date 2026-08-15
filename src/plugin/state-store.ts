import { createHash } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  dumpRegisterDriftSnapshot,
  normalizeRegisterDriftSnapshot,
} from '../core/register-trace.ts';
import type { BncrRoute, OutboxEntry } from '../core/types.ts';
import {
  type BncrConversationHistoryMap,
  buildBncrBotReplyMessageId,
  buildBncrConversationHistoryKeyFromRoute,
  resetConversationHistoryVersions,
  resolveBncrHistoryLimit,
} from '../messaging/inbound/conversation-history.ts';
import {
  getConversationHistorySerialOwner,
  readConversationHistorySerialHistoryKeys,
} from '../messaging/inbound/conversation-history-serial.ts';
import type {
  BncrOutboundReplayEntry,
  BncrOutboundReplayStatus,
} from '../messaging/inbound/outbound-replay-cache.ts';
import {
  readOpenClawJsonFileWithFallback,
  writeOpenClawJsonFileAtomically,
} from '../openclaw/sdk-helpers.ts';
import type {
  BncrGroupReplyMode,
  BncrPersistedAccountTimestamp,
  BncrPersistedConversationHistoryBucket,
  BncrPersistedConversationHistoryEntry,
  BncrPersistedConversationHistoryMediaEntry,
  BncrPersistedLastSession,
  BncrPersistedOutboundReplayBucket,
  BncrPersistedOutboundReplayEntry,
  BncrPersistedSessionRoute,
  PersistedState as BncrPersistedState,
  BncrSceneRecord,
} from './channel-runtime-types.ts';
import type {
  BncrHistoryShardCreateInput,
  BncrHistoryShardCreateResult,
  BncrHistoryShardQueue,
  BncrSqliteControlState,
  BncrSqliteHistoryState,
  BncrSqliteOutboundState,
  BncrSqliteStateDatabase,
} from './sqlite-state.ts';

const GROUP_REPLY_MODES = new Set<BncrGroupReplyMode>(['admin', 'mention', 'hybrid', 'all']);
const DEFAULT_PERSISTED_CONVERSATION_HISTORY_LIMIT = 50;

type BncrPersistedStateStoreInput = {
  outbox?: unknown;
  deadLetter?: unknown;
  sessionRoutes?: unknown;
  sceneRegistry?: unknown;
  conversationHistories?: unknown;
  groupHistories?: unknown;
  outboundReplayCache?: unknown;
  // Legacy persisted key from before the outboundReplayCache rename.
  messageCache?: unknown;
  lastSessionByAccount?: unknown;
  lastActivityByAccount?: unknown;
  lastInboundByAccount?: unknown;
  lastOutboundByAccount?: unknown;
  lastDriftSnapshot?: unknown;
};

type PersistedAccountTimestampInput = Partial<BncrPersistedAccountTimestamp>;
type PersistedLastSessionInput = Partial<BncrPersistedLastSession>;
type PersistedSessionRouteInput = Partial<BncrPersistedSessionRoute>;
type PersistedSceneRecordInput = Partial<BncrSceneRecord>;
type PersistedConversationHistoryBucketInput = Partial<BncrPersistedConversationHistoryBucket>;
type PersistedConversationHistoryEntryInput = Partial<BncrPersistedConversationHistoryEntry>;
type PersistedOutboundReplayBucketInput = Partial<BncrPersistedOutboundReplayBucket>;
type PersistedOutboundReplayEntryInput = Partial<BncrOutboundReplayEntry>;

const bncrHistoryShardQueues = new WeakMap<BncrConversationHistoryMap, BncrHistoryShardQueue>();

export function registerBncrHistoryShardQueue(
  historyMap: BncrConversationHistoryMap,
  queue: BncrHistoryShardQueue,
): void {
  bncrHistoryShardQueues.set(historyMap, queue);
}

export function getBncrHistoryShardQueue(
  historyMap: BncrConversationHistoryMap,
): BncrHistoryShardQueue | undefined {
  return bncrHistoryShardQueues.get(historyMap);
}

function buildMigratedHistoryMessageId(seed: string): string {
  const digest = createHash('sha1').update(seed).digest('hex').slice(0, 24);
  return `bncr-synthetic:migrated:${digest}`;
}

function formatSqliteCutoverTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

export function createBncrStateStore(runtime: {
  getStatePath: () => string | null;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  finiteNumberOr: (value: unknown, fallback: number) => number;
  normalizeAccountId: (accountId: string) => string;
  normalizeStoredSessionKey: (
    sessionKey: string,
    canonicalAgentId?: string,
  ) => {
    sessionKey: string;
    route: BncrRoute;
  } | null;
  parseRouteLike: (value: unknown) => BncrRoute | null;
  routeKey: (accountId: string, route: BncrRoute) => string;
  formatDisplayScope: (route: BncrRoute) => string;
  canonicalAgentId: () => string;
  normalizePersistedOutboxEntry: (entry: unknown) => OutboxEntry | null;
  maxDeadLetterEntries: number;
  maxSessionRouteEntries: number;
  maxAccountActivityEntries: number;
  sceneRegistry: Map<string, BncrSceneRecord>;
  conversationHistories: Map<string, BncrPersistedConversationHistoryEntry[]>;
  outboundReplayCache?: Map<string, BncrPersistedOutboundReplayEntry[]>;
  outbox: Map<string, OutboxEntry>;
  getDeadLetter: () => OutboxEntry[];
  setDeadLetter: (entries: OutboxEntry[]) => void;
  sessionRoutes: Map<string, { accountId: string; route: BncrRoute; updatedAt: number }>;
  routeAliases: Map<string, { accountId: string; route: BncrRoute; updatedAt: number }>;
  lastSessionByAccount: Map<string, { sessionKey: string; scope: string; updatedAt: number }>;
  lastActivityByAccount: Map<string, number>;
  lastInboundByAccount: Map<string, number>;
  lastOutboundByAccount: Map<string, number>;
  getLastDriftSnapshot: () => BncrPersistedState['lastDriftSnapshot'];
  setLastDriftSnapshot: (value: BncrPersistedState['lastDriftSnapshot']) => void;
  sqliteState?: BncrSqliteStateDatabase;
  createSqliteState?: (
    statePath: string | null,
  ) => BncrSqliteStateDatabase | PromiseLike<BncrSqliteStateDatabase | null> | null;
}) {
  const outboundReplayCache =
    runtime.outboundReplayCache ?? new Map<string, BncrPersistedOutboundReplayEntry[]>();
  let sqliteState: BncrSqliteStateDatabase | undefined;

  async function resolveSqliteState(
    statePath: string | null,
  ): Promise<BncrSqliteStateDatabase | undefined> {
    if (!sqliteState) {
      sqliteState =
        runtime.sqliteState ?? (await runtime.createSqliteState?.(statePath)) ?? undefined;
    }
    return sqliteState;
  }

  function resolvePersistedConversationHistoryLimit(key: string): number {
    const scene = runtime.sceneRegistry.get(key);
    const sceneLimit = resolveBncrHistoryLimit(scene?.historyLimit);
    return Math.max(DEFAULT_PERSISTED_CONVERSATION_HISTORY_LIMIT, Math.ceil(sceneLimit * 1.2));
  }

  function resolveOutboundReplayBucketHistoryKey(
    bucketKey: string,
    entries: readonly BncrOutboundReplayEntry[],
  ): string | null {
    const route = entries.find((entry) => runtime.parseRouteLike(entry?.route))?.route;
    if (route) {
      return buildBncrConversationHistoryKeyFromRoute({
        platform: route.platform,
        groupId: route.groupId,
        userId: route.userId,
      });
    }
    const separator = bucketKey.indexOf(':');
    if (separator < 0 || separator >= bucketKey.length - 1) return null;
    return bucketKey.slice(separator + 1).trim() || null;
  }

  function resolveOutboundReplayBucketLimit(
    bucketKey: string,
    entries: readonly BncrOutboundReplayEntry[],
  ): number {
    const historyKey = resolveOutboundReplayBucketHistoryKey(bucketKey, entries);
    if (!historyKey) return DEFAULT_PERSISTED_CONVERSATION_HISTORY_LIMIT;
    return resolveBncrHistoryLimit(runtime.sceneRegistry.get(historyKey)?.historyLimit);
  }

  function normalizeOutboundReplayBucket(
    bucketKey: string,
    entries: readonly BncrOutboundReplayEntry[],
  ): BncrOutboundReplayEntry[] {
    return entries
      .slice()
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
      .slice(-resolveOutboundReplayBucketLimit(bucketKey, entries));
  }

  function loadPersistedSceneRegistry(persisted: unknown): void {
    runtime.sceneRegistry.clear();
    const items = Array.isArray(persisted) ? (persisted as PersistedSceneRecordInput[]) : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const sceneKey = runtime.asString(item.sceneKey || '').trim();
      const kind = runtime.asString(item.kind || '').trim();
      const status = runtime.asString(item.status || '').trim();
      const platform = runtime.asString(item.platform || '').trim();
      const lastSeenAt = runtime.finiteNumberOr(item.lastSeenAt, 0);
      if (!sceneKey || !platform || lastSeenAt <= 0) continue;
      if (kind !== 'direct' && kind !== 'group') continue;
      if (status !== 'pending' && status !== 'allowed' && status !== 'denied') continue;

      runtime.sceneRegistry.set(sceneKey, {
        sceneKey,
        kind,
        status,
        platform,
        ...(runtime.asString(item.userId || '').trim()
          ? { userId: runtime.asString(item.userId || '').trim() }
          : {}),
        ...(runtime.asString(item.userName || '').trim()
          ? { userName: runtime.asString(item.userName || '').trim() }
          : {}),
        ...(runtime.asString(item.groupId || '').trim()
          ? { groupId: runtime.asString(item.groupId || '').trim() }
          : {}),
        ...(runtime.asString(item.groupName || '').trim()
          ? { groupName: runtime.asString(item.groupName || '').trim() }
          : {}),
        ...(runtime.asString(item.agentId || '').trim()
          ? { agentId: runtime.asString(item.agentId || '').trim() }
          : {}),
        ...(kind === 'group' &&
        GROUP_REPLY_MODES.has(
          runtime.asString(item.groupReplyMode || '').trim() as BncrGroupReplyMode,
        )
          ? {
              groupReplyMode: runtime
                .asString(item.groupReplyMode || '')
                .trim() as BncrGroupReplyMode,
            }
          : {}),
        ...(typeof item.historyLimit === 'number' &&
        Number.isFinite(item.historyLimit) &&
        Math.floor(item.historyLimit) >= 2
          ? { historyLimit: Math.floor(item.historyLimit) }
          : {}),
        ...(typeof item.historyForce === 'boolean' ? { historyForce: item.historyForce } : {}),
        ...(typeof item.downloadMedia === 'boolean' ? { downloadMedia: item.downloadMedia } : {}),
        lastSeenAt,
      });
    }
  }

  function dumpPersistedSceneRegistry() {
    return Array.from(runtime.sceneRegistry.values()).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  }

  function loadPersistedHistoryBuckets(
    persisted: unknown,
    target: Map<string, BncrPersistedConversationHistoryEntry[]>,
    resolveLimit: (key: string) => number,
    options?: {
      assistantMessageIdsByHistoryKey?: ReadonlyMap<string, ReadonlySet<string>>;
      merge?: boolean;
    },
  ): void {
    if (!options?.merge) target.clear();
    const buckets = Array.isArray(persisted)
      ? (persisted as PersistedConversationHistoryBucketInput[])
      : [];
    for (const bucket of buckets) {
      const key = runtime.asString(bucket?.key || '').trim();
      if (!key) continue;
      const entries: BncrPersistedConversationHistoryEntry[] = [];
      const rawEntries = Array.isArray(bucket?.entries)
        ? (bucket.entries as PersistedConversationHistoryEntryInput[])
        : [];
      for (const [entryIndex, entry] of rawEntries.entries()) {
        const sender = runtime.asString(entry?.sender || '').trim();
        const body = runtime.asString(entry?.body || '').trim();
        if (!sender || !body) continue;
        const timestamp = runtime.finiteNumberOr(entry?.timestamp, 0);
        let messageId = runtime.asString(entry?.messageId || '').trim();

        const media: BncrPersistedConversationHistoryMediaEntry[] = [];
        const rawMedia = Array.isArray(entry?.media)
          ? (entry.media as Partial<BncrPersistedConversationHistoryMediaEntry>[])
          : [];
        for (const item of rawMedia) {
          const path = runtime.asString(item?.path || '').trim();
          if (!path) continue;
          const contentType = runtime.asString(item?.contentType || '').trim();
          const kind = runtime.asString(item?.kind || '').trim();
          const mediaMessageId = runtime.asString(item?.messageId || '').trim();
          const normalizedMedia: BncrPersistedConversationHistoryMediaEntry = {
            path,
            ...(contentType ? { contentType } : {}),
            ...(kind ? { kind: kind as BncrPersistedConversationHistoryMediaEntry['kind'] } : {}),
            // Legacy entries without platform ids are back-filled with a stable
            // synthetic id so snapshot cleanup can still remove them exactly.
            ...(mediaMessageId || messageId ? { messageId: mediaMessageId || messageId } : {}),
          };
          media.push(normalizedMedia);
        }

        const rawRole = entry?.role;
        const assistantMessageIds = options?.assistantMessageIdsByHistoryKey?.get(key);
        const role =
          rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system'
            ? rawRole
            : assistantMessageIds?.has(messageId)
              ? 'assistant'
              : 'user';
        if (!messageId) {
          messageId = buildMigratedHistoryMessageId(
            JSON.stringify({
              key,
              entryIndex,
              sender,
              senderId: runtime.asString(entry?.senderId || '').trim(),
              role,
              body,
              timestamp,
              media: media.map((item) => [item.path, item.contentType, item.kind, item.messageId]),
            }),
          );
        }

        const normalizedEntry: BncrPersistedConversationHistoryEntry = {
          sender,
          ...(runtime.asString(entry?.senderId || '').trim()
            ? { senderId: runtime.asString(entry?.senderId || '').trim() }
            : {}),
          role,
          body,
          ...(timestamp > 0 ? { timestamp } : {}),
          ...(messageId ? { messageId } : {}),
          ...(media.length > 0 ? { media } : {}),
        };
        if (
          messageId &&
          Array.isArray(normalizedEntry.media) &&
          normalizedEntry.media.some((item) => !item.messageId)
        ) {
          normalizedEntry.media = normalizedEntry.media.map((item) =>
            item.messageId
              ? item
              : {
                  ...item,
                  messageId,
                },
          );
        }
        entries.push(normalizedEntry);
      }
      if (entries.length > 0) {
        const limit = resolveLimit(key);
        const merged = options?.merge ? [...(target.get(key) || []), ...entries] : entries;
        const seenMessageIds = new Set<string>();
        const deduped: BncrPersistedConversationHistoryEntry[] = [];
        for (const entry of merged) {
          const messageId = runtime.asString(entry.messageId || '').trim();
          if (messageId && seenMessageIds.has(messageId)) continue;
          if (messageId) seenMessageIds.add(messageId);
          deduped.push(entry);
        }
        target.set(key, Number.isFinite(limit) ? deduped.slice(-limit) : deduped);
      }
    }
  }

  function loadPersistedConversationHistories(
    persisted: unknown,
    options?: { assistantMessageIdsByHistoryKey?: ReadonlyMap<string, ReadonlySet<string>> },
  ): void {
    loadPersistedHistoryBuckets(
      persisted,
      runtime.conversationHistories,
      (key) => resolvePersistedConversationHistoryLimit(key),
      options,
    );
    // Persisted replacement invalidates freshness markers used by queued flushes.
    resetConversationHistoryVersions(runtime.conversationHistories);
  }

  function collectPersistedOutboundAssistantMessageIds(
    persisted: unknown,
  ): Map<string, Set<string>> {
    const messageIdsByHistoryKey = new Map<string, Set<string>>();
    const buckets = Array.isArray(persisted)
      ? (persisted as Array<{ key?: unknown; entries?: unknown }>)
      : [];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      const bucketKey = runtime.asString(bucket?.key || '').trim();
      const rawEntries = Array.isArray(bucket.entries) ? bucket.entries : [];
      for (const entry of rawEntries as Array<{
        sender?: unknown;
        body?: unknown;
        messageId?: unknown;
        route?: { platform?: unknown; groupId?: unknown; userId?: unknown };
      }>) {
        const sender = runtime.asString(entry?.sender || '').trim();
        const body = runtime.asString(entry?.body || '').trim();
        if (!sender || !body) continue;
        const messageId = runtime.asString(entry?.messageId || '').trim();
        if (!messageId) continue;
        const route = entry?.route;
        const historyKey =
          buildBncrConversationHistoryKeyFromRoute({
            platform: typeof route?.platform === 'string' ? route.platform : undefined,
            groupId: typeof route?.groupId === 'string' ? route.groupId : undefined,
            userId: typeof route?.userId === 'string' ? route.userId : undefined,
          }) ?? (bucketKey.includes(':') ? bucketKey.slice(bucketKey.indexOf(':') + 1) : '');
        if (!historyKey) continue;
        const scopedMessageIds = messageIdsByHistoryKey.get(historyKey) ?? new Set<string>();
        scopedMessageIds.add(messageId);
        messageIdsByHistoryKey.set(historyKey, scopedMessageIds);
      }
    }
    return messageIdsByHistoryKey;
  }

  function resolvePersistedOutboundReplayMessageId(args: {
    bucketKey: string;
    sender: string;
    senderId?: string;
    body: string;
    timestamp: number;
    media: BncrPersistedConversationHistoryMediaEntry[];
    route?: BncrRoute | null;
    historyMap?: Map<string, BncrPersistedConversationHistoryEntry[]>;
  }): string | undefined {
    const route = args.route;
    const historyKey = route
      ? buildBncrConversationHistoryKeyFromRoute({
          platform: route.platform,
          groupId: route.groupId,
          userId: route.userId,
        })
      : args.bucketKey.includes(':')
        ? args.bucketKey.slice(args.bucketKey.indexOf(':') + 1).trim()
        : '';
    if (!historyKey) return undefined;

    const matchingHistory = args.historyMap
      ?.get(historyKey)
      ?.find(
        (candidate) =>
          candidate.role === 'assistant' &&
          candidate.sender === args.sender &&
          candidate.body === args.body &&
          (args.timestamp <= 0 || candidate.timestamp === args.timestamp),
      );
    const matchingMessageId = runtime.asString(matchingHistory?.messageId || '').trim();
    if (matchingMessageId) return matchingMessageId;

    return buildBncrBotReplyMessageId({
      historyKey,
      sender: args.sender,
      ...(args.senderId ? { senderId: args.senderId } : {}),
      body: args.body,
      ...(args.timestamp > 0 ? { timestamp: args.timestamp } : {}),
      media: args.media.length > 0 ? args.media : undefined,
    });
  }

  function loadPersistedOutboundReplayCache(
    persisted: unknown,
    options?: {
      merge?: boolean;
      historyMap?: Map<string, BncrPersistedConversationHistoryEntry[]>;
    },
    target: Map<string, BncrPersistedOutboundReplayEntry[]> = outboundReplayCache,
  ): void {
    if (!options?.merge) target.clear();
    const buckets = Array.isArray(persisted)
      ? (persisted as PersistedOutboundReplayBucketInput[])
      : [];
    for (const bucket of buckets) {
      const key = runtime.asString(bucket?.key || '').trim();
      if (!key) continue;
      const entries: BncrOutboundReplayEntry[] = [];
      const rawEntries = Array.isArray(bucket?.entries)
        ? (bucket.entries as PersistedOutboundReplayEntryInput[])
        : [];
      for (const entry of rawEntries) {
        const sender = runtime.asString(entry?.sender || '').trim();
        const body = runtime.asString(entry?.body || '').trim();
        if (!sender || !body) continue;
        const timestamp = runtime.finiteNumberOr(entry?.timestamp, 0);
        const messageId = runtime.asString(entry?.messageId || '').trim();
        const accountId = runtime.asString(entry?.accountId || '').trim();
        const sessionKey = runtime.asString(entry?.sessionKey || '').trim();
        const type = runtime.asString(entry?.type || '').trim();
        const mediaUrl = runtime.asString(entry?.mediaUrl || '').trim();
        const createdAt = runtime.finiteNumberOr(entry?.createdAt, 0);
        const status = runtime.asString(entry?.status || '').trim();
        const route =
          runtime.parseRouteLike(entry?.route) ||
          runtime.parseRouteLike({
            platform: entry?.route?.platform,
            groupId: entry?.route?.groupId,
            userId: entry?.route?.userId,
          });
        const media: BncrPersistedConversationHistoryMediaEntry[] = [];
        const rawMedia = Array.isArray(entry?.media)
          ? (entry.media as Partial<BncrPersistedConversationHistoryMediaEntry>[])
          : [];
        for (const item of rawMedia) {
          const path = runtime.asString(item?.path || '').trim();
          if (!path) continue;
          const contentType = runtime.asString(item?.contentType || '').trim();
          const kind = runtime.asString(item?.kind || '').trim();
          const mediaMessageId = runtime.asString(item?.messageId || '').trim();
          media.push({
            path,
            ...(contentType ? { contentType } : {}),
            ...(kind ? { kind: kind as BncrPersistedConversationHistoryMediaEntry['kind'] } : {}),
            ...(mediaMessageId ? { messageId: mediaMessageId } : {}),
          });
        }
        const resolvedMessageId =
          messageId ||
          resolvePersistedOutboundReplayMessageId({
            bucketKey: key,
            sender,
            senderId: runtime.asString(entry?.senderId || '').trim(),
            body,
            timestamp,
            media,
            route,
            historyMap: options?.historyMap,
          });
        const normalizedMedia = media.map((item) => ({
          ...item,
          ...(item.messageId || resolvedMessageId
            ? { messageId: item.messageId || resolvedMessageId }
            : {}),
        }));
        entries.push({
          sender,
          ...(runtime.asString(entry?.senderId || '').trim()
            ? { senderId: runtime.asString(entry?.senderId || '').trim() }
            : {}),
          body,
          ...(timestamp > 0 ? { timestamp } : {}),
          ...(resolvedMessageId ? { messageId: resolvedMessageId } : {}),
          ...(normalizedMedia.length > 0 ? { media: normalizedMedia } : {}),
          ...(accountId ? { accountId } : {}),
          ...(sessionKey ? { sessionKey } : {}),
          ...(route ? { route } : {}),
          ...(type ? { type } : {}),
          ...(mediaUrl ? { mediaUrl } : {}),
          ...(createdAt > 0 ? { createdAt } : {}),
          ...(status === 'pushed' || status === 'acked'
            ? { status: status as BncrOutboundReplayStatus }
            : {}),
        });
      }
      if (entries.length > 0) {
        const combined = options?.merge ? [...(target.get(key) || []), ...entries] : entries;
        const seenMessageIds = new Set<string>();
        const deduped: BncrOutboundReplayEntry[] = [];
        for (const entry of combined) {
          const messageId = runtime.asString(entry.messageId || '').trim();
          if (messageId && seenMessageIds.has(messageId)) continue;
          if (messageId) seenMessageIds.add(messageId);
          deduped.push(entry);
        }
        if (deduped.length > 0) {
          target.set(key, normalizeOutboundReplayBucket(key, deduped));
        }
      }
    }
  }

  function dumpPersistedHistoryBuckets(
    source: Map<string, BncrPersistedConversationHistoryEntry[]>,
    resolveLimit: (key: string) => number,
  ) {
    return Array.from(source.entries()).map(([key, entries]) => ({
      key,
      entries: Number.isFinite(resolveLimit(key)) ? entries.slice(-resolveLimit(key)) : entries,
    }));
  }

  function dumpPersistedConversationHistories() {
    return dumpPersistedHistoryBuckets(runtime.conversationHistories, (key) =>
      resolvePersistedConversationHistoryLimit(key),
    );
  }

  function dumpPersistedOutboundReplayCache() {
    return Array.from(outboundReplayCache.entries()).map(([key, entries]) => ({
      key,
      entries: normalizeOutboundReplayBucket(key, entries),
    }));
  }

  function dumpPersistedReplayBucketsFromMap(
    source: Map<string, BncrPersistedOutboundReplayEntry[]>,
  ): BncrPersistedOutboundReplayBucket[] {
    return Array.from(source.entries()).map(([key, entries]) => ({
      key,
      entries: normalizeOutboundReplayBucket(key, entries),
    }));
  }

  function buildMergedSqliteHistoryState(
    state: BncrSqliteStateDatabase,
    skipHistoryKeys: readonly string[],
    current?: BncrSqliteHistoryState,
  ): BncrSqliteHistoryState {
    const sqliteHistory =
      current ?? state.loadHistoryState(skipHistoryKeys, getConversationHistorySerialOwner());
    const historyTarget = new Map<string, BncrPersistedConversationHistoryEntry[]>();
    loadPersistedHistoryBuckets(sqliteHistory.historyBuckets, historyTarget, (key) =>
      resolvePersistedConversationHistoryLimit(key),
    );
    loadPersistedHistoryBuckets(
      dumpPersistedConversationHistories(),
      historyTarget,
      (key) => resolvePersistedConversationHistoryLimit(key),
      { merge: true },
    );

    const replayTarget = new Map<string, BncrPersistedOutboundReplayEntry[]>();
    loadPersistedOutboundReplayCache(
      sqliteHistory.replayBuckets,
      { historyMap: runtime.conversationHistories },
      replayTarget,
    );
    loadPersistedOutboundReplayCache(
      dumpPersistedOutboundReplayCache(),
      { merge: true, historyMap: runtime.conversationHistories },
      replayTarget,
    );

    return {
      historyBuckets: dumpPersistedHistoryBuckets(historyTarget, (key) =>
        resolvePersistedConversationHistoryLimit(key),
      ),
      replayBuckets: dumpPersistedReplayBucketsFromMap(replayTarget),
    };
  }

  function saveMergedSqliteHistoryState(
    state: BncrSqliteStateDatabase,
    skipHistoryKeys: readonly string[],
  ): void {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      // Optimistic revision protects rows written by another instance between
      // our read and write; a conflict reloads and merges before retrying.
      const current = state.loadHistoryState(skipHistoryKeys, getConversationHistorySerialOwner());
      const merged = buildMergedSqliteHistoryState(state, skipHistoryKeys, current);
      const revision = state.getHistoryStateRevision();
      try {
        state.saveHistoryState(merged.historyBuckets, merged.replayBuckets, revision);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('history revision conflict') && attempt < 7) continue;
        throw error;
      }
    }
  }

  async function reconcileHistoryMemoryWithSqlite(historyKey?: string): Promise<void> {
    const state = await resolveSqliteState(runtime.getStatePath());
    if (!state) return;
    const mode = state.getStoreMode();
    if (mode !== 'dual' && mode !== 'sqlite') return;
    const skipHistoryKeys = historyKey ? [historyKey] : readConversationHistorySerialHistoryKeys();
    saveMergedSqliteHistoryState(state, skipHistoryKeys);

    const sqliteHistory = state.loadHistoryState(
      skipHistoryKeys,
      getConversationHistorySerialOwner(),
    );
    loadPersistedHistoryBuckets(
      sqliteHistory.historyBuckets,
      runtime.conversationHistories,
      (key) => resolvePersistedConversationHistoryLimit(key),
    );
    loadPersistedOutboundReplayCache(sqliteHistory.replayBuckets, {
      historyMap: runtime.conversationHistories,
    });
  }

  function loadPersistedAccountTimestampMap(target: Map<string, number>, persisted: unknown): void {
    target.clear();
    const items = Array.isArray(persisted)
      ? (persisted.slice(-runtime.maxAccountActivityEntries) as PersistedAccountTimestampInput[])
      : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const accountId = runtime.normalizeAccountId(runtime.asString(item.accountId || ''));
      const updatedAt = runtime.finiteNumberOr(item.updatedAt, 0);
      if (updatedAt <= 0) continue;
      target.set(accountId, updatedAt);
    }
  }

  function dumpPersistedAccountTimestampMap(source: Map<string, number>) {
    return Array.from(source.entries())
      .map(([accountId, updatedAt]) => ({
        accountId,
        updatedAt,
      }))
      .slice(-runtime.maxAccountActivityEntries);
  }

  function loadPersistedLastSessionMap(persisted: unknown): void {
    runtime.lastSessionByAccount.clear();
    const items = Array.isArray(persisted)
      ? (persisted.slice(-runtime.maxAccountActivityEntries) as PersistedLastSessionInput[])
      : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const accountId = runtime.normalizeAccountId(runtime.asString(item.accountId || ''));
      const normalized = runtime.normalizeStoredSessionKey(
        runtime.asString(item.sessionKey || ''),
        runtime.canonicalAgentId(),
      );
      const updatedAt = runtime.finiteNumberOr(item.updatedAt, 0);
      if (!normalized || updatedAt <= 0) continue;

      runtime.lastSessionByAccount.set(accountId, {
        sessionKey: normalized.sessionKey,
        scope: runtime.formatDisplayScope(normalized.route),
        updatedAt,
      });
    }
  }

  function dumpPersistedLastSessionMap() {
    return Array.from(runtime.lastSessionByAccount.entries())
      .map(([accountId, v]) => ({
        accountId,
        sessionKey: v.sessionKey,
        scope: v.scope,
        updatedAt: v.updatedAt,
      }))
      .slice(-runtime.maxAccountActivityEntries);
  }

  function loadPersistedSessionRoutes(persisted: unknown): void {
    runtime.sessionRoutes.clear();
    runtime.routeAliases.clear();
    const items = Array.isArray(persisted)
      ? (persisted.slice(-runtime.maxSessionRouteEntries) as PersistedSessionRouteInput[])
      : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const normalized = runtime.normalizeStoredSessionKey(
        runtime.asString(item.sessionKey || ''),
        runtime.canonicalAgentId(),
      );
      if (!normalized) continue;

      const route = runtime.parseRouteLike(item.route) || normalized.route;
      const accountId = runtime.normalizeAccountId(runtime.asString(item.accountId || ''));
      const updatedAt = runtime.finiteNumberOr(item.updatedAt, runtime.now());
      const info = { accountId, route, updatedAt };

      runtime.sessionRoutes.set(normalized.sessionKey, info);
      runtime.routeAliases.set(runtime.routeKey(accountId, route), info);
    }
  }

  function dumpPersistedSessionRoutes() {
    return Array.from(runtime.sessionRoutes.entries())
      .map(([sessionKey, v]) => ({
        sessionKey,
        accountId: v.accountId,
        route: v.route,
        updatedAt: v.updatedAt,
      }))
      .slice(-runtime.maxSessionRouteEntries);
  }

  function backfillAccountActivityFromSessionRoutes(): void {
    if (runtime.lastSessionByAccount.size > 0 || runtime.sessionRoutes.size === 0) return;

    for (const [sessionKey, info] of runtime.sessionRoutes.entries()) {
      const acc = runtime.normalizeAccountId(info.accountId);
      const updatedAt = runtime.finiteNumberOr(info.updatedAt, 0);
      if (updatedAt <= 0) continue;

      const current = runtime.lastSessionByAccount.get(acc);
      if (!current || updatedAt >= current.updatedAt) {
        runtime.lastSessionByAccount.set(acc, {
          sessionKey,
          scope: runtime.formatDisplayScope(info.route),
          updatedAt,
        });
      }

      const lastAct = runtime.lastActivityByAccount.get(acc) || 0;
      if (updatedAt > lastAct) runtime.lastActivityByAccount.set(acc, updatedAt);

      const lastIn = runtime.lastInboundByAccount.get(acc) || 0;
      if (updatedAt > lastIn) runtime.lastInboundByAccount.set(acc, updatedAt);
    }
  }

  function dumpSqliteControlState(): BncrSqliteControlState {
    return {
      sessionRoutes: dumpPersistedSessionRoutes(),
      sceneRegistry: dumpPersistedSceneRegistry(),
      lastSessionByAccount: dumpPersistedLastSessionMap(),
      lastActivityByAccount: dumpPersistedAccountTimestampMap(runtime.lastActivityByAccount),
      lastInboundByAccount: dumpPersistedAccountTimestampMap(runtime.lastInboundByAccount),
      lastOutboundByAccount: dumpPersistedAccountTimestampMap(runtime.lastOutboundByAccount),
      lastDriftSnapshot: dumpRegisterDriftSnapshot(runtime.getLastDriftSnapshot() ?? null),
    };
  }

  function applySqliteOutboundState(sqliteOutbound: BncrSqliteOutboundState): void {
    const jsonOutbox = new Map(runtime.outbox);
    const jsonDead = new Map(
      runtime.getDeadLetter().map((entry) => [entry.messageId, entry] as const),
    );
    const sqliteOutbox = new Map<string, OutboxEntry>();
    const sqliteDead = new Map<string, OutboxEntry>();
    for (const entry of sqliteOutbound.outbox) {
      const normalized = runtime.normalizePersistedOutboxEntry(entry);
      if (normalized) sqliteOutbox.set(normalized.messageId, normalized);
    }
    for (const entry of sqliteOutbound.deadLetter) {
      const normalized = runtime.normalizePersistedOutboxEntry(entry);
      if (normalized) sqliteDead.set(normalized.messageId, normalized);
    }

    const knownMessageIds = new Set<string>([...sqliteOutbox.keys(), ...sqliteDead.keys()]);
    runtime.outbox.clear();
    for (const entry of sqliteOutbox.values()) runtime.outbox.set(entry.messageId, entry);
    for (const [messageId, entry] of jsonOutbox) {
      if (!knownMessageIds.has(messageId)) runtime.outbox.set(messageId, entry);
    }

    const deadLetter = [...sqliteDead.values()];
    for (const [messageId, entry] of jsonDead) {
      if (!knownMessageIds.has(messageId)) deadLetter.push(entry);
    }
    runtime.setDeadLetter(deadLetter.slice(-runtime.maxDeadLetterEntries));
  }

  function buildPersistedStateSnapshot(): BncrPersistedState {
    return {
      outbox: Array.from(runtime.outbox.values()),
      deadLetter: runtime.getDeadLetter().slice(-runtime.maxDeadLetterEntries),
      sessionRoutes: dumpPersistedSessionRoutes(),
      sceneRegistry: dumpPersistedSceneRegistry(),
      conversationHistories: dumpPersistedConversationHistories(),
      outboundReplayCache: dumpPersistedOutboundReplayCache(),
      lastSessionByAccount: dumpPersistedLastSessionMap(),
      lastActivityByAccount: dumpPersistedAccountTimestampMap(runtime.lastActivityByAccount),
      lastInboundByAccount: dumpPersistedAccountTimestampMap(runtime.lastInboundByAccount),
      lastOutboundByAccount: dumpPersistedAccountTimestampMap(runtime.lastOutboundByAccount),
      lastDriftSnapshot: dumpRegisterDriftSnapshot(runtime.getLastDriftSnapshot() ?? null),
    };
  }

  function createHistoryShard(
    input: BncrHistoryShardCreateInput,
  ): BncrHistoryShardCreateResult | null {
    if (!sqliteState) return null;
    const mode = sqliteState.getStoreMode();
    if (mode !== 'dual' && mode !== 'sqlite') return null;
    const skipHistoryKeys = input.historyKey
      ? [input.historyKey]
      : readConversationHistorySerialHistoryKeys();
    saveMergedSqliteHistoryState(sqliteState, skipHistoryKeys);
    return sqliteState.createHistoryShard(input);
  }

  function completeHistoryShard(shardId: number): void {
    sqliteState?.completeHistoryShard(shardId, getConversationHistorySerialOwner());
  }

  async function loadState(skipHistoryKeys?: readonly string[]) {
    const statePath = runtime.getStatePath();
    const activeSqliteState = await resolveSqliteState(statePath);
    if (!statePath && !activeSqliteState) return;
    let legacyJsonSha256: string | undefined;
    if (statePath && activeSqliteState && !activeSqliteState.isControlStateImported()) {
      try {
        legacyJsonSha256 = createHash('sha256')
          .update(await readFile(statePath))
          .digest('hex');
      } catch {
        // A missing JSON file is handled by the fallback below; it is not a migration source.
      }
    }
    const defaults = {
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
    };
    const loaded =
      statePath && activeSqliteState?.getStoreMode() !== 'sqlite'
        ? await readOpenClawJsonFileWithFallback(statePath, defaults)
        : { value: defaults };
    const data = loaded.value as BncrPersistedStateStoreInput;

    runtime.outbox.clear();
    for (const entry of Array.isArray(data.outbox) ? data.outbox : []) {
      const migratedEntry = runtime.normalizePersistedOutboxEntry(entry);
      if (!migratedEntry) continue;
      runtime.outbox.set(migratedEntry.messageId, migratedEntry);
    }

    const deadLetter: OutboxEntry[] = [];
    const persistedDeadLetter = Array.isArray(data.deadLetter)
      ? data.deadLetter.slice(-runtime.maxDeadLetterEntries)
      : [];
    for (const entry of persistedDeadLetter) {
      const migratedEntry = runtime.normalizePersistedOutboxEntry(entry);
      if (!migratedEntry) continue;
      deadLetter.push(migratedEntry);
    }
    runtime.setDeadLetter(deadLetter);

    loadPersistedSessionRoutes(data.sessionRoutes);
    loadPersistedSceneRegistry(data.sceneRegistry);
    const persistedOutboundReplay = data.outboundReplayCache ?? data.messageCache;
    loadPersistedConversationHistories(data.conversationHistories ?? data.groupHistories, {
      assistantMessageIdsByHistoryKey:
        collectPersistedOutboundAssistantMessageIds(persistedOutboundReplay),
    });
    loadPersistedOutboundReplayCache(persistedOutboundReplay, {
      historyMap: runtime.conversationHistories,
    });
    loadPersistedLastSessionMap(data.lastSessionByAccount);
    loadPersistedAccountTimestampMap(runtime.lastActivityByAccount, data.lastActivityByAccount);
    loadPersistedAccountTimestampMap(runtime.lastInboundByAccount, data.lastInboundByAccount);
    loadPersistedAccountTimestampMap(runtime.lastOutboundByAccount, data.lastOutboundByAccount);

    runtime.setLastDriftSnapshot(normalizeRegisterDriftSnapshot(data.lastDriftSnapshot));
    if (activeSqliteState) {
      const mode = activeSqliteState.getStoreMode();
      if ((mode === 'dual' || mode === 'sqlite') && activeSqliteState.isControlStateImported()) {
        const control = activeSqliteState.loadControlState();
        loadPersistedSessionRoutes(control.sessionRoutes);
        loadPersistedSceneRegistry(control.sceneRegistry);
        loadPersistedLastSessionMap(control.lastSessionByAccount);
        loadPersistedAccountTimestampMap(
          runtime.lastActivityByAccount,
          control.lastActivityByAccount,
        );
        loadPersistedAccountTimestampMap(
          runtime.lastInboundByAccount,
          control.lastInboundByAccount,
        );
        loadPersistedAccountTimestampMap(
          runtime.lastOutboundByAccount,
          control.lastOutboundByAccount,
        );
        runtime.setLastDriftSnapshot(control.lastDriftSnapshot);
      } else if (!activeSqliteState.isControlStateImported()) {
        activeSqliteState.importControlState(dumpSqliteControlState(), {
          ...(statePath ? { legacyJsonPath: statePath } : {}),
          ...(legacyJsonSha256 ? { legacyJsonSha256 } : {}),
          storeMode: 'dual',
        });
      }
      const activeMode = activeSqliteState.getStoreMode();
      if (activeMode === 'dual' || activeMode === 'sqlite') {
        if (activeSqliteState.isHistoryImported()) {
          const sqliteHistory = activeSqliteState.loadHistoryState(
            skipHistoryKeys,
            getConversationHistorySerialOwner(),
          );
          loadPersistedConversationHistories(sqliteHistory.historyBuckets);
          loadPersistedOutboundReplayCache(sqliteHistory.replayBuckets, {
            historyMap: runtime.conversationHistories,
          });
        } else {
          saveMergedSqliteHistoryState(activeSqliteState, skipHistoryKeys ?? []);
        }
        if (activeSqliteState.isOutboundImported()) {
          applySqliteOutboundState(activeSqliteState.loadOutboundState());
          activeSqliteState.saveOutboundState(
            Array.from(runtime.outbox.values()),
            runtime.getDeadLetter(),
          );
        } else {
          activeSqliteState.importOutboundState(
            Array.from(runtime.outbox.values()),
            runtime.getDeadLetter(),
          );
        }
      }
    }
    backfillAccountActivityFromSessionRoutes();
  }

  async function flushState() {
    const statePath = runtime.getStatePath();
    const sqliteState = await resolveSqliteState(statePath);
    const sqliteMode = sqliteState?.getStoreMode();
    if (!statePath && !(sqliteMode === 'dual' || sqliteMode === 'sqlite')) return;

    const data = buildPersistedStateSnapshot();

    if (sqliteState && (sqliteMode === 'dual' || sqliteMode === 'sqlite')) {
      sqliteState.saveControlState(dumpSqliteControlState());
      const skipHistoryKeys = readConversationHistorySerialHistoryKeys();
      saveMergedSqliteHistoryState(sqliteState, skipHistoryKeys);
      if (sqliteState.isOutboundImported()) {
        sqliteState.saveOutboundState(Array.from(runtime.outbox.values()), runtime.getDeadLetter());
      } else {
        sqliteState.importOutboundState(
          Array.from(runtime.outbox.values()),
          runtime.getDeadLetter(),
        );
      }
    }
    if (statePath && sqliteMode !== 'sqlite') {
      await writeOpenClawJsonFileAtomically(statePath, data);
    }
  }

  async function exportSqliteStateToJson(): Promise<BncrPersistedState> {
    const statePath = runtime.getStatePath();
    const sqlite = await resolveSqliteState(statePath);
    if (!sqlite) throw new Error('bncr sqlite export requires an active sqlite backend');
    const mode = sqlite.getStoreMode();
    if (mode !== 'dual' && mode !== 'sqlite') {
      throw new Error(`bncr sqlite export requires dual or sqlite mode, got ${String(mode)}`);
    }
    await flushState();
    await loadState();
    return buildPersistedStateSnapshot();
  }

  async function cutoverToSqlite(): Promise<{ backupPath: string | null; storeMode: string }> {
    const statePath = runtime.getStatePath();
    const sqlite = await resolveSqliteState(statePath);
    if (!sqlite) throw new Error('bncr sqlite cutover requires an active sqlite backend');
    const mode = sqlite.getStoreMode();
    if (mode !== 'dual' && mode !== 'sqlite') {
      throw new Error(`bncr sqlite cutover requires dual or sqlite mode, got ${String(mode)}`);
    }
    if (
      !sqlite.isControlStateImported() ||
      !sqlite.isHistoryImported() ||
      !sqlite.isOutboundImported()
    ) {
      throw new Error('bncr sqlite cutover requires control, history, and outbound state imported');
    }

    await flushState();
    const outbound = sqlite.loadOutboundState();
    if (outbound.outbox.length !== runtime.outbox.size) {
      throw new Error('bncr sqlite cutover outbox count mismatch');
    }
    if (outbound.deadLetter.length !== runtime.getDeadLetter().length) {
      throw new Error('bncr sqlite cutover dead-letter count mismatch');
    }
    const outstandingHistoryShards = sqlite.listHistoryShards();
    if (outstandingHistoryShards.length > 0) {
      throw new Error('bncr sqlite cutover requires no outstanding history shards');
    }

    const timestamp = formatSqliteCutoverTimestamp(runtime.now());
    const computedBackupPath = statePath
      ? join(dirname(statePath), `${basename(statePath, '.json')}.pre-sqlite-${timestamp}.json`)
      : null;
    const backupPath =
      mode === 'sqlite'
        ? (sqlite.getMeta('sqlite_cutover_backup_path') ?? computedBackupPath)
        : computedBackupPath;
    if (statePath && mode !== 'sqlite') {
      try {
        await rename(statePath, backupPath!);
        sqlite.setMeta('sqlite_cutover_backup_path', backupPath!);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    sqlite.setStoreMode('sqlite');
    sqlite.setMeta('sqlite_cutover_at', String(runtime.now()));
    return { backupPath, storeMode: sqlite.getStoreMode() ?? 'sqlite' };
  }

  const historyShardQueue: BncrHistoryShardQueue = {
    createHistoryShard,
    reconcileHistoryMemory: (historyKey) => reconcileHistoryMemoryWithSqlite(historyKey),
    claimNextHistoryShard: () => {
      if (!sqliteState) return null;
      sqliteState.cleanupCompletedHistoryShards();
      return (
        sqliteState.claimNextHistoryShard(
          readConversationHistorySerialHistoryKeys(),
          getConversationHistorySerialOwner(),
        ) ?? null
      );
    },
    completeHistoryShard: (shardId, owner) =>
      sqliteState?.completeHistoryShard(shardId, owner || getConversationHistorySerialOwner()),
    markHistoryShardProcessing: (shardId, owner) =>
      sqliteState?.markHistoryShardProcessing(
        shardId,
        owner || getConversationHistorySerialOwner(),
      ) ?? false,
    markHistoryShardFailed: (shardId, error, owner) => {
      const result = sqliteState?.markHistoryShardFailed(
        shardId,
        error,
        owner || getConversationHistorySerialOwner(),
      ) ?? {
        attempts: 0,
        terminal: false,
      };
      if (result.terminal && sqliteState) {
        const restored = sqliteState.restoreTerminalHistoryShardsToActive();
        loadPersistedHistoryBuckets(
          restored.historyBuckets,
          runtime.conversationHistories,
          resolvePersistedConversationHistoryLimit,
          { merge: true },
        );
        loadPersistedOutboundReplayCache(restored.replayBuckets, {
          merge: true,
          historyMap: runtime.conversationHistories,
        });
      }
      return result;
    },
    markHistoryShardCompleted: (shardId, owner) =>
      sqliteState?.markHistoryShardCompleted(
        shardId,
        owner || getConversationHistorySerialOwner(),
      ) ?? false,
    renewHistoryShardLease: (shardId, owner) =>
      sqliteState?.renewHistoryShardLease(shardId, owner || getConversationHistorySerialOwner()) ??
      false,
  };
  registerBncrHistoryShardQueue(runtime.conversationHistories, historyShardQueue);

  return {
    loadPersistedAccountTimestampMap,
    dumpPersistedAccountTimestampMap,
    loadPersistedLastSessionMap,
    dumpPersistedLastSessionMap,
    loadPersistedSessionRoutes,
    dumpPersistedSessionRoutes,
    loadPersistedSceneRegistry,
    dumpPersistedSceneRegistry,
    loadPersistedConversationHistories,
    dumpPersistedConversationHistories,
    loadPersistedOutboundReplayCache,
    dumpPersistedOutboundReplayCache,
    backfillAccountActivityFromSessionRoutes,
    loadState,
    flushState,
    exportSqliteStateToJson,
    cutoverToSqlite,
    createHistoryShard,
    completeHistoryShard,
    recoverInFlightHistoryShards: async (skipHistoryKeys?: readonly string[]) => {
      const statePath = runtime.getStatePath();
      const sqlite = await resolveSqliteState(statePath);
      return (
        sqlite?.recoverInFlightHistoryShards(
          skipHistoryKeys,
          getConversationHistorySerialOwner(),
        ) ?? 0
      );
    },
    historyShardQueue,
  };
}
