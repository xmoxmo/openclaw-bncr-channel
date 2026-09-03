import { normalizeAccountId } from '../../core/accounts.ts';
import type {
  BncrOutboundReplayEntry,
  BncrOutboundReplayMediaEntry,
  BncrOutboundReplayStatus,
  OutboxEntry,
} from '../../core/types.ts';
import {
  type BncrConversationHistoryMap,
  buildBncrBotReplyMessageId,
  buildBncrConversationHistoryKey,
  buildBncrConversationHistoryKeyFromRoute,
  readConversationHistoryVersion,
  recordBncrBotReply,
  resolveBncrHistoryLimit,
} from './conversation-history.ts';
import type { ParsedInbound } from './dispatch-prep.ts';

export type {
  BncrOutboundReplayEntry,
  BncrOutboundReplayMediaEntry,
  BncrOutboundReplayStatus,
} from '../../core/types.ts';

export type BncrOutboundReplayCache = Map<string, BncrOutboundReplayEntry[]>;

function normalizeTextBody(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cloneMediaEntry(entry: BncrOutboundReplayMediaEntry): BncrOutboundReplayMediaEntry {
  return {
    ...(entry?.path ? { path: entry.path } : {}),
    ...(entry?.contentType ? { contentType: entry.contentType } : {}),
    ...(entry?.kind ? { kind: entry.kind } : {}),
    ...(entry?.messageId ? { messageId: entry.messageId } : {}),
  };
}

export function cloneBncrOutboundReplayEntry(
  entry: BncrOutboundReplayEntry,
): BncrOutboundReplayEntry {
  return {
    sender: entry.sender,
    ...(entry.senderId ? { senderId: entry.senderId } : {}),
    body: entry.body,
    ...(typeof entry.timestamp === 'number' ? { timestamp: entry.timestamp } : {}),
    ...(entry.messageId ? { messageId: entry.messageId } : {}),
    ...(Array.isArray(entry.media)
      ? { media: entry.media.map((item) => cloneMediaEntry(item)) }
      : {}),
    ...(entry.accountId ? { accountId: entry.accountId } : {}),
    ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
    ...(entry.route ? { route: { ...entry.route } } : {}),
    ...(entry.type ? { type: entry.type } : {}),
    ...(entry.mediaUrl ? { mediaUrl: entry.mediaUrl } : {}),
    ...(typeof entry.createdAt === 'number' ? { createdAt: entry.createdAt } : {}),
    ...(entry.status ? { status: entry.status } : {}),
  };
}

export function buildBncrOutboundReplayKeyFromRoute(args: {
  accountId?: string;
  platform?: string;
  groupId?: string;
  userId?: string;
}): string | null {
  const accountId = normalizeAccountId(args.accountId);
  const platform = String(args.platform || '').trim();
  const groupId = String(args.groupId || '0').trim() || '0';
  const userId = String(args.userId || '0').trim() || '0';
  if (!platform) return null;
  if (groupId !== '0') return `${accountId}:${platform}:${groupId}`;
  if (userId !== '0') return `${accountId}:${platform}:${userId}`;
  return null;
}

export function buildBncrOutboundReplayKey(
  parsed: ParsedInbound,
  accountId: string,
): string | null {
  return buildBncrOutboundReplayKeyFromRoute({
    accountId,
    platform: parsed.platform,
    groupId: parsed.groupId,
    userId: parsed.userId,
  });
}

function recordOutboundReplayEntry(args: {
  cache: BncrOutboundReplayCache;
  cacheKey: string;
  entry: BncrOutboundReplayEntry;
  historyLimit?: number;
}): boolean {
  const msgId = String(args.entry.messageId || '').trim();
  const existing = args.cache.get(args.cacheKey) || [];
  if (msgId && existing.some((entry) => entry.messageId === msgId)) return false;

  const next = [...existing, cloneBncrOutboundReplayEntry(args.entry)]
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    .slice(-resolveBncrHistoryLimit(args.historyLimit));

  if (args.cache.has(args.cacheKey)) {
    args.cache.delete(args.cacheKey);
  }
  args.cache.set(args.cacheKey, next);
  return true;
}

function inferMediaKind(args: {
  msgType?: string;
  contentType?: string;
  mediaUrl?: string;
  type?: string;
}): NonNullable<BncrOutboundReplayMediaEntry['kind']> {
  const msgType = String(args.msgType || '')
    .trim()
    .toLowerCase();
  const type = String(args.type || '')
    .trim()
    .toLowerCase();
  const contentType = String(args.contentType || '')
    .trim()
    .toLowerCase();
  const mediaUrl = String(args.mediaUrl || '')
    .trim()
    .toLowerCase();

  if (msgType === 'image' || type === 'image' || contentType.startsWith('image/')) return 'image';
  if (msgType === 'video' || type === 'video' || contentType.startsWith('video/')) return 'video';
  if (
    msgType === 'audio' ||
    msgType === 'voice' ||
    type === 'audio' ||
    type === 'voice' ||
    contentType.startsWith('audio/')
  ) {
    return 'audio';
  }
  if (type === 'file' || type === 'document' || msgType === 'file' || msgType === 'document') {
    return 'document';
  }
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(mediaUrl)) return 'image';
  if (/\.(mp4|mov|webm|mkv|avi)$/.test(mediaUrl)) return 'video';
  if (/\.(mp3|ogg|oga|silk|amr|wav|m4a|aac|flac)$/.test(mediaUrl)) return 'audio';
  if (contentType) return 'document';
  return 'unknown';
}

function buildMediaBody(kind: NonNullable<BncrOutboundReplayMediaEntry['kind']>): string {
  return `<media:${kind}>`;
}

function isAppMsg(type: string | undefined, msg: string): boolean {
  return (
    String(type || '')
      .trim()
      .toLowerCase() === 'appmsg' || /^<appmsg/i.test(msg)
  );
}

export type BncrOutboundReplayRecordResult = {
  recorded: boolean;
  historyOverflow: boolean;
  historyVersion?: number;
};

/**
 * Record an outbound bot reply into both the conversation-history window and
 * the outbound-replay cache.
 *
 * Dual-write strategy: the conversation-history window is the canonical
 * ordered source for structured context (conversation_context). The
 * outbound-replay cache is a lighter, indexed copy used by bridge-facing
 * queries such as `listRecentOutbound`. Both are kept in sync for the
 * duration of the runtime session. This is a compatibility design; the
 * cache may be retired once all read paths are migrated to the history
 * window.
 */
export function recordBncrOutboundReplay(args: {
  cache: BncrOutboundReplayCache;
  conversationHistories?: BncrConversationHistoryMap;
  historyLimit?: number;
  entry: OutboxEntry;
  sender: string;
  senderId?: string;
  status?: BncrOutboundReplayStatus;
}): BncrOutboundReplayRecordResult {
  const cacheKey = buildBncrOutboundReplayKeyFromRoute({
    accountId: args.entry.accountId,
    platform: args.entry.route?.platform,
    groupId: args.entry.route?.groupId,
    userId: args.entry.route?.userId,
  });
  if (!cacheKey) return { recorded: false, historyOverflow: false };

  const message =
    args.entry.payload?.message && typeof args.entry.payload.message === 'object'
      ? (args.entry.payload.message as Record<string, unknown>)
      : {};
  const type = typeof message.type === 'string' ? message.type : undefined;
  const rawBody = typeof message.msg === 'string' ? message.msg : '';
  const mediaUrl = typeof message.mediaUrl === 'string' ? message.mediaUrl.trim() : '';
  const kind = inferMediaKind({ type, mediaUrl });
  const isMedia =
    message.transferMode === 'media' || Boolean(mediaUrl) || (!!type && type !== 'text');
  const body = isAppMsg(type, rawBody)
    ? buildMediaBody('document')
    : normalizeTextBody(rawBody) || (isMedia ? buildMediaBody(kind) : '');
  if (!body) return { recorded: false, historyOverflow: false };
  const recordTimestamp = args.entry.lastPushAt ?? Date.now();
  const historyKey = buildBncrConversationHistoryKeyFromRoute({
    accountId: args.entry.accountId,
    platform: args.entry.route?.platform,
    groupId: args.entry.route?.groupId,
    userId: args.entry.route?.userId,
  });
  const messageId = historyKey
    ? buildBncrBotReplyMessageId({
        historyKey,
        sender: args.sender,
        senderId: args.senderId,
        body,
        timestamp: recordTimestamp,
        messageId: args.entry.messageId,
        media: mediaUrl
          ? [
              {
                path: mediaUrl,
                kind,
                messageId: args.entry.messageId,
              },
            ]
          : undefined,
      })
    : undefined;
  let historyOverflow = false;
  let historyVersion: number | undefined;

  if (args.conversationHistories) {
    if (historyKey) {
      recordBncrBotReply({
        historyMap: args.conversationHistories,
        historyKey,
        sender: args.sender,
        senderId: args.senderId,
        body,
        timestamp: recordTimestamp,
        messageId,
        historyLimit: args.historyLimit,
        ...(mediaUrl
          ? {
              media: [
                {
                  path: mediaUrl,
                  kind,
                  messageId,
                },
              ],
            }
          : {}),
      });
      const entries = args.conversationHistories.get(historyKey) || [];
      const limit = resolveBncrHistoryLimit(args.historyLimit);
      // Overflow is decided by the current active window after the outbound
      // event, not by whether this call newly wrote a row. A restored or
      // repeated ack must still be able to force a flush.
      historyOverflow = entries.length >= limit;
      if (historyOverflow) {
        historyVersion = readConversationHistoryVersion(args.conversationHistories, historyKey);
      }
      const cacheRecorded = recordOutboundReplayEntry({
        cache: args.cache,
        cacheKey,
        historyLimit: args.historyLimit,
        entry: {
          sender: args.sender,
          ...(args.senderId ? { senderId: args.senderId } : {}),
          body,
          timestamp: recordTimestamp,
          messageId,
          accountId: args.entry.accountId,
          sessionKey: args.entry.sessionKey,
          route: { ...args.entry.route },
          ...(type ? { type } : {}),
          ...(mediaUrl ? { mediaUrl } : {}),
          createdAt: args.entry.createdAt,
          ...(args.status ? { status: args.status } : {}),
          ...(mediaUrl
            ? {
                media: [
                  {
                    path: mediaUrl,
                    kind,
                    messageId,
                  },
                ],
              }
            : {}),
        },
      });
      return {
        recorded: cacheRecorded,
        historyOverflow,
        ...(historyOverflow && historyVersion !== undefined ? { historyVersion } : {}),
      };
    }
  }
  const cacheRecorded = recordOutboundReplayEntry({
    cache: args.cache,
    cacheKey,
    historyLimit: args.historyLimit,
    entry: {
      sender: args.sender,
      ...(args.senderId ? { senderId: args.senderId } : {}),
      body,
      timestamp: recordTimestamp,
      messageId: messageId || args.entry.messageId,
      accountId: args.entry.accountId,
      sessionKey: args.entry.sessionKey,
      route: { ...args.entry.route },
      ...(type ? { type } : {}),
      ...(mediaUrl ? { mediaUrl } : {}),
      createdAt: args.entry.createdAt,
      ...(args.status ? { status: args.status } : {}),
      ...(mediaUrl
        ? {
            media: [
              {
                path: mediaUrl,
                kind,
                messageId: messageId || args.entry.messageId,
              },
            ],
          }
        : {}),
    },
  });
  return {
    recorded: cacheRecorded,
    historyOverflow: false,
  };
}

export function readBncrOutboundReplaySnapshot(args: {
  cache: BncrOutboundReplayCache;
  conversationHistories?: BncrConversationHistoryMap;
  parsed: ParsedInbound;
  accountId: string;
  excludeMessageId?: string | null;
}): BncrOutboundReplayEntry[] {
  const excludedMessageId = String(args.excludeMessageId || '').trim();
  const cacheKey = buildBncrOutboundReplayKey(args.parsed, args.accountId);
  const legacyEntries = cacheKey
    ? (args.cache.get(cacheKey) || [])
        .filter((entry) => !excludedMessageId || entry.messageId !== excludedMessageId)
        .map(cloneBncrOutboundReplayEntry)
    : [];
  if (!args.conversationHistories) return legacyEntries;

  const historyKey = buildBncrConversationHistoryKey(args.parsed, {
    accountId: args.accountId,
  });
  const historyEntries = historyKey
    ? (args.conversationHistories.get(historyKey) || [])
        .filter((entry) => entry.role === 'assistant')
        .filter((entry) => !excludedMessageId || entry.messageId !== excludedMessageId)
        .map((entry) => ({
          sender: entry.sender,
          ...(entry.senderId ? { senderId: entry.senderId } : {}),
          body: entry.body,
          ...(typeof entry.timestamp === 'number' ? { timestamp: entry.timestamp } : {}),
          ...(entry.messageId ? { messageId: entry.messageId } : {}),
          ...(Array.isArray(entry.media)
            ? {
                media: entry.media.map((item) => ({
                  path: item.path,
                  contentType: item.contentType,
                  kind: item.kind,
                  messageId: item.messageId,
                })),
              }
            : {}),
        }))
    : [];
  const knownMessageIds = new Set(
    historyEntries
      .map((entry) => entry.messageId)
      .filter((messageId): messageId is string => Boolean(messageId)),
  );
  return [
    ...historyEntries,
    ...legacyEntries.filter((entry) => !entry.messageId || !knownMessageIds.has(entry.messageId)),
  ].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

export function clearBncrOutboundReplay(args: {
  cache: BncrOutboundReplayCache;
  parsed: ParsedInbound;
  accountId: string;
}) {
  const cacheKey = buildBncrOutboundReplayKey(args.parsed, args.accountId);
  if (!cacheKey) return;
  args.cache.delete(cacheKey);
}

export function removeBncrOutboundReplayMessageIds(args: {
  cache: BncrOutboundReplayCache;
  parsed: ParsedInbound;
  accountId: string;
  messageIds: ReadonlyArray<string | undefined | null>;
}): number {
  const cacheKey = buildBncrOutboundReplayKey(args.parsed, args.accountId);
  if (!cacheKey) return 0;
  const messageIds = new Set(
    args.messageIds
      .map((messageId) => String(messageId || '').trim())
      .filter((messageId) => Boolean(messageId)),
  );
  if (messageIds.size === 0) return 0;
  const current = args.cache.get(cacheKey) || [];
  if (current.length === 0) return 0;
  const next = current.filter(
    (entry) =>
      !String(entry.messageId || '').trim() || !messageIds.has(String(entry.messageId).trim()),
  );
  if (next.length === current.length) return 0;
  if (next.length === 0) {
    args.cache.delete(cacheKey);
  } else {
    args.cache.set(cacheKey, next);
  }
  return current.length - next.length;
}
