import { randomUUID } from 'node:crypto';
import { normalizeAccountId } from '../core/accounts.ts';
import { buildBncrDebugJsonMessage } from '../core/logging.ts';
import type { BncrRoute, OutboxEntry } from '../core/types.ts';
import { buildBncrDurableQueuedResult } from '../messaging/outbound/durable-queue-adapter.ts';

import type { ReplyPayloadInput } from '../messaging/outbound/reply-enqueue.ts';
import type { BncrChannelSendContext, BncrVerifiedTarget } from './channel-runtime-types.ts';

/**
 * Resolve downloadMedia with cascade: host override > ctx > scene > default(false).
 * Marker-level downloadMedia is extracted downstream by the orchestrator's
 * normalisation and has highest priority (overrides whatever we pass).
 */

/** Override fields shared by sendDispatch and messageSendDispatch. */
type ChannelSendOverrideFields = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: unknown;
  asVoice?: boolean;
  audioAsVoice?: boolean;
  downloadMedia?: boolean;
  type?: string;
  kind?: string;
  replyToId?: string;
};

function resolveDownloadMedia(
  to: string,
  overrideValue: boolean | undefined,
  ctxValue: boolean | undefined,
  runtime: BncrChannelSendRuntime,
): boolean | undefined {
  if (overrideValue !== undefined) return overrideValue;
  if (ctxValue !== undefined) return ctxValue;
  return runtime.resolveSceneDownloadMedia?.(to);
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
  /** Resolve downloadMedia from scene config (host/ctx already resolved above). */
  resolveSceneDownloadMedia?: (to: string) => boolean | undefined;
};

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

/**
 * Resolve downloadMedia from scene config when not already set.
 * Scene cascade: host override > ctx > scene config > default(false).
 * (Marker-level downloadMedia overrides everything and is handled downstream.)
 */

export function createBncrChannelSendRuntime(runtime: BncrChannelSendRuntime) {
  /** Extract media-related override fields from a channel send context. */
  function mediaOverrides(ctx: BncrChannelSendContext) {
    return {
      mediaUrl: runtime.asString(ctx.mediaUrl || ''),
      mediaUrls: ctx.mediaUrls,
      asVoice: ctx.asVoice === true,
      audioAsVoice: ctx.audioAsVoice === true,
      type: runtime.asString(ctx.type || '').trim() || undefined,
    };
  }

  function extractSendFields(
    ctx: BncrChannelSendContext,
    overrides?: ChannelSendOverrideFields,
  ): {
    accountId: string;
    to: string;
    text: string;
    mediaUrl: string;
    mediaUrls: unknown;
    asVoice: boolean;
    audioAsVoice: boolean;
    type: string | undefined;
    kind: unknown;
    replyToId: string | undefined;
    extra: Record<string, unknown> | undefined;
    downloadMedia: boolean | undefined;
  } {
    const to = runtime.asString(ctx.to || '').trim();

    // Extract fields from context / overrides WITHOUT normalising markers.
    // Raw text (with markers) is passed downstream; the orchestrator handles
    // all normalisation including marker parsing, pre-send, and media routing.
    const text = overrides?.text !== undefined ? overrides.text : runtime.asString(ctx.text || '');
    const mediaUrl =
      overrides?.mediaUrl !== undefined ? overrides.mediaUrl : runtime.asString(ctx.mediaUrl || '');
    const mediaUrls = overrides?.mediaUrls !== undefined ? overrides.mediaUrls : ctx.mediaUrls;
    const asVoice = overrides?.asVoice ?? ctx.asVoice === true;
    const audioAsVoice = overrides?.audioAsVoice ?? ctx.audioAsVoice === true;
    const type =
      overrides?.type !== undefined
        ? overrides.type
        : runtime.asString(ctx.type || '').trim() || undefined;
    const kind = overrides?.kind ?? ctx.kind;
    const replyToId =
      (overrides?.replyToId ??
        runtime.asString(ctx.replyToId || ctx.replyToMessageId || '').trim()) ||
      undefined;
    const extra =
      typeof ctx.extra === 'object' && ctx.extra !== null ? { ...ctx.extra } : undefined;
    const downloadMedia = resolveDownloadMedia(
      to,
      overrides?.downloadMedia,
      ctx.downloadMedia,
      runtime,
    );

    return {
      accountId: normalizeAccountId(ctx.accountId),
      to,
      text: text,
      mediaUrl: mediaUrl,
      mediaUrls,
      asVoice,
      audioAsVoice,
      type,
      kind,
      replyToId,
      extra,
      downloadMedia,
    };
  }

  /**
   * Single dispatch path for channelSendText / channelSendMedia.
   * Both normalize first then branch media vs text via hasMedia.
   * channelSendMedia passes mediaOverrides(ctx) to ensure media routing,
   * channelSendText passes no overrides and relies on ctx content alone.
   */
  async function sendDispatch(
    ctx: BncrChannelSendContext,
    overrides?: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: unknown;
      asVoice?: boolean;
      audioAsVoice?: boolean;
      downloadMedia?: boolean;
      type?: string;
      kind?: string;
      replyToId?: string;
    },
  ) {
    await runtime.syncDebugFlag();
    const {
      accountId,
      to,
      text,
      mediaUrl,
      mediaUrls,
      asVoice,
      audioAsVoice,
      type,
      kind,
      replyToId,
      extra,
      downloadMedia,
    } = extractSendFields(ctx, overrides);

    runtime.logInfo(
      'outbound',
      buildBncrDebugJsonMessage('send-raw', {
        accountId,
        to,
        textLen: text.length,
        hasMedia: Boolean(mediaUrl || (Array.isArray(mediaUrls) && mediaUrls.length)),
        downloadMedia,
      }),
      { debugOnly: true },
    );

    const verified = runtime.resolveVerifiedTarget(to, accountId);
    runtime.rememberSessionRoute(verified.sessionKey, accountId, verified.route);

    await runtime.enqueueFromReply({
      accountId,
      sessionKey: verified.sessionKey,
      route: verified.route,
      payload: {
        text: text,
        mediaUrl: mediaUrl || undefined,
        mediaUrls: Array.isArray(mediaUrls) && mediaUrls.length ? mediaUrls : undefined,
        asVoice: asVoice || undefined,
        audioAsVoice: audioAsVoice || undefined,
        downloadMedia,
        type,
        extra,
        kind: kind as 'tool' | 'block' | 'final' | undefined,
        replyToId,
      },
      mediaLocalRoots: ctx.mediaLocalRoots,
    });

    return {
      channel: runtime.channelId,
      messageId: randomUUID(),
      chatId: verified.sessionKey,
    };
  }

  /**
   * Durable channel.message path: same normalize, then enqueue handoff.
   */
  async function messageSendDispatch(
    ctx: BncrChannelSendContext,
    overrides?: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: unknown;
      asVoice?: boolean;
      audioAsVoice?: boolean;
      downloadMedia?: boolean;
      type?: string;
      kind?: string;
      replyToId?: string;
    },
  ) {
    const {
      text,
      mediaUrl,
      mediaUrls,
      asVoice,
      audioAsVoice,
      type,
      kind,
      replyToId,
      extra,
      downloadMedia,
    } = extractSendFields(ctx, overrides);

    const entry = await enqueueChannelMessageHandoff(runtime, ctx, {
      text: text,
      mediaUrl: mediaUrl || '',
      mediaUrls: Array.isArray(mediaUrls) && mediaUrls.length ? mediaUrls : undefined,
      asVoice,
      audioAsVoice,
      downloadMedia,
      type,
      extra,
      kind: kind as 'tool' | 'block' | 'final' | undefined,
      replyToId,
    });
    return buildBncrDurableQueuedResult({ entry });
  }

  return {
    channelSendText: (ctx: BncrChannelSendContext) => sendDispatch(ctx),
    channelSendMedia: (ctx: BncrChannelSendContext) => sendDispatch(ctx, mediaOverrides(ctx)),

    channelMessageSendText: async (ctx: BncrChannelSendContext) => messageSendDispatch(ctx),

    channelMessageSendMedia: async (ctx: BncrChannelSendContext) =>
      messageSendDispatch(ctx, mediaOverrides(ctx)),

    channelMessageSendPayload: async (ctx: BncrChannelSendContext) => {
      const p = ctx?.payload || {};
      if (!p || typeof p !== 'object') {
        throw new Error('bncr channel.message payload must be an object');
      }
      return messageSendDispatch(ctx, {
        text: runtime.asString(p.text || p.message || p.caption || ''),
        mediaUrl: runtime.asString(p.mediaUrl || ''),
        mediaUrls: Array.isArray(p.mediaUrls) ? p.mediaUrls : undefined,
        asVoice: p.asVoice === true,
        audioAsVoice: p.audioAsVoice === true,
        downloadMedia: p.downloadMedia as boolean | undefined,
        type: runtime.asString(p.type || '').trim() || undefined,
        kind: typeof p.kind === 'string' ? p.kind : ctx.kind,
        replyToId:
          runtime.asString(p.replyToId || ctx?.replyToId || ctx?.replyToMessageId || '').trim() ||
          undefined,
      });
    },
  };
}
