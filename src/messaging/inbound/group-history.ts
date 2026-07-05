import {
  createChannelHistoryWindow,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
  type HistoryMediaEntry,
} from 'openclaw/plugin-sdk/reply-history';
import { formatOpenClawAgentEnvelope } from '../../openclaw/reply-runtime.ts';
import type { BncrInboundApi } from './contracts.ts';
import type { ParsedInbound } from './dispatch-prep.ts';

export type BncrGroupHistoryMap = Map<string, HistoryEntry[]>;

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
  if (normalizedMediaItems.length === 0 || kind !== 'image') {
    createChannelHistoryWindow({ historyMap: args.historyMap }).record({
      historyKey,
      limit: DEFAULT_GROUP_HISTORY_LIMIT,
      entry: {
        sender: args.senderDisplayName,
        body,
        timestamp: Date.now(),
        messageId: args.parsed.msgId,
      },
    });
    return;
  }
  await createChannelHistoryWindow({ historyMap: args.historyMap }).recordWithMedia({
    historyKey,
    limit: DEFAULT_GROUP_HISTORY_LIMIT,
    entry: {
      sender: args.senderDisplayName,
      body,
      timestamp: Date.now(),
      messageId: args.parsed.msgId,
    },
    messageId: args.parsed.msgId,
    media: normalizedMediaItems.map(
      (item) =>
        ({
          path: item.path,
          contentType: item.contentType || args.mediaContentType || 'image/*',
          kind: 'image',
          messageId: args.parsed.msgId,
        }) satisfies HistoryMediaEntry,
    ),
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

export function buildBncrInboundHistory(args: {
  historyMap: BncrGroupHistoryMap;
  parsed: ParsedInbound;
}) {
  const historyKey = buildBncrGroupHistoryKey(args.parsed);
  if (!historyKey) return undefined;
  return createChannelHistoryWindow({ historyMap: args.historyMap }).buildInboundHistory({
    historyKey,
    limit: DEFAULT_GROUP_HISTORY_LIMIT,
  });
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
