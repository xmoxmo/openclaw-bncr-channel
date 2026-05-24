import type { BncrRoute, OutboxEntry } from '../../core/types.ts';
import { buildReplyMediaFallbackDebugInfo } from './diagnostics.ts';
import { normalizeOutboundReplyToId } from './reply-target-policy.ts';

export type ReplyPayloadInput = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  asVoice?: boolean;
  audioAsVoice?: boolean;
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
  kind?: 'tool' | 'block' | 'final';
  replyToId: string;
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
  kind?: 'tool' | 'block' | 'final';
  replyToId: string;
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
  fallback: { text: string; reason: string };
};

export function hasReplyMediaEntries(payload: NormalizedReplyPayload) {
  return payload.mediaList.length > 0;
}

export function buildReplyTextOutboxEntry(
  params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    text: string;
    kind?: 'tool' | 'block' | 'final';
    replyToId: string;
  },
  helpers: {
    buildTextOutboxEntry: (args: {
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      text: string;
      kind?: 'tool' | 'block' | 'final';
      replyToId?: string;
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
      },
      { buildTextOutboxEntry: helpers.buildTextOutboxEntry },
    ),
  );
}

export function enqueueReplyMediaFallbackTextEntry(
  params: ReplyMediaFallbackTextEntryParams,
  helpers: {
    logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
    enqueueOutbound: (entry: OutboxEntry) => void;
    buildTextOutboxEntry: (args: {
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      text: string;
      kind?: 'tool' | 'block' | 'final';
      replyToId?: string;
    }) => OutboxEntry;
  },
): void {
  helpers.logInfo(
    'outbound',
    `media-dedupe-hit ${JSON.stringify(buildReplyMediaFallbackDebugInfo(params))}`,
    { debugOnly: true },
  );
  helpers.enqueueOutbound(
    buildReplyTextOutboxEntry(
      {
        accountId: params.accountId,
        sessionKey: params.sessionKey,
        route: params.route,
        text: params.fallback.text,
        kind: params.kind,
        replyToId: params.replyToId,
      },
      { buildTextOutboxEntry: helpers.buildTextOutboxEntry },
    ),
  );
}

export function enqueueReplyMediaFileTransferEntry(
  params: ReplyMediaFileTransferParams,
  helpers: {
    enqueueOutbound: (entry: OutboxEntry) => void;
    buildFileTransferOutboxEntry: (args: {
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      mediaUrl: string;
      mediaLocalRoots?: readonly string[];
      text: string;
      asVoice: boolean;
      audioAsVoice: boolean;
      kind?: 'tool' | 'block' | 'final';
      replyToId?: string;
    }) => OutboxEntry;
    rememberRecentMediaSend: (args: {
      sessionKey: string;
      mediaUrl: string;
      text: string;
      replyToId: string;
      createdAt: number;
    }) => void;
  },
): void {
  helpers.enqueueOutbound(
    helpers.buildFileTransferOutboxEntry({
      accountId: params.accountId,
      sessionKey: params.sessionKey,
      route: params.route,
      mediaUrl: params.mediaUrl,
      mediaLocalRoots: params.mediaLocalRoots,
      text: params.text,
      asVoice: params.asVoice,
      audioAsVoice: params.audioAsVoice,
      kind: params.kind,
      replyToId: params.replyToId || undefined,
    }),
  );
  helpers.rememberRecentMediaSend({
    sessionKey: params.sessionKey,
    mediaUrl: params.mediaUrl,
    text: params.normalizedText,
    replyToId: params.replyToId,
    createdAt: params.createdAt,
  });
}

export function enqueueSingleReplyMediaEntry(
  params: EnqueueSingleReplyMediaEntryParams,
  helpers: {
    enqueueReplyMediaFallbackTextEntry: (params: ReplyMediaFallbackTextEntryParams) => void;
    enqueueReplyMediaFileTransferEntry: (params: ReplyMediaFileTransferParams) => void;
  },
): void {
  if (params.fallback !== null) {
    helpers.enqueueReplyMediaFallbackTextEntry({
      accountId: params.params.accountId,
      sessionKey: params.params.sessionKey,
      route: params.params.route,
      mediaUrl: params.mediaUrl,
      kind: params.params.payload.kind,
      replyToId: params.params.payload.replyToId,
      fallback: params.fallback,
    });
    return;
  }

  helpers.enqueueReplyMediaFileTransferEntry({
    accountId: params.params.accountId,
    sessionKey: params.params.sessionKey,
    route: params.params.route,
    mediaUrl: params.mediaUrl,
    mediaLocalRoots: params.params.mediaLocalRoots,
    text: params.text,
    normalizedText: params.normalizedText,
    asVoice: params.params.payload.asVoice,
    audioAsVoice: params.params.payload.audioAsVoice,
    kind: params.params.payload.kind,
    replyToId: params.params.payload.replyToId,
    createdAt: params.currentTime,
  });
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
    hasReplyMediaEntries: (payload: NormalizedReplyPayload) => boolean;
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

  if (helpers.hasReplyMediaEntries(params.payload)) {
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
): NormalizedReplyPayload {
  const text = helpers.asString(payload?.text || '').trim();
  const mediaUrl = helpers.asString(payload?.mediaUrl || '').trim();
  const mediaUrls = Array.isArray(payload?.mediaUrls)
    ? payload.mediaUrls.map((v) => helpers.asString(v || '').trim()).filter(Boolean)
    : undefined;
  return {
    text,
    mediaUrl,
    mediaUrls,
    mediaList: mediaUrls?.length ? mediaUrls : mediaUrl ? [mediaUrl] : [],
    asVoice: payload?.asVoice === true,
    audioAsVoice: payload?.audioAsVoice === true,
    kind: payload?.kind,
    replyToId: normalizeOutboundReplyToId({ kind: payload?.kind, replyToId: payload?.replyToId }),
  };
}
