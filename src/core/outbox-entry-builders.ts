import type { OutboundReplyTargetPolicy } from '../messaging/outbound/reply-target-policy.ts';
import { normalizeOutboundReplyToId } from '../messaging/outbound/reply-target-policy.ts';
import type { BncrRoute, OutboxEntry } from './types.ts';

/** Strip empty/falsy values from extra so they don't override existing message defaults. */
function sanitizeExtraSpread(extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value === '' || value === null || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

export function buildFileTransferOutboxEntry(args: {
  createMessageId: () => string;
  now: () => number;
  normalizeAccountId: (accountId?: string | null) => string;
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  text: string;
  asVoice?: boolean;
  audioAsVoice?: boolean;
  type?: string;
  extra?: Record<string, unknown>;
  kind?: 'tool' | 'block' | 'final';
  replyToId?: string;
  replyTargetPolicy?: OutboundReplyTargetPolicy;
  downloadMedia?: boolean;
}): OutboxEntry {
  const messageId = args.createMessageId();
  const createdAt = args.now();
  return {
    messageId,
    accountId: args.normalizeAccountId(args.accountId),
    sessionKey: args.sessionKey,
    route: args.route,
    payload: {
      type: 'message.outbound',
      messageId,
      idempotencyKey: messageId,
      sessionKey: args.sessionKey,
      replyToId:
        normalizeOutboundReplyToId({
          kind: args.kind,
          replyToId: args.replyToId,
          replyTargetPolicy: args.replyTargetPolicy,
        }) || undefined,
      message: {
        platform: args.route.platform,
        groupId: args.route.groupId,
        userId: args.route.userId,
        type: args.type,
        // No fallback: when type is not provided the downstream adapter
        // (tgBot / GewePlus) infers from mediaUrl extension.
        kind: args.kind,
        msg: args.text,
        mediaUrl: args.mediaUrl,
        mediaLocalRoots: args.mediaLocalRoots ? Array.from(args.mediaLocalRoots) : undefined,
        asVoice: args.asVoice === true,
        audioAsVoice: args.audioAsVoice === true,
        downloadMedia: args.downloadMedia,
        transferMode: 'media',
        path: '',
        base64: '',
        fileName: '',
        ...(args.extra ? sanitizeExtraSpread(args.extra) : {}),
      },
    },
    createdAt,
    retryCount: 0,
    nextAttemptAt: createdAt,
  };
}

export function buildTextOutboxEntry(args: {
  createMessageId: () => string;
  now: () => number;
  normalizeAccountId: (accountId?: string | null) => string;
  accountId: string;
  extra?: Record<string, unknown>;
  sessionKey: string;
  route: BncrRoute;
  text: string;
  kind?: 'tool' | 'block' | 'final';
  replyToId?: string;
  replyTargetPolicy?: OutboundReplyTargetPolicy;
}): OutboxEntry {
  const messageId = args.createMessageId();
  const createdAt = args.now();
  const frame = {
    type: 'message.outbound',
    messageId,
    idempotencyKey: messageId,
    sessionKey: args.sessionKey,
    replyToId:
      normalizeOutboundReplyToId({
        kind: args.kind,
        replyToId: args.replyToId,
        replyTargetPolicy: args.replyTargetPolicy,
      }) || undefined,
    message: {
      platform: args.route.platform,
      groupId: args.route.groupId,
      userId: args.route.userId,
      type: 'text',
      kind: args.kind,
      msg: args.text,
      path: '',
      base64: '',
      fileName: '',
      // Extra fields from marker/pipeline spread for adapter-specific data
      // (e.g. type="appmsg", msg="<appmsg>..." from [BncrParam:...])
      ...(args.extra ? sanitizeExtraSpread(args.extra) : {}),
    },
    ts: createdAt,
  };

  return {
    messageId,
    accountId: args.normalizeAccountId(args.accountId),
    sessionKey: args.sessionKey,
    route: args.route,
    payload: frame,
    createdAt,
    retryCount: 0,
    nextAttemptAt: createdAt,
  };
}
