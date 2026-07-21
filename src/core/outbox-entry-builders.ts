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

export type BuildOutboxEntryParams = {
  createMessageId: () => string;
  now: () => number;
  normalizeAccountId: (accountId?: string | null) => string;
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  /** For text sends this is 'text'; for media it may be undefined (inferred downstream). */
  type?: string;
  /** Message body (text content for text sends, caption for media sends). */
  msg: string;
  kind?: 'tool' | 'block' | 'final';
  replyToId?: string;
  replyTargetPolicy?: OutboundReplyTargetPolicy;
  extra?: Record<string, unknown>;
  /** Media-only fields. When transferMode === 'media' these shape the frame. */
  transferMode?: 'text' | 'media';
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  asVoice?: boolean;
  audioAsVoice?: boolean;
  downloadMedia?: boolean;
};

/**
 * Unified outbox entry builder.
 *
 * Text and media sends share the same outbox lifecycle (queue, drain, retry).
 * The only structural difference is that media entries carry extra media fields
 * and set `transferMode: 'media'` so the push layer knows to process media.
 *
 * - **Text**: `{ type: 'text', transferMode: undefined, no media fields }`
 * - **Media**: `{ type: args.type || undefined, transferMode: 'media', ...media fields }`
 */
export function buildOutboxEntry(args: BuildOutboxEntryParams): OutboxEntry {
  const messageId = args.createMessageId();
  const createdAt = args.now();
  const isMedia = args.transferMode === 'media';

  const message: Record<string, unknown> = {
    platform: args.route.platform,
    groupId: args.route.groupId,
    userId: args.route.userId,
    type: isMedia ? args.type : 'text',
    kind: args.kind,
    msg: args.msg,
    path: '',
    base64: '',
    fileName: '',
    ...(args.extra ? sanitizeExtraSpread(args.extra) : {}),
  };

  if (isMedia) {
    message.mediaUrl = args.mediaUrl || '';
    if (args.mediaLocalRoots) message.mediaLocalRoots = Array.from(args.mediaLocalRoots);
    message.asVoice = args.asVoice === true;
    message.audioAsVoice = args.audioAsVoice === true;
    message.downloadMedia = args.downloadMedia;
    message.transferMode = 'media';
  }

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
      message: message as {
        platform: string;
        groupId: string;
        userId: string;
        type?: string;
        kind?: 'tool' | 'block' | 'final';
        msg: string;
        path: string;
        base64: string;
        fileName: string;
        [key: string]: unknown;
      },
      ts: createdAt,
    },
    createdAt,
    retryCount: 0,
    nextAttemptAt: createdAt,
  };
}
