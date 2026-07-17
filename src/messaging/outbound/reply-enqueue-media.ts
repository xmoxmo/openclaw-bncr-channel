import { buildBncrDebugJsonMessage } from '../../core/logging.ts';
import type { BncrRoute, OutboxEntry } from '../../core/types.ts';
import { buildReplyMediaFallbackDebugInfo } from './diagnostics.ts';
import type {
  EnqueueSingleReplyMediaEntryParams,
  NormalizedReplyPayload,
  ReplyMediaEntriesParams,
  ReplyMediaFallbackTextEntryParams,
  ReplyMediaFileTransferParams,
} from './reply-enqueue.ts';
import type { OutboundReplyTargetPolicy } from './reply-target-policy.ts';

export function enqueueReplyMediaFallbackTextEntry(
  params: ReplyMediaFallbackTextEntryParams,
  helpers: {
    logInfo: (
      scope: string | undefined,
      message: string,
      options?: { debugOnly?: boolean },
    ) => void;
    enqueueOutbound: (entry: OutboxEntry) => void;
    buildTextOutboxEntry: (args: {
      accountId: string;
      sessionKey: string;
      route: BncrRoute;
      text: string;
      extra?: Record<string, unknown>;
      kind?: 'tool' | 'block' | 'final';
      replyToId?: string;
      replyTargetPolicy?: OutboundReplyTargetPolicy;
    }) => OutboxEntry;
  },
): void {
  helpers.logInfo(
    'outbound',
    buildBncrDebugJsonMessage('media-dedupe-hit', buildReplyMediaFallbackDebugInfo(params)),
    { debugOnly: true },
  );
  helpers.enqueueOutbound(
    helpers.buildTextOutboxEntry({
      accountId: params.accountId,
      sessionKey: params.sessionKey,
      route: params.route,
      text: params.fallback.text,
      kind: params.kind,
      replyToId: params.replyToId || undefined,
      replyTargetPolicy: params.replyTargetPolicy,
    }),
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
      downloadMedia?: boolean;
      type?: string;
      extra?: Record<string, unknown>;
      kind?: 'tool' | 'block' | 'final';
      replyToId?: string;
      replyTargetPolicy?: OutboundReplyTargetPolicy;
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
      downloadMedia: params.downloadMedia,
      type: params.type,
      extra: params.extra,
      kind: params.kind,
      replyToId: params.replyToId || undefined,
      replyTargetPolicy: params.replyTargetPolicy,
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
      replyTargetPolicy: params.params.payload.replyTargetPolicy,
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
    downloadMedia: params.params.payload.downloadMedia,
    type: params.params.payload.type,
    extra: params.params.payload.extra,
    kind: params.params.payload.kind,
    replyToId: params.params.payload.replyToId,
    replyTargetPolicy: params.params.payload.replyTargetPolicy,
    createdAt: params.currentTime,
  });
}

export function enqueueReplyMediaEntries(
  params: ReplyMediaEntriesParams,
  helpers: {
    now: () => number;
    normalizeMessageText: (text: string) => string;
    tryBuildMediaDedupeFallback: (args: {
      sessionKey: string;
      mediaUrl: string;
      text: string;
      replyToId: string;
      currentTime: number;
    }) => { text: string; reason: string } | null;
    enqueueSingleReplyMediaEntry: (params: EnqueueSingleReplyMediaEntryParams) => void;
  },
): void {
  const currentTime = helpers.now();
  const normalizedText = helpers.normalizeMessageText(params.payload.text);

  for (const mediaUrl of params.payload.mediaList) {
    const fallback = helpers.tryBuildMediaDedupeFallback({
      sessionKey: params.sessionKey,
      mediaUrl,
      text: normalizedText,
      replyToId: params.payload.replyToId,
      currentTime,
    });
    helpers.enqueueSingleReplyMediaEntry({
      params,
      mediaUrl,
      normalizedText,
      text: params.payload.text,
      fallback,
      currentTime,
    });
  }
}

export function hasReplyMediaEntries(payload: NormalizedReplyPayload) {
  return payload.mediaList.length > 0;
}
