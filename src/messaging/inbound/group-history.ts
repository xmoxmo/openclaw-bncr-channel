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
}) {
  const historyKey = buildBncrGroupHistoryKey(args.parsed);
  const body = normalizeTextBody(args.bodyText);
  if (!historyKey || !body || args.parsed.msgType !== 'text') return;
  createChannelHistoryWindow({ historyMap: args.historyMap }).record({
    historyKey,
    limit: DEFAULT_GROUP_HISTORY_LIMIT,
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
}) {
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
    createChannelHistoryWindow({ historyMap: args.historyMap }).record({
      historyKey,
      limit: DEFAULT_GROUP_HISTORY_LIMIT,
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
  createChannelHistoryWindow({ historyMap: args.historyMap }).record({
    historyKey,
    limit: DEFAULT_GROUP_HISTORY_LIMIT,
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

export function buildBncrPendingGroupContext(args: {
  api: BncrInboundApi;
  historyMap: BncrGroupHistoryMap;
  parsed: ParsedInbound;
  channelLabel: string;
  currentTimestamp: number;
  previousTimestamp?: unknown;
  envelope?: unknown;
  currentMessage: string;
}) {
  const historyKey = buildBncrGroupHistoryKey(args.parsed);
  if (!historyKey) return args.currentMessage;
  return createChannelHistoryWindow({ historyMap: args.historyMap }).buildPendingContext({
    historyKey,
    limit: DEFAULT_GROUP_HISTORY_LIMIT,
    currentMessage: args.currentMessage,
    formatEntry: (entry) =>
      formatOpenClawAgentEnvelope(args.api, {
        channel: 'Bncr',
        from: args.channelLabel,
        timestamp: entry.timestamp || args.currentTimestamp,
        previousTimestamp: args.previousTimestamp,
        envelope: args.envelope,
        body: entry.body,
      }),
  });
}

export function collectBncrPendingHistoryMedia(args: {
  historyMap: BncrGroupHistoryMap;
  parsed: ParsedInbound;
}): HistoryMediaEntry[] {
  const historyKey = buildBncrGroupHistoryKey(args.parsed);
  if (!historyKey) return [];
  const entries = args.historyMap.get(historyKey) || [];
  return entries.flatMap((entry) => (Array.isArray(entry.media) ? entry.media : []));
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

export function buildBncrPendingHistoryWindowContext(args: {
  historyMap: BncrGroupHistoryMap;
  parsed: ParsedInbound;
  channelId: string;
}) {
  const historyKey = buildBncrGroupHistoryKey(args.parsed);
  if (!historyKey) return undefined;
  const entries = args.historyMap.get(historyKey) || [];
  if (entries.length === 0) return undefined;
  const messages = entries.slice(-DEFAULT_GROUP_HISTORY_LIMIT).map((entry) => ({
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
}) {
  const historyKey = buildBncrGroupHistoryKey(args.parsed);
  if (!historyKey) return;
  createChannelHistoryWindow({ historyMap: args.historyMap }).clear({
    historyKey,
    limit: DEFAULT_GROUP_HISTORY_LIMIT,
  });
}
