import { randomUUID } from 'node:crypto';
import { normalizeAccountId } from '../core/accounts.ts';
import { buildBncrDebugJsonMessage } from '../core/logging.ts';
import type { BncrRoute, OutboxEntry } from '../core/types.ts';
import { buildBncrDurableQueuedResult } from '../messaging/outbound/durable-queue-adapter.ts';
import type { ReplyPayloadInput } from '../messaging/outbound/reply-enqueue.ts';
import { sendBncrMedia, sendBncrText } from '../messaging/outbound/send.ts';
import type { BncrChannelSendContext, BncrVerifiedTarget } from './channel-runtime-types.ts';

function normalizeReplyKind(value: unknown): ReplyPayloadInput['kind'] {
  return value === 'tool' || value === 'block' || value === 'final' ? value : undefined;
}

export type BncrChannelSendRuntime = {
  channelId: string;
  asString: (value: unknown, fallback?: string) => string;
  syncDebugFlag: () => Promise<void>;
  logInfo: (scope: string, message: string, options?: Record<string, unknown>) => void;
  resolveVerifiedTarget: (to: string, accountId: string) => BncrVerifiedTarget;
  rememberSessionRoute: (sessionKey: string, accountId: string, route: BncrRoute) => void;
  enqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: ReplyPayloadInput;
    mediaLocalRoots?: readonly string[];
  }) => Promise<void>;
  listOutboxEntries: () => OutboxEntry[];
};

function resolveChannelSendReplyToId(
  asString: BncrChannelSendRuntime['asString'],
  ctx: BncrChannelSendContext,
) {
  return asString(ctx?.replyToId || ctx?.replyToMessageId || '').trim() || undefined;
}

function logChannelSendEntry(
  runtime: BncrChannelSendRuntime,
  args: {
    kind: 'text' | 'media';
    accountId: string;
    to: string;
    ctx: BncrChannelSendContext;
    payload: {
      text: string;
      mediaUrl: string;
      mediaUrls?: string[];
      asVoice?: boolean;
      audioAsVoice?: boolean;
    };
  },
) {
  runtime.logInfo(
    'outbound',
    buildBncrDebugJsonMessage(`send-entry:${args.kind}`, {
      accountId: args.accountId,
      to: args.to,
      text: args.payload.text,
      mediaUrl: args.payload.mediaUrl,
      mediaUrls: args.payload.mediaUrls,
      asVoice: args.payload.asVoice,
      audioAsVoice: args.payload.audioAsVoice,
      sessionKey: runtime.asString(args.ctx?.sessionKey || ''),
      mirrorSessionKey: runtime.asString(args.ctx?.mirror?.sessionKey || ''),
      rawCtx: {
        to: args.ctx?.to,
        accountId: args.ctx?.accountId,
        threadId: args.ctx?.threadId,
        replyToId: args.ctx?.replyToId,
      },
    }),
    { debugOnly: true },
  );
}

async function enqueueChannelMessageHandoff(
  runtime: BncrChannelSendRuntime,
  ctx: BncrChannelSendContext,
  payload: ReplyPayloadInput,
) {
  const accountId = normalizeAccountId(ctx.accountId);
  const to = runtime.asString(ctx.to || '').trim();
  const verified = runtime.resolveVerifiedTarget(to, accountId);
  runtime.rememberSessionRoute(verified.sessionKey, accountId, verified.route);
  const before = new Set(runtime.listOutboxEntries().map((entry) => entry.messageId));
  await runtime.enqueueFromReply({
    accountId,
    sessionKey: verified.sessionKey,
    route: verified.route,
    payload,
    mediaLocalRoots: ctx.mediaLocalRoots,
  });
  const entries = runtime.listOutboxEntries().filter((entry) => !before.has(entry.messageId));
  if (!entries.length) {
    throw new Error('bncr channel.message handoff did not enqueue an outbox entry');
  }
  return entries[entries.length - 1];
}

export function createBncrChannelSendRuntime(runtime: BncrChannelSendRuntime) {
  return {
    channelSendText: async (ctx: BncrChannelSendContext) => {
      await runtime.syncDebugFlag();
      const accountId = normalizeAccountId(ctx.accountId);
      const to = runtime.asString(ctx.to || '').trim();
      const replyToId = resolveChannelSendReplyToId(runtime.asString, ctx);

      logChannelSendEntry(runtime, {
        kind: 'text',
        accountId,
        to,
        ctx,
        payload: {
          text: runtime.asString(ctx?.text || ''),
          mediaUrl: runtime.asString(ctx?.mediaUrl || ''),
        },
      });

      return sendBncrText({
        channelId: runtime.channelId,
        accountId,
        to,
        text: runtime.asString(ctx.text || ''),
        kind: normalizeReplyKind(ctx?.kind),
        replyToId,
        mediaLocalRoots: ctx.mediaLocalRoots,
        resolveVerifiedTarget: (targetTo, targetAccountId) =>
          runtime.resolveVerifiedTarget(targetTo, targetAccountId),
        rememberSessionRoute: (sessionKey, routeAccountId, route) =>
          runtime.rememberSessionRoute(sessionKey, routeAccountId, route),
        enqueueFromReply: (args) => runtime.enqueueFromReply(args),
        createMessageId: () => randomUUID(),
      });
    },

    channelSendMedia: async (ctx: BncrChannelSendContext) => {
      await runtime.syncDebugFlag();
      const accountId = normalizeAccountId(ctx.accountId);
      const to = runtime.asString(ctx.to || '').trim();
      const asVoice = ctx?.asVoice === true;
      const audioAsVoice = ctx?.audioAsVoice === true;
      const type = runtime.asString(ctx?.type || '').trim() || undefined;
      const replyToId = resolveChannelSendReplyToId(runtime.asString, ctx);

      logChannelSendEntry(runtime, {
        kind: 'media',
        accountId,
        to,
        ctx,
        payload: {
          text: runtime.asString(ctx?.text || ''),
          mediaUrl: runtime.asString(ctx?.mediaUrl || ''),
          mediaUrls: Array.isArray(ctx?.mediaUrls) ? ctx.mediaUrls : undefined,
          asVoice,
          audioAsVoice,
        },
      });

      return sendBncrMedia({
        channelId: runtime.channelId,
        accountId,
        to,
        text: runtime.asString(ctx.text || ''),
        mediaUrl: runtime.asString(ctx.mediaUrl || ''),
        mediaUrls: Array.isArray(ctx?.mediaUrls) ? ctx.mediaUrls : undefined,
        asVoice,
        audioAsVoice,
        type,
        kind: normalizeReplyKind(ctx?.kind),
        replyToId,
        mediaLocalRoots: ctx.mediaLocalRoots,
        resolveVerifiedTarget: (targetTo, targetAccountId) =>
          runtime.resolveVerifiedTarget(targetTo, targetAccountId),
        rememberSessionRoute: (sessionKey, routeAccountId, route) =>
          runtime.rememberSessionRoute(sessionKey, routeAccountId, route),
        enqueueFromReply: (args) => runtime.enqueueFromReply(args),
        createMessageId: () => randomUUID(),
      });
    },

    channelMessageSendText: async (ctx: BncrChannelSendContext) => {
      const entry = await enqueueChannelMessageHandoff(runtime, ctx, {
        text: runtime.asString(ctx.text || ''),
        kind: normalizeReplyKind(ctx?.kind),
        replyToId: resolveChannelSendReplyToId(runtime.asString, ctx),
      });
      return buildBncrDurableQueuedResult({ entry });
    },

    channelMessageSendMedia: async (ctx: BncrChannelSendContext) => {
      const entry = await enqueueChannelMessageHandoff(runtime, ctx, {
        text: runtime.asString(ctx.text || ''),
        mediaUrl: runtime.asString(ctx.mediaUrl || ''),
        mediaUrls: Array.isArray(ctx?.mediaUrls) ? ctx.mediaUrls : undefined,
        asVoice: ctx?.asVoice === true,
        audioAsVoice: ctx?.audioAsVoice === true,
        type: runtime.asString(ctx?.type || '').trim() || undefined,
        kind: normalizeReplyKind(ctx?.kind),
        replyToId: resolveChannelSendReplyToId(runtime.asString, ctx),
      });
      return buildBncrDurableQueuedResult({ entry });
    },

    channelMessageSendPayload: async (ctx: BncrChannelSendContext) => {
      const payload = ctx?.payload || {};
      if (!payload || typeof payload !== 'object') {
        throw new Error('bncr channel.message payload must be an object');
      }
      const entry = await enqueueChannelMessageHandoff(runtime, ctx, {
        text: runtime.asString(payload.text || payload.message || payload.caption || ''),
        mediaUrl: runtime.asString(payload.mediaUrl || ''),
        mediaUrls: Array.isArray(payload.mediaUrls) ? payload.mediaUrls : undefined,
        asVoice: payload.asVoice === true,
        audioAsVoice: payload.audioAsVoice === true,
        type: runtime.asString(payload.type || '').trim() || undefined,
        kind: normalizeReplyKind(payload.kind),
        replyToId:
          runtime
            .asString(payload.replyToId || ctx?.replyToId || ctx?.replyToMessageId || '')
            .trim() || undefined,
      });
      return buildBncrDurableQueuedResult({ entry });
    },
  };
}
