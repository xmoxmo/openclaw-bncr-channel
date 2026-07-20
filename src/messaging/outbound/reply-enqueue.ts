import type { BncrRoute, OutboxEntry } from '../../core/types.ts';
import { buildNormalizedSends, normalizeOutboundSend } from './normalize-outbound-send.ts';
import { hasReplyMediaEntries } from './reply-enqueue-media.ts';
import type { OutboundReplyTargetPolicy } from './reply-target-policy.ts';
import { normalizeOutboundReplyToId } from './reply-target-policy.ts';

const MEDIA_TEXT_SPLIT_THRESHOLD = 1020;

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

export type ReplyMediaEntriesParams = {
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  payload: NormalizedReplyPayload;
  mediaLocalRoots?: readonly string[];
};

export type EnqueueNormalizedReplyPayloadParams = {
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  payload: NormalizedReplyPayload;
  mediaLocalRoots?: readonly string[];
  replyToId?: string;
};

export type ReplyMediaFileTransferParams = {
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  text: string;
  normalizedText: string;
  asVoice: boolean;
  audioAsVoice: boolean;
  downloadMedia?: boolean;
  type?: string;
  markerHasMsg?: boolean;
  extra?: Record<string, unknown>;
  kind?: 'tool' | 'block' | 'final';
  replyToId: string;
  replyTargetPolicy: OutboundReplyTargetPolicy;
  createdAt: number;
};

export type EnqueueSingleReplyMediaEntryParams = {
  params: ReplyMediaEntriesParams;
  mediaUrl: string;
  normalizedText: string;
  text: string;
  fallback: { text: string; reason: string } | null;
  currentTime: number;
};

export type ReplyMediaFallbackTextEntryParams = {
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  mediaUrl: string;
  kind?: 'tool' | 'block' | 'final';
  replyToId: string;
  replyTargetPolicy: OutboundReplyTargetPolicy;
  fallback: { text: string; reason: string };
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

function withoutReplyMediaText(payload: NormalizedReplyPayload): NormalizedReplyPayload {
  return {
    ...payload,
    text: '',
  };
}

function buildReplyTextOutboxEntry(
  params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    text: string;
    kind?: 'tool' | 'block' | 'final';
    replyToId: string;
    replyTargetPolicy: OutboundReplyTargetPolicy;
    markerHasMsg?: boolean;
    extra?: Record<string, unknown>;
  },
  helpers: {
    buildTextOutboxEntry: (args: {
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      text: string;
      kind?: 'tool' | 'block' | 'final';
      replyToId?: string;
      replyTargetPolicy?: OutboundReplyTargetPolicy;
      markerHasMsg?: boolean;
      extra?: Record<string, unknown>;
    }) => OutboxEntry;
  },
): OutboxEntry {
  return helpers.buildTextOutboxEntry({
    accountId: params.accountId,
    sessionKey: params.sessionKey,
    route: params.route,
    text: params.text,
    kind: params.kind,
    replyToId: params.replyToId || undefined,
    replyTargetPolicy: params.replyTargetPolicy,
    extra: params.extra,
  });
}

export function enqueueReplyTextEntry(
  params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: NormalizedReplyPayload;
  },
  helpers: {
    enqueueOutbound: (entry: OutboxEntry) => void;
    buildTextOutboxEntry: (args: {
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      text: string;
      kind?: 'tool' | 'block' | 'final';
      replyToId?: string;
      replyTargetPolicy?: OutboundReplyTargetPolicy;
      markerHasMsg?: boolean;
      extra?: Record<string, unknown>;
    }) => OutboxEntry;
  },
): void {
  if (!params.payload.text && !params.payload.extra) return;

  helpers.enqueueOutbound(
    buildReplyTextOutboxEntry(
      {
        accountId: params.accountId,
        sessionKey: params.sessionKey,
        route: params.route,
        text: params.payload.text,
        extra: params.payload.extra,
        kind: params.payload.kind,
        replyToId: params.payload.replyToId,
        replyTargetPolicy: params.payload.replyTargetPolicy,
      },
      { buildTextOutboxEntry: helpers.buildTextOutboxEntry },
    ),
  );
}

/**
 * Dispatch all entries from the normalisation plan through a unified path.
 *
 * `buildNormalizedSends` returns one or more sends (pre-send text-only +
 * main payload).  Every entry goes through `buildReplyEnqueuePlan` → the same
 * text/media dispatch.  There is no separate pre-send or main-send branch.
 */
function dispatchNormalizedSends(
  params: EnqueueNormalizedReplyPayloadParams,
  helpers: {
    enqueueReplyMediaEntries: (params: ReplyMediaEntriesParams) => void;
    enqueueReplyTextEntry: (params: {
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      payload: NormalizedReplyPayload;
    }) => void;
  },
): void {
  for (const entry of buildNormalizedSends(params.payload)) {
    // Build a NormalizedReplyPayload from the plan entry.
    const sendPayload: NormalizedReplyPayload = {
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
      replyTargetPolicy: params.payload.replyTargetPolicy,
    };

    const plan = buildReplyEnqueuePlan(sendPayload);

    if (plan.kind === 'text-and-media') {
      helpers.enqueueReplyTextEntry({
        accountId: params.accountId,
        sessionKey: params.sessionKey,
        route: params.route,
        payload: sendPayload,
      });
      helpers.enqueueReplyMediaEntries({
        accountId: params.accountId,
        sessionKey: params.sessionKey,
        route: params.route,
        payload: withoutReplyMediaText(sendPayload),
        mediaLocalRoots: params.mediaLocalRoots,
      });
      continue;
    }

    if (plan.kind !== 'text-only') {
      helpers.enqueueReplyMediaEntries({
        accountId: params.accountId,
        sessionKey: params.sessionKey,
        route: params.route,
        payload: sendPayload,
        mediaLocalRoots: params.mediaLocalRoots,
      });
      continue;
    }

    helpers.enqueueReplyTextEntry({
      accountId: params.accountId,
      sessionKey: params.sessionKey,
      route: params.route,
      payload: sendPayload,
    });
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
    enqueueReplyMediaEntries: (params: ReplyMediaEntriesParams) => void;
    enqueueReplyTextEntry: (params: {
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      payload: NormalizedReplyPayload;
    }) => void;
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
  dispatchNormalizedSends(params, helpers);
}

export function normalizeReplyPayload(
  payload: ReplyPayloadInput,
  helpers: { asString: (value: unknown, fallback?: string) => string },
  options?: { replyTargetPolicy?: OutboundReplyTargetPolicy },
): NormalizedReplyPayload {
  const normalized = normalizeOutboundSend({
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
