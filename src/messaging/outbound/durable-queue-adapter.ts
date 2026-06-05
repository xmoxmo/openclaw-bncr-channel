import type { BncrRoute, OutboxEntry } from '../../core/types.ts';
import { normalizeOutboundReplyToId } from './reply-target-policy.ts';

export type BncrDurableQueuedReceipt = {
  primaryPlatformMessageId: string;
  platformMessageIds: string[];
  parts: Array<{
    platformMessageId: string;
    kind: 'text' | 'media' | 'voice' | 'unknown';
    index: number;
    threadId?: string;
    replyToId?: string;
    raw: {
      channel: 'bncr';
      channelId: 'bncr';
      messageId: string;
      chatId: string;
      conversationId: string;
      timestamp: number;
      meta: BncrDurableQueuedReceiptMeta;
    };
  }>;
  threadId?: string;
  replyToId?: string;
  sentAt: number;
  raw: Array<{
    channel: 'bncr';
    channelId: 'bncr';
    messageId: string;
    chatId: string;
    conversationId: string;
    timestamp: number;
    meta: BncrDurableQueuedReceiptMeta;
  }>;
};

export type BncrDurableQueuedReceiptMeta = {
  status: 'accepted';
  deliveryStage: 'queued';
  queue: 'bncr.outbox';
  finalAckManagedBy: 'bncr-outbox';
  ackSemantics: 'plugin-accepted-not-client-acked';
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  outboxPayloadType?: string;
};

export type BncrDurableQueuedResult = {
  status: 'sent';
  results: Array<{
    channel: 'bncr';
    channelId: 'bncr';
    messageId: string;
    chatId: string;
    conversationId: string;
    timestamp: number;
    meta: BncrDurableQueuedReceiptMeta;
  }>;
  receipt: BncrDurableQueuedReceipt;
  payloadOutcomes: Array<{
    index: number;
    status: 'sent';
    results: BncrDurableQueuedResult['results'];
  }>;
};

export function buildBncrDurableQueuedResult(args: {
  entry: OutboxEntry;
  index?: number;
  threadId?: string;
  replyToId?: string;
  sentAt?: number;
}): BncrDurableQueuedResult {
  const sentAt = Number.isFinite(args.sentAt) ? Number(args.sentAt) : args.entry.createdAt;
  const platformMessageId = args.entry.messageId;
  const replyToId =
    normalizeOutboundReplyToId({ replyToId: args.replyToId ?? extractReplyToId(args.entry) }) ||
    undefined;
  const chatId = formatQueuedReceiptChatId(args.entry.route);
  const meta: BncrDurableQueuedReceiptMeta = {
    status: 'accepted',
    deliveryStage: 'queued',
    queue: 'bncr.outbox',
    finalAckManagedBy: 'bncr-outbox',
    ackSemantics: 'plugin-accepted-not-client-acked',
    accountId: args.entry.accountId,
    sessionKey: args.entry.sessionKey,
    route: args.entry.route,
    outboxPayloadType: extractPayloadType(args.entry),
  };
  const result = {
    channel: 'bncr' as const,
    channelId: 'bncr' as const,
    messageId: platformMessageId,
    chatId,
    conversationId: args.entry.sessionKey,
    timestamp: sentAt,
    meta,
  };
  const receipt: BncrDurableQueuedReceipt = {
    primaryPlatformMessageId: platformMessageId,
    platformMessageIds: [platformMessageId],
    parts: [
      {
        platformMessageId,
        kind: inferReceiptKind(args.entry),
        index: args.index ?? 0,
        threadId: args.threadId,
        replyToId,
        raw: result,
      },
    ],
    threadId: args.threadId,
    replyToId,
    sentAt,
    raw: [result],
  };
  return {
    status: 'sent',
    results: [result],
    receipt,
    payloadOutcomes: [
      {
        index: args.index ?? 0,
        status: 'sent',
        results: [result],
      },
    ],
  };
}

function extractPayloadType(entry: OutboxEntry): string | undefined {
  const payload = entry.payload as any;
  return typeof payload?.type === 'string' ? payload.type : undefined;
}

function extractReplyToId(entry: OutboxEntry): string | undefined {
  const payload = entry.payload as any;
  const metaReply = payload?._meta?.replyToId;
  const replyToId = payload?.replyToId ?? metaReply;
  return typeof replyToId === 'string' ? replyToId : undefined;
}

function inferReceiptKind(entry: OutboxEntry): 'text' | 'media' | 'voice' | 'unknown' {
  const payload = entry.payload as any;
  if (payload?._meta?.kind === 'file-transfer') {
    if (payload?._meta?.asVoice === true || payload?._meta?.audioAsVoice === true) return 'voice';
    return 'media';
  }
  if (payload?.message?.type === 'text') return 'text';
  return 'unknown';
}

function formatQueuedReceiptChatId(route: BncrRoute): string {
  const platform = route.platform || 'unknown';
  if (route.groupId) return `Bncr:${platform}:${route.groupId}:${route.userId}`;
  return `Bncr:${platform}:${route.userId}`;
}
