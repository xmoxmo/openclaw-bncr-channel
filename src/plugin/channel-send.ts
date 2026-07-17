import { randomUUID } from 'node:crypto';
import { normalizeAccountId } from '../core/accounts.ts';
import { buildBncrDebugJsonMessage } from '../core/logging.ts';
import type { BncrRoute, OutboxEntry } from '../core/types.ts';
import { buildBncrDurableQueuedResult } from '../messaging/outbound/durable-queue-adapter.ts';
import { extractConsumptionFields, parseBncrMarker } from '../messaging/outbound/marker-parser.ts';
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

/**
 * Merge all extra sources (ctx.extra, marker params, host-level fields)
 * into a single extra bag. Strips consumption fields and returns them
 * as independent params, remaining extra passes through the pipeline.
 */
function resolveUnifiedOutboundExtra(ctx: BncrChannelSendContext): {
  cleanText: string;
  extra: Record<string, unknown>;
  consumed: {
    asVoice?: boolean;
    audioAsVoice?: boolean;
    downloadMedia?: boolean;
    type?: string;
    kind?: string;
    replyToId?: string;
  };
} {
  // 1. Parse marker from text
  const { cleanText, params: markerParams } = parseBncrMarker(
    typeof ctx.text === 'string' ? ctx.text : '',
  );

  // 2. Merge all sources: extra from ctx + marker params + host-level fields
  const merged: Record<string, unknown> = {
    ...(typeof ctx.extra === 'object' && ctx.extra !== null ? ctx.extra : {}),
    ...markerParams,
  };
  if (ctx.forceDocument === true) merged.forceDocument = true;
  if (ctx.gifPlayback === true) merged.gifPlayback = true;
  if (ctx.silent === true) merged.silent = true;

  // 3. Strip consumption fields
  const { consumed, remaining } = extractConsumptionFields(merged);

  return {
    cleanText,
    extra: remaining,
    consumed,
  };
}

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
      downloadMedia?: boolean;
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
      downloadMedia: args.payload.downloadMedia,
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
  extra?: Record<string, unknown>,
) {
  if (extra && Object.keys(extra).length > 0) {
    payload = { ...payload, extra: { ...extra } };
  }
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
  /**
   * Single dispatch: resolves unified extra (marker + ctx + host fields),
   * determines text vs media route, and calls the appropriate send function.
   */
  async function sendDispatch(ctx: BncrChannelSendContext) {
    await runtime.syncDebugFlag();
    const accountId = normalizeAccountId(ctx.accountId);
    const to = runtime.asString(ctx.to || '').trim();
    const { cleanText, extra, consumed } = resolveUnifiedOutboundExtra(ctx);
    const replyToId = resolveChannelSendReplyToId(runtime.asString, ctx);

    // Resolve effective media params: ctx.mediaUrl is the source of truth.
    // extra.path/mediaUrl from marker only triggers media when:
    //   - it is a local file path (starts with / or ./), OR
    //   - consumed.type is a known media type (file/image/video/audio)
    // Otherwise they are treated as metadata (e.g. appmsg thumbnail URL).
    const ctxMediaUrl = runtime.asString(ctx.mediaUrl || '').trim();
    const markerPath = runtime
      .asString((extra.path as string) || (extra.mediaUrl as string) || '')
      .trim();
    const isLocalPath =
      markerPath.startsWith('/') || markerPath.startsWith('./') || markerPath.startsWith('../');
    const isMediaType = ['file', 'image', 'video', 'audio'].includes(consumed.type || '');
    const effectiveMediaUrl = ctxMediaUrl || (isLocalPath || isMediaType ? markerPath : '');
    const effectiveMediaUrls = Array.isArray(ctx?.mediaUrls) ? ctx.mediaUrls : undefined;
    const asVoice = consumed.asVoice ?? ctx?.asVoice === true;
    const audioAsVoice = consumed.audioAsVoice ?? ctx?.audioAsVoice === true;
    const downloadMedia = consumed.downloadMedia ?? ctx?.downloadMedia ?? false;
    const type = consumed.type ?? (runtime.asString(ctx?.type || '').trim() || undefined);
    const hasMedia = !!(effectiveMediaUrl || effectiveMediaUrls?.length);
    console.log(
      '[bncr] send-dispatch cleanText=' +
        JSON.stringify(cleanText) +
        '|downloadMedia=' +
        JSON.stringify(consumed.downloadMedia) +
        '|hasMedia=' +
        hasMedia +
        '|mediaUrl=' +
        JSON.stringify(effectiveMediaUrl),
    );

    const kind: 'text' | 'media' = hasMedia ? 'media' : 'text';
    logChannelSendEntry(runtime, {
      kind,
      accountId,
      to,
      ctx,
      payload: {
        text: cleanText,
        mediaUrl: effectiveMediaUrl,
        mediaUrls: effectiveMediaUrls,
        asVoice,
        audioAsVoice,
      },
    });

    if (hasMedia) {
      return sendBncrMedia({
        channelId: runtime.channelId,
        accountId,
        to,
        text: cleanText,
        mediaUrl: effectiveMediaUrl,
        mediaUrls: effectiveMediaUrls,
        asVoice,
        audioAsVoice,
        downloadMedia,
        type,
        extra: Object.keys(extra).length > 0 ? extra : undefined,
        kind: normalizeReplyKind(ctx?.kind),
        replyToId,
        mediaLocalRoots: ctx.mediaLocalRoots,
        resolveVerifiedTarget: (...a) => runtime.resolveVerifiedTarget(...a),
        rememberSessionRoute: (...a) => runtime.rememberSessionRoute(...a),
        enqueueFromReply: (a) => runtime.enqueueFromReply(a),
        createMessageId: () => randomUUID(),
      });
    }

    return sendBncrText({
      channelId: runtime.channelId,
      accountId,
      to,
      text: cleanText,
      kind: normalizeReplyKind(ctx?.kind),
      replyToId,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
      mediaLocalRoots: ctx.mediaLocalRoots,
      resolveVerifiedTarget: (...a) => runtime.resolveVerifiedTarget(...a),
      rememberSessionRoute: (...a) => runtime.rememberSessionRoute(...a),
      enqueueFromReply: (a) => runtime.enqueueFromReply(a),
      createMessageId: () => randomUUID(),
    });
  }

  /**
   * Durable dispatch: same logic but enqueues via channel message handoff.
   */
  async function messageSendDispatch(
    ctx: BncrChannelSendContext,
    inputOverrides?: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      asVoice?: boolean;
      audioAsVoice?: boolean;
      downloadMedia?: boolean;
      type?: string;
      kind?: ReplyPayloadInput['kind'];
      replyToId?: string;
    },
  ) {
    // Merge inputOverrides text into ctx so marker parsing sees the effective text
    const effectiveCtx =
      inputOverrides?.text !== undefined ? { ...ctx, text: inputOverrides.text } : ctx;
    const { cleanText, extra, consumed } = resolveUnifiedOutboundExtra(effectiveCtx);
    const replyToId = resolveChannelSendReplyToId(runtime.asString, ctx);

    console.log(
      '[bncr] msg-dispatch cleanText=' +
        JSON.stringify(cleanText) +
        '|downloadMedia=' +
        JSON.stringify(consumed.downloadMedia) +
        '|mediaUrl=' +
        JSON.stringify(inputOverrides?.mediaUrl),
    );

    const payload: ReplyPayloadInput = {
      text: cleanText,
      mediaUrl: inputOverrides?.mediaUrl || '',
      mediaUrls: inputOverrides?.mediaUrls,
      asVoice: consumed.asVoice ?? inputOverrides?.asVoice ?? false,
      audioAsVoice: consumed.audioAsVoice ?? inputOverrides?.audioAsVoice ?? false,
      downloadMedia: consumed.downloadMedia ?? inputOverrides?.downloadMedia ?? false,
      type: consumed.type ?? inputOverrides?.type,
      kind: normalizeReplyKind(consumed.kind) ?? inputOverrides?.kind,
      replyToId: inputOverrides?.replyToId || replyToId,
      ...(Object.keys(extra).length > 0 ? { extra: { ...extra } } : {}),
    };
    const entry = await enqueueChannelMessageHandoff(runtime, ctx, payload, extra);
    return buildBncrDurableQueuedResult({ entry });
  }

  return {
    channelSendText: sendDispatch,
    channelSendMedia: sendDispatch,

    channelMessageSendText: async (ctx: BncrChannelSendContext) =>
      messageSendDispatch(ctx, { kind: normalizeReplyKind(ctx?.kind) }),

    channelMessageSendMedia: async (ctx: BncrChannelSendContext) =>
      messageSendDispatch(ctx, {
        mediaUrl: runtime.asString(ctx.mediaUrl || ''),
        mediaUrls: Array.isArray(ctx?.mediaUrls) ? ctx.mediaUrls : undefined,
        asVoice: ctx?.asVoice === true,
        audioAsVoice: ctx?.audioAsVoice === true,
        type: runtime.asString(ctx.type || '').trim() || undefined,
        kind: normalizeReplyKind(ctx?.kind),
      }),

    channelMessageSendPayload: async (ctx: BncrChannelSendContext) => {
      const p = ctx?.payload || {};
      if (!p || typeof p !== 'object')
        throw new Error('bncr channel.message payload must be an object');
      return messageSendDispatch(ctx, {
        text: runtime.asString(p.text || p.message || p.caption || ''),
        mediaUrl: runtime.asString(p.mediaUrl || ''),
        mediaUrls: Array.isArray(p.mediaUrls) ? p.mediaUrls : undefined,
        asVoice: p.asVoice === true,
        audioAsVoice: p.audioAsVoice === true,
        downloadMedia: p.downloadMedia === true,
        type: runtime.asString(p.type || '').trim() || undefined,
        kind: normalizeReplyKind(p.kind) ?? normalizeReplyKind(ctx?.kind),
        replyToId:
          runtime.asString(p.replyToId || ctx?.replyToId || ctx?.replyToMessageId || '').trim() ||
          undefined,
      });
    },
  };
}
