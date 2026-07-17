import type { OutboundReplyTargetPolicy } from '../messaging/outbound/reply-target-policy.ts';
import { normalizeOutboundReplyToId } from '../messaging/outbound/reply-target-policy.ts';
import type { BncrRoute, OutboxEntry } from './types.ts';

export function buildFileTransferOutboxEntry(args: {
  createMessageId: () => string;
  now: () => number;
  normalizeAccountId: (accountId?: string | null) => string;
  pushEvent: string;
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
      sessionKey: args.sessionKey,
      _meta: {
        kind: 'file-transfer',
        mediaUrl: args.mediaUrl,
        mediaLocalRoots: args.mediaLocalRoots ? Array.from(args.mediaLocalRoots) : undefined,
        text: args.text,
        asVoice: args.asVoice === true,
        audioAsVoice: args.audioAsVoice === true,
        type: args.type,
        downloadMedia: args.downloadMedia === true,
        ...(args.extra ? { extra: { ...args.extra } } : {}),
        finalEvent: args.pushEvent,
        replyToId:
          normalizeOutboundReplyToId({
            kind: args.kind,
            replyToId: args.replyToId,
            replyTargetPolicy: args.replyTargetPolicy,
          }) || undefined,
        messageKind: args.kind,
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
  normalizeReplyToId: (value?: string | null) => string;
  accountId: string;
  extra?: Record<string, unknown>;
  sessionKey: string;
  route: BncrRoute;
  text: string;
  kind?: 'tool' | 'block' | 'final';
  replyToId?: string;
  replyTargetPolicy?: OutboundReplyTargetPolicy;
  downloadMedia?: boolean;
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
      ...(args.extra ? { ...args.extra } : {}),
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
