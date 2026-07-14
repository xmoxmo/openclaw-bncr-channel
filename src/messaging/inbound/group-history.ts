import path from 'node:path';
import {
  createChannelHistoryWindow,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
  type HistoryMediaEntry,
} from 'openclaw/plugin-sdk/reply-history';
import { formatOpenClawAgentEnvelope } from '../../openclaw/reply-runtime.ts';
import type { BncrInboundApi } from './contracts.ts';
import type { ParsedInbound } from './dispatch-prep.ts';

export type BncrHistoryEntry = HistoryEntry & {
  senderId?: string;
};

export type BncrGroupHistoryMap = Map<string, BncrHistoryEntry[]>;

type BncrHistoryMediaKind = NonNullable<HistoryMediaEntry['kind']>;

function normalizeTextBody(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildBncrGroupHistoryKey(parsed: ParsedInbound): string | null {
  if (parsed.peer.kind !== 'group') return null;
  const platform = String(parsed.platform || '').trim();
  const groupId = String(parsed.groupId || '').trim();
  if (!platform || !groupId || groupId === '0') return null;
  return `${platform}:${groupId}`;
}

export function recordBncrPendingGroupText(args: {
  historyMap: BncrGroupHistoryMap;
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
      : DEFAULT_GROUP_HISTORY_LIMIT;
  const historyKey = buildBncrGroupHistoryKey(args.parsed);
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

export async function recordBncrPendingGroupMedia(args: {
  historyMap: BncrGroupHistoryMap;
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
      : DEFAULT_GROUP_HISTORY_LIMIT;
  const historyKey = buildBncrGroupHistoryKey(args.parsed);
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

function cloneBncrHistoryEntry(entry: BncrHistoryEntry): BncrHistoryEntry {
  return {
    sender: entry.sender,
    ...(entry.messageId ? { messageId: entry.messageId } : {}),
    ...(typeof entry.timestamp === 'number' ? { timestamp: entry.timestamp } : {}),
    ...(entry.senderId ? { senderId: entry.senderId } : {}),
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

export function readBncrPendingGroupHistorySnapshot(args: {
  historyMap: BncrGroupHistoryMap;
  parsed: ParsedInbound;
  historyLimit?: number;
}): BncrHistoryEntry[] {
  const limit =
    typeof args.historyLimit === 'number' &&
    Number.isFinite(args.historyLimit) &&
    args.historyLimit >= 0
      ? Math.floor(args.historyLimit)
      : DEFAULT_GROUP_HISTORY_LIMIT;
  const historyKey = buildBncrGroupHistoryKey(args.parsed);
  if (!historyKey) return [];
  const entries = args.historyMap.get(historyKey) || [];
  if (entries.length === 0) return [];
  return entries.slice(-limit).map(cloneBncrHistoryEntry);
}

export function buildBncrGroupContextFromEntries(args: {
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

function toBncrPromptMediaPath(value: string | undefined): string | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) return undefined;
  const slashNormalized = normalized.replace(/\\/g, '/');
  if (!slashNormalized.includes('/media/inbound/')) return undefined;
  const base = path.posix.basename(slashNormalized);
  if (!base || base === '.' || base === '..') return undefined;
  return `media://inbound/${encodeURIComponent(base)}`;
}

function buildHistoryWindowMediaSummary(
  media: HistoryMediaEntry[] | undefined,
): string | undefined {
  if (!Array.isArray(media) || media.length === 0) return undefined;
  const kinds = media
    .map((item) =>
      String(item?.kind || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  const uniformKind = kinds[0] && kinds.every((item) => item === kinds[0]) ? kinds[0] : 'document';
  const count = media.length;
  if (uniformKind === 'image')
    return count === 1 ? '<media:image>' : `<media:image> (${count} images)`;
  if (uniformKind === 'video')
    return count === 1 ? '<media:video>' : `<media:video> (${count} videos)`;
  if (uniformKind === 'audio') {
    return count === 1 ? '<media:audio>' : `<media:audio> (${count} audio attachments)`;
  }
  return count === 1 ? '<media:document>' : `<media:document> (${count} attachments)`;
}

function buildHistoryWindowMedias(media: HistoryMediaEntry[] | undefined) {
  if (!Array.isArray(media) || media.length === 0) return [];
  return media.flatMap((item) => {
    const promptPath = toBncrPromptMediaPath(item?.path);
    const payload = {
      ...(promptPath ? { path: promptPath } : {}),
      ...(item?.contentType ? { contentType: item.contentType } : {}),
      ...(item?.kind ? { kind: item.kind } : {}),
      ...(item?.messageId ? { messageId: item.messageId } : {}),
    };
    return Object.keys(payload).length > 0 ? [payload] : [];
  });
}

export function buildBncrHistoryWindowContextFromEntries(args: {
  entries: readonly BncrHistoryEntry[];
  channelId: string;
}) {
  if (args.entries.length === 0) return undefined;
  const messages = args.entries.map((entry) => ({
    ...(entry.messageId ? { messageId: entry.messageId } : {}),
    sender: entry.sender,
    senderId: entry.senderId,
    ...(typeof entry.timestamp === 'number' ? { timestampMs: entry.timestamp } : {}),
    body: entry.body,
    mediaSummary: buildHistoryWindowMediaSummary(entry.media),
    medias: buildHistoryWindowMedias(entry.media),
  }));
  return {
    label: 'Bncr history window',
    source: args.channelId,
    type: 'bncr.history_window',
    payload: {
      relation: 'before_current_message',
      order: 'chronological',
      messages,
    },
  };
}

export function clearBncrPendingGroupHistory(args: {
  historyMap: BncrGroupHistoryMap;
  parsed: ParsedInbound;
  historyLimit?: number;
}) {
  const limit =
    typeof args.historyLimit === 'number' &&
    Number.isFinite(args.historyLimit) &&
    args.historyLimit >= 0
      ? Math.floor(args.historyLimit)
      : DEFAULT_GROUP_HISTORY_LIMIT;
  const historyKey = buildBncrGroupHistoryKey(args.parsed);
  if (!historyKey) return;
  createChannelHistoryWindow({ historyMap: args.historyMap }).clear({
    historyKey,
    limit: limit,
  });
}
