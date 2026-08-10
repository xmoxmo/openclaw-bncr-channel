import {
  createChannelHistoryWindow,
  DEFAULT_GROUP_HISTORY_LIMIT as DEFAULT_HISTORY_LIMIT,
  type HistoryEntry,
  type HistoryMediaEntry,
} from 'openclaw/plugin-sdk/reply-history';
import { formatOpenClawAgentEnvelope } from '../../openclaw/reply-runtime.ts';
import type { BncrInboundApi } from './contracts.ts';
import type { ParsedInbound } from './dispatch-prep.ts';

export type BncrHistoryEntry = HistoryEntry & {
  senderId?: string;
  role?: 'user' | 'assistant' | 'system';
};

export type BncrConversationHistoryMap = Map<string, BncrHistoryEntry[]>;

type BncrHistoryMediaKind = NonNullable<HistoryMediaEntry['kind']>;

function normalizeTextBody(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildBncrConversationHistoryKey(parsed: ParsedInbound): string | null {
  const platform = String(parsed.platform || '').trim();
  if (!platform) return null;
  if (parsed.peer.kind === 'group') {
    const groupId = String(parsed.groupId || '').trim();
    if (!groupId || groupId === '0') return null;
    return `${platform}:${groupId}`;
  }
  const userId = String(parsed.userId || '').trim();
  if (!userId || userId === '0') return null;
  return `${platform}:${userId}`;
}

export function buildBncrConversationHistoryKeyFromRoute(args: {
  platform?: string;
  groupId?: string;
  userId?: string;
}): string | null {
  const platform = String(args.platform || '').trim();
  if (!platform) return null;
  const groupId = String(args.groupId || '0').trim() || '0';
  const userId = String(args.userId || '0').trim() || '0';
  if (groupId !== '0') return `${platform}:${groupId}`;
  if (userId !== '0') return `${platform}:${userId}`;
  return null;
}

export function recordBncrPendingConversationText(args: {
  historyMap: BncrConversationHistoryMap;
  parsed: ParsedInbound;
  senderDisplayName: string;
  senderId: string;
  bodyText: string;
  historyLimit?: number;
}) {
  const limit =
    typeof args.historyLimit === 'number' &&
    Number.isFinite(args.historyLimit) &&
    args.historyLimit >= 0
      ? Math.floor(args.historyLimit)
      : DEFAULT_HISTORY_LIMIT;
  const historyKey = buildBncrConversationHistoryKey(args.parsed);
  const body = normalizeTextBody(args.bodyText);
  if (!historyKey || !body || args.parsed.msgType !== 'text') return;
  const msgId = String(args.parsed.msgId || '').trim();
  if (msgId) {
    const existing = args.historyMap.get(historyKey) || [];
    if (existing.some((e) => e.messageId === msgId)) return;
  }
  createChannelHistoryWindow({ historyMap: args.historyMap }).record({
    historyKey,
    limit,
    entry: {
      sender: args.senderDisplayName,
      senderId: args.senderId,
      body,
      timestamp: Date.now(),
      messageId: args.parsed.msgId,
      role: 'user',
    },
  });
}

function inferBncrHistoryMediaKind(args: {
  msgType?: string;
  mediaContentType?: string;
}): BncrHistoryMediaKind {
  const msgType = String(args.msgType || '')
    .trim()
    .toLowerCase();
  const contentType = String(args.mediaContentType || '')
    .trim()
    .toLowerCase();
  if (msgType === 'image' || contentType.startsWith('image/')) return 'image';
  if (msgType === 'video' || contentType.startsWith('video/')) return 'video';
  if (msgType === 'audio' || msgType === 'voice' || contentType.startsWith('audio/'))
    return 'audio';
  if (msgType === 'file' || msgType === 'document') return 'document';
  if (contentType) return 'document';
  return 'unknown';
}

function buildBncrHistoryMediaBody(kind: BncrHistoryMediaKind): string {
  return `<media:${kind}>`;
}

export async function recordBncrPendingConversationMedia(args: {
  historyMap: BncrConversationHistoryMap;
  parsed: ParsedInbound;
  senderDisplayName: string;
  senderId: string;
  bodyText: string;
  mediaItems?: Array<{
    path: string;
    contentType?: string;
    kind?: BncrHistoryMediaKind;
  }>;
  mediaContentType?: string;
  historyLimit?: number;
}) {
  const limit =
    typeof args.historyLimit === 'number' &&
    Number.isFinite(args.historyLimit) &&
    args.historyLimit >= 0
      ? Math.floor(args.historyLimit)
      : DEFAULT_HISTORY_LIMIT;
  const historyKey = buildBncrConversationHistoryKey(args.parsed);
  if (!historyKey || args.parsed.msgType === 'text') return;
  const normalizedMediaItems = Array.isArray(args.mediaItems) ? args.mediaItems : [];
  const itemKinds = normalizedMediaItems
    .map((item) =>
      String(item?.kind || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  const kind = itemKinds[0]
    ? itemKinds.every((candidate) => candidate === itemKinds[0])
      ? (itemKinds[0] as BncrHistoryMediaKind)
      : 'document'
    : inferBncrHistoryMediaKind({
        msgType: args.parsed.msgType,
        mediaContentType: args.mediaContentType,
      });
  const body = normalizeTextBody(args.bodyText) || buildBncrHistoryMediaBody(kind);
  if (normalizedMediaItems.length === 0) {
    const msgId = String(args.parsed.msgId || '').trim();
    if (msgId) {
      const existing = args.historyMap.get(historyKey) || [];
      if (existing.some((e) => e.messageId === msgId)) return;
    }
    createChannelHistoryWindow({ historyMap: args.historyMap }).record({
      historyKey,
      limit,
      entry: {
        sender: args.senderDisplayName,
        senderId: args.senderId,
        body,
        timestamp: Date.now(),
        messageId: args.parsed.msgId,
        role: 'user',
      },
    });
    return;
  }
  const msgId = String(args.parsed.msgId || '').trim();
  if (msgId) {
    const existing = args.historyMap.get(historyKey) || [];
    if (existing.some((e) => e.messageId === msgId)) return;
  }
  createChannelHistoryWindow({ historyMap: args.historyMap }).record({
    historyKey,
    limit,
    entry: {
      sender: args.senderDisplayName,
      senderId: args.senderId,
      body,
      timestamp: Date.now(),
      messageId: args.parsed.msgId,
      role: 'user',
      media: normalizedMediaItems.map(
        (item) =>
          ({
            path: item.path,
            contentType: item.contentType || args.mediaContentType,
            kind: item.kind || kind,
            messageId: args.parsed.msgId,
          }) satisfies HistoryMediaEntry,
      ),
    },
  });
}

export function recordBncrBotReply(args: {
  historyMap: BncrConversationHistoryMap;
  historyKey: string;
  sender: string;
  senderId?: string;
  body: string;
  timestamp?: number;
  messageId?: string;
  media?: HistoryMediaEntry[];
  historyLimit?: number;
}) {
  const limit =
    typeof args.historyLimit === 'number' &&
    Number.isFinite(args.historyLimit) &&
    args.historyLimit >= 0
      ? Math.floor(args.historyLimit)
      : DEFAULT_HISTORY_LIMIT;
  const body = normalizeTextBody(args.body);
  if (!body) return;
  const msgId = String(args.messageId || '').trim();
  if (msgId) {
    const existing = args.historyMap.get(args.historyKey) || [];
    if (existing.some((e) => e.messageId === msgId)) return;
  }
  createChannelHistoryWindow({ historyMap: args.historyMap }).record({
    historyKey: args.historyKey,
    limit,
    entry: {
      sender: args.sender,
      ...(args.senderId ? { senderId: args.senderId } : {}),
      body,
      timestamp: args.timestamp ?? Date.now(),
      ...(args.messageId ? { messageId: args.messageId } : {}),
      role: 'assistant',
      ...(Array.isArray(args.media) && args.media.length > 0 ? { media: args.media } : {}),
    },
  });
}

function cloneBncrHistoryEntry(entry: BncrHistoryEntry): BncrHistoryEntry {
  return {
    sender: entry.sender,
    ...(entry.messageId ? { messageId: entry.messageId } : {}),
    ...(typeof entry.timestamp === 'number' ? { timestamp: entry.timestamp } : {}),
    ...(entry.senderId ? { senderId: entry.senderId } : {}),
    ...(entry.role ? { role: entry.role } : {}),
    body: entry.body,
    ...(Array.isArray(entry.media)
      ? {
          media: entry.media.map((item) => ({
            ...(item?.path ? { path: item.path } : {}),
            ...(item?.contentType ? { contentType: item.contentType } : {}),
            ...(item?.kind ? { kind: item.kind } : {}),
            ...(item?.messageId ? { messageId: item.messageId } : {}),
          })),
        }
      : {}),
  };
}

export function readBncrPendingConversationHistorySnapshot(args: {
  historyMap: BncrConversationHistoryMap;
  parsed: ParsedInbound;
  historyLimit?: number;
}): BncrHistoryEntry[] {
  const limit =
    typeof args.historyLimit === 'number' &&
    Number.isFinite(args.historyLimit) &&
    args.historyLimit >= 0
      ? Math.floor(args.historyLimit)
      : DEFAULT_HISTORY_LIMIT;
  const historyKey = buildBncrConversationHistoryKey(args.parsed);
  if (!historyKey) return [];
  const entries = args.historyMap.get(historyKey) || [];
  if (entries.length === 0) return [];
  return entries
    .slice()
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    .slice(-limit)
    .map(cloneBncrHistoryEntry);
}

export function buildBncrConversationContextFromEntries(args: {
  api: BncrInboundApi;
  entries: readonly BncrHistoryEntry[];
  channelLabel: string;
  currentTimestamp: number;
  previousTimestamp?: unknown;
  envelope?: unknown;
  currentMessage: string;
}) {
  if (args.entries.length === 0) return args.currentMessage;
  const historyText = args.entries
    .map((entry) =>
      formatOpenClawAgentEnvelope(args.api, {
        channel: 'Bncr',
        from:
          (entry.senderId
            ? `${entry.sender} (${entry.senderId})`
            : entry.sender || args.channelLabel) + (entry.messageId ? ` #${entry.messageId}` : ''),
        timestamp: entry.timestamp || args.currentTimestamp,
        previousTimestamp: args.previousTimestamp,
        envelope: args.envelope,
        body: entry.body,
      }),
    )
    .join('\n');
  return `[Chat messages since your last reply - for context]\n${historyText}\n\n[Current message - respond to this]${args.currentMessage}`;
}

export function collectBncrHistoryMediaFromEntries(args: {
  entries: readonly BncrHistoryEntry[];
}): HistoryMediaEntry[] {
  return args.entries.flatMap((entry) => (Array.isArray(entry.media) ? entry.media : []));
}
export function clearBncrPendingConversationHistory(args: {
  historyMap: BncrConversationHistoryMap;
  parsed: ParsedInbound;
  historyLimit?: number;
}) {
  const limit =
    typeof args.historyLimit === 'number' &&
    Number.isFinite(args.historyLimit) &&
    args.historyLimit >= 0
      ? Math.floor(args.historyLimit)
      : DEFAULT_HISTORY_LIMIT;
  const historyKey = buildBncrConversationHistoryKey(args.parsed);
  if (!historyKey) return;
  createChannelHistoryWindow({ historyMap: args.historyMap }).clear({
    historyKey,
    limit: limit,
  });
}
