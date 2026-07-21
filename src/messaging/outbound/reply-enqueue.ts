import { buildBncrDebugJsonMessage } from '../../core/logging.ts';
import type { BncrRoute, OutboxEntry } from '../../core/types.ts';
import {
  buildNormalizedSends,
  type NormalizedOutboundSend,
  normalizeOutboundSend,
} from './normalize-outbound-send.ts';
import { hasReplyMediaEntries } from './reply-enqueue-media.ts';
import type { OutboundReplyTargetPolicy } from './reply-target-policy.ts';
import { normalizeOutboundReplyToId } from './reply-target-policy.ts';

const MEDIA_TEXT_SPLIT_THRESHOLD = 1020;

type BuildOutboxEntryFn = (args: {
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  type?: string;
  msg: string;
  kind?: 'tool' | 'block' | 'final';
  replyToId?: string;
  replyTargetPolicy?: OutboundReplyTargetPolicy;
  extra?: Record<string, unknown>;
  transferMode?: 'text' | 'media';
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  asVoice?: boolean;
  audioAsVoice?: boolean;
  downloadMedia?: boolean;
}) => OutboxEntry;

export type ReplyEnqueuePlan =
  | { kind: 'text-only' }
  | { kind: 'media-only'; clearText: false }
  | { kind: 'text-and-media'; clearText: true };

export type { OutboundReplyTargetPolicy } from './reply-target-policy.ts';

export type ReplyPayloadInput = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  asVoice?: boolean;
  audioAsVoice?: boolean;
  downloadMedia?: boolean;
  type?: string;
  markerHasMsg?: boolean;
  extra?: Record<string, unknown>;
  kind?: 'tool' | 'block' | 'final';
  replyToId?: string;
};

export type NormalizedReplyPayload = {
  text: string;
  mediaUrl: string;
  mediaUrls?: string[];
  mediaList: string[];
  asVoice: boolean;
  audioAsVoice: boolean;
  downloadMedia?: boolean;
  type?: string;
  markerHasMsg?: boolean;
  extra?: Record<string, unknown>;
  kind?: 'tool' | 'block' | 'final';
  replyToId: string;
  replyTargetPolicy: OutboundReplyTargetPolicy;
};

export type EnqueueNormalizedReplyPayloadParams = {
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  payload: NormalizedReplyPayload;
  mediaLocalRoots?: readonly string[];
  replyToId?: string;
};

function shouldSplitReplyMediaText(payload: NormalizedReplyPayload) {
  if (!payload.text) return false;
  if (payload.mediaList.length > 1) return true;
  return payload.text.length > MEDIA_TEXT_SPLIT_THRESHOLD;
}

export function buildReplyEnqueuePlan(payload: NormalizedReplyPayload): ReplyEnqueuePlan {
  if (!hasReplyMediaEntries(payload)) {
    return { kind: 'text-only' };
  }

  if (shouldSplitReplyMediaText(payload)) {
    return { kind: 'text-and-media', clearText: true };
  }

  return { kind: 'media-only', clearText: false };
}

/**
 * @deprecated Only used by native-reply-delivery.test.mjs. Not called from production code.
 */
export function enqueueReplyTextEntry(
  params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: NormalizedReplyPayload;
  },
  helpers: {
    enqueueOutbound: (entry: OutboxEntry) => void;
    buildOutboxEntry: (args: {
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      type?: string;
      msg: string;
      kind?: 'tool' | 'block' | 'final';
      replyToId?: string;
      replyTargetPolicy?: OutboundReplyTargetPolicy;
      extra?: Record<string, unknown>;
      transferMode?: 'text' | 'media';
    }) => OutboxEntry;
  },
): void {
  if (!params.payload.text && !params.payload.extra) return;

  helpers.enqueueOutbound(
    helpers.buildOutboxEntry({
      accountId: params.accountId,
      sessionKey: params.sessionKey,
      route: params.route,
      type: 'text',
      msg: params.payload.text,
      extra: params.payload.extra,
      kind: params.payload.kind,
      replyToId: params.payload.replyToId,
      replyTargetPolicy: params.payload.replyTargetPolicy,
    }),
  );
}

/**
 * Dispatch all entries from the normalisation plan through a unified path.
 *
 * `buildNormalizedSends` returns one or more sends (pre-send text-only +
 * main payload).  Every entry goes through `buildReplyEnqueuePlan` → the same
 * text/media dispatch.  There is no separate pre-send or main-send branch.
 */
function buildSendPayload(
  entry: NormalizedOutboundSend,
  parent: NormalizedReplyPayload,
): NormalizedReplyPayload {
  return {
    text: entry.text,
    mediaUrl: entry.mediaUrl || '',
    mediaUrls: entry.mediaUrls,
    mediaList: entry.mediaUrl ? [entry.mediaUrl] : entry.mediaUrls?.length ? entry.mediaUrls : [],
    asVoice: entry.asVoice,
    audioAsVoice: entry.audioAsVoice,
    downloadMedia: entry.downloadMedia,
    type: entry.type,
    extra: entry.extra,
    kind: entry.kind,
    replyToId: entry.replyToId ?? '',
    replyTargetPolicy: parent.replyTargetPolicy,
  };
}

/**
 * Unified outbound dispatch: single exit point for all sends.
 *
 * Iterates `buildNormalizedSends` entries and dispatches each through
 * the existing text or media helpers internally.  External callers only
 * see one unified function — they do not choose the branch.
 */
function enqueueUnifiedOutbound(
  params: EnqueueNormalizedReplyPayloadParams,
  helpers: {
    enqueueOutbound: (entry: OutboxEntry) => void;
    buildOutboxEntry: BuildOutboxEntryFn;
    tryBuildMediaDedupeFallback: (args: {
      sessionKey: string;
      mediaUrl: string;
      text: string;
      replyToId: string;
      currentTime: number;
    }) => {
      text: string;
      reason: 'same-text-sent-checkmark' | 'text-changed-downgrade';
    } | null;
    rememberRecentMediaSend: (args: {
      sessionKey: string;
      mediaUrl: string;
      text: string;
      replyToId: string;
      createdAt: number;
    }) => void;
    logInfo: (
      scope: string | undefined,
      message: string,
      options?: { debugOnly?: boolean },
    ) => void;
  },
): void {
  for (const entry of buildNormalizedSends(params.payload)) {
    const sendPayload = buildSendPayload(entry, params.payload);
    const plan = buildReplyEnqueuePlan(sendPayload);

    if (plan.kind === 'text-and-media') {
      // Text first, then media entries with empty text
      helpers.enqueueOutbound(
        helpers.buildOutboxEntry({
          accountId: params.accountId,
          sessionKey: params.sessionKey,
          route: params.route,
          type: 'text',
          msg: sendPayload.text,
          kind: sendPayload.kind,
          replyToId: sendPayload.replyToId || undefined,
          replyTargetPolicy: sendPayload.replyTargetPolicy,
          extra: sendPayload.extra,
        }),
      );
      enqueueUnifiedMediaEntries(params, sendPayload, '', helpers);
      continue;
    }

    if (plan.kind !== 'text-only') {
      // Media-only: first entry carries caption text
      enqueueUnifiedMediaEntries(params, sendPayload, sendPayload.text, helpers);
      continue;
    }

    // Text-only
    if (!sendPayload.text && !sendPayload.extra) continue;
    helpers.enqueueOutbound(
      helpers.buildOutboxEntry({
        accountId: params.accountId,
        sessionKey: params.sessionKey,
        route: params.route,
        type: 'text',
        msg: sendPayload.text,
        kind: sendPayload.kind,
        replyToId: sendPayload.replyToId || undefined,
        replyTargetPolicy: sendPayload.replyTargetPolicy,
        extra: sendPayload.extra,
      }),
    );
  }
}

/** Internal: iterate mediaList and enqueue file-transfer entries (with dedup). */
function enqueueUnifiedMediaEntries(
  params: EnqueueNormalizedReplyPayloadParams,
  sendPayload: NormalizedReplyPayload,
  firstCaption: string,
  helpers: {
    enqueueOutbound: (entry: OutboxEntry) => void;
    buildOutboxEntry: BuildOutboxEntryFn;
    tryBuildMediaDedupeFallback: (args: {
      sessionKey: string;
      mediaUrl: string;
      text: string;
      replyToId: string;
      currentTime: number;
    }) => {
      text: string;
      reason: 'same-text-sent-checkmark' | 'text-changed-downgrade';
    } | null;
    rememberRecentMediaSend: (args: {
      sessionKey: string;
      mediaUrl: string;
      text: string;
      replyToId: string;
      createdAt: number;
    }) => void;
    logInfo: (
      scope: string | undefined,
      message: string,
      options?: { debugOnly?: boolean },
    ) => void;
  },
): void {
  let first = true;
  for (const mediaUrl of sendPayload.mediaList) {
    const text = first ? firstCaption : '';
    const currentTime = Date.now();
    const normalizedText = text || '';
    const fallback = helpers.tryBuildMediaDedupeFallback({
      sessionKey: params.sessionKey,
      mediaUrl,
      text: normalizedText,
      replyToId: sendPayload.replyToId,
      currentTime,
    });

    if (fallback) {
      helpers.logInfo(
        'outbound',
        buildBncrDebugJsonMessage('media-dedupe-hit', {
          sessionKey: params.sessionKey,
          mediaUrl,
          text: normalizedText,
          replyToId: sendPayload.replyToId,
          reason: fallback.reason,
        }),
        { debugOnly: true },
      );
      helpers.enqueueOutbound(
        helpers.buildOutboxEntry({
          accountId: params.accountId,
          sessionKey: params.sessionKey,
          route: params.route,
          type: 'text',
          msg: fallback.text,
          kind: sendPayload.kind,
          replyToId: sendPayload.replyToId || undefined,
          replyTargetPolicy: sendPayload.replyTargetPolicy,
        }),
      );
      first = false;
      continue;
    }

    helpers.enqueueOutbound(
      helpers.buildOutboxEntry({
        accountId: params.accountId,
        sessionKey: params.sessionKey,
        route: params.route,
        type: sendPayload.type,
        msg: text,
        kind: sendPayload.kind,
        replyToId: sendPayload.replyToId,
        replyTargetPolicy: sendPayload.replyTargetPolicy,
        extra: sendPayload.extra,
        transferMode: 'media',
        mediaUrl,
        mediaLocalRoots: params.mediaLocalRoots,
        asVoice: sendPayload.asVoice,
        audioAsVoice: sendPayload.audioAsVoice,
        downloadMedia: sendPayload.downloadMedia,
      }),
    );
    helpers.rememberRecentMediaSend({
      sessionKey: params.sessionKey,
      mediaUrl,
      text: normalizedText,
      replyToId: sendPayload.replyToId,
      createdAt: currentTime,
    });
    first = false;
  }
}

export function enqueueNormalizedReplyPayload(
  params: EnqueueNormalizedReplyPayloadParams,
  helpers: {
    logEnqueueFromReply: (args: {
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      payload: NormalizedReplyPayload;
    }) => void;
    enqueueOutbound: (entry: OutboxEntry) => void;
    buildOutboxEntry: BuildOutboxEntryFn;
    tryBuildMediaDedupeFallback: (args: {
      sessionKey: string;
      mediaUrl: string;
      text: string;
      replyToId: string;
      currentTime: number;
    }) => {
      text: string;
      reason: 'same-text-sent-checkmark' | 'text-changed-downgrade';
    } | null;
    rememberRecentMediaSend: (args: {
      sessionKey: string;
      mediaUrl: string;
      text: string;
      replyToId: string;
      createdAt: number;
    }) => void;
    logInfo: (
      scope: string | undefined,
      message: string,
      options?: { debugOnly?: boolean },
    ) => void;
  },
): void {
  // Log only the main (last) send entry for traceability.
  helpers.logEnqueueFromReply({
    accountId: params.accountId,
    sessionKey: params.sessionKey,
    route: params.route,
    payload: params.payload,
  });

  // Dispatch ALL entries (pre-send + main) through the same path.
  enqueueUnifiedOutbound(params, helpers);
}

export async function normalizeReplyPayload(
  payload: ReplyPayloadInput,
  helpers: { asString: (value: unknown, fallback?: string) => string },
  options?: { replyTargetPolicy?: OutboundReplyTargetPolicy },
): Promise<NormalizedReplyPayload> {
  const normalized = await normalizeOutboundSend({
    text: helpers.asString(payload?.text || ''),
    mediaUrl: helpers.asString(payload?.mediaUrl || ''),
    mediaUrls: payload?.mediaUrls,
    asVoice: payload?.asVoice === true,
    audioAsVoice: payload?.audioAsVoice === true,
    downloadMedia: payload?.downloadMedia,
    type: helpers.asString(payload?.type || '').trim() || undefined,
    kind: payload?.kind,
    replyToId: payload?.replyToId,
    extra: payload?.extra,
  });

  const markerHasMsg = normalized.markerHasMsg === true;
  const mediaUrl = helpers.asString(normalized.mediaUrl || '');
  const mediaUrls = normalized.mediaUrls;
  const mediaList = mediaUrls?.length ? mediaUrls : mediaUrl ? [mediaUrl] : [];
  const kind = normalized.kind;
  const replyTargetPolicy = options?.replyTargetPolicy ?? 'agent-default';

  return {
    text: normalized.text,
    mediaUrl,
    mediaUrls,
    mediaList,
    asVoice: normalized.asVoice,
    audioAsVoice: normalized.audioAsVoice,
    downloadMedia: normalized.downloadMedia,
    ...(normalized.type ? { type: normalized.type } : {}),
    ...(normalized.extra ? { extra: normalized.extra } : {}),
    markerHasMsg,
    kind,
    replyTargetPolicy,
    replyToId: normalizeOutboundReplyToId({
      kind,
      replyToId: normalized.replyToId ?? payload?.replyToId,
      replyTargetPolicy,
    }),
  };
}
