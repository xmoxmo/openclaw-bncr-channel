import type { BncrRoute, OutboxEntry } from '../../core/types.ts';
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
  type?: string;
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
  type?: string;
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
  type?: string;
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

export function shouldSplitReplyMediaText(payload: NormalizedReplyPayload) {
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

export function withoutReplyMediaText(payload: NormalizedReplyPayload): NormalizedReplyPayload {
  return {
    ...payload,
    text: '',
  };
}

export function buildReplyTextOutboxEntry(
  params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    text: string;
    kind?: 'tool' | 'block' | 'final';
    replyToId: string;
    replyTargetPolicy: OutboundReplyTargetPolicy;
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
    }) => OutboxEntry;
  },
): void {
  if (!params.payload.text) return;

  helpers.enqueueOutbound(
    buildReplyTextOutboxEntry(
      {
        accountId: params.accountId,
        sessionKey: params.sessionKey,
        route: params.route,
        text: params.payload.text,
        kind: params.payload.kind,
        replyToId: params.payload.replyToId,
        replyTargetPolicy: params.payload.replyTargetPolicy,
      },
      { buildTextOutboxEntry: helpers.buildTextOutboxEntry },
    ),
  );
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
  helpers.logEnqueueFromReply({
    accountId: params.accountId,
    sessionKey: params.sessionKey,
    route: params.route,
    payload: params.payload,
  });

  const plan = buildReplyEnqueuePlan(params.payload);

  if (plan.kind === 'text-and-media') {
    helpers.enqueueReplyTextEntry({
      accountId: params.accountId,
      sessionKey: params.sessionKey,
      route: params.route,
      payload: params.payload,
    });
    helpers.enqueueReplyMediaEntries({
      accountId: params.accountId,
      sessionKey: params.sessionKey,
      route: params.route,
      payload: withoutReplyMediaText(params.payload),
      mediaLocalRoots: params.mediaLocalRoots,
    });
    return;
  }

  if (plan.kind !== 'text-only') {
    helpers.enqueueReplyMediaEntries({
      accountId: params.accountId,
      sessionKey: params.sessionKey,
      route: params.route,
      payload: params.payload,
      mediaLocalRoots: params.mediaLocalRoots,
    });
    return;
  }

  helpers.enqueueReplyTextEntry({
    accountId: params.accountId,
    sessionKey: params.sessionKey,
    route: params.route,
    payload: params.payload,
  });
}

export function normalizeReplyPayload(
  payload: ReplyPayloadInput,
  helpers: { asString: (value: unknown, fallback?: string) => string },
  options?: { replyTargetPolicy?: OutboundReplyTargetPolicy },
): NormalizedReplyPayload {
  const text = helpers.asString(payload?.text || '').trim();
  const mediaUrl = helpers.asString(payload?.mediaUrl || '').trim();
  const mediaUrls = Array.isArray(payload?.mediaUrls)
    ? payload.mediaUrls.map((v) => helpers.asString(v || '').trim()).filter(Boolean)
    : undefined;
  const type = helpers.asString(payload?.type || '').trim();
  return {
    text,
    mediaUrl,
    mediaUrls,
    mediaList: mediaUrls?.length ? mediaUrls : mediaUrl ? [mediaUrl] : [],
    asVoice: payload?.asVoice === true,
    audioAsVoice: payload?.audioAsVoice === true,
    ...(type ? { type } : {}),
    ...(payload?.extra ? { extra: { ...payload.extra } } : {}),
    kind: payload?.kind,
    replyTargetPolicy: options?.replyTargetPolicy ?? 'agent-default',
    replyToId: normalizeOutboundReplyToId({
      kind: payload?.kind,
      replyToId: payload?.replyToId,
      replyTargetPolicy: options?.replyTargetPolicy,
    }),
  };
}
