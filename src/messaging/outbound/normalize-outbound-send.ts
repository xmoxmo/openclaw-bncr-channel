/**
 * Unified outbound send normalization.
 *
 * All send entry points (tool action, channel.send, channel.message)
 * fold into one shape first, then branch media vs text.
 *
 * Priority for control fields: marker/text-block > host/params extra > direct params.
 * Marker-specified type is always preserved (in normalized.type or re-injected into extra
 * for text branch) and never silently downgraded.
 *
 * Marker path/paths are media evidence unless ismedia is explicitly false.
 */

import { asString, isPlainObject } from '../../core/value-sanitize.ts';
import { extractConsumptionFields, parseBncrMarker } from './marker-parser.ts';

const MEDIA_SOURCE_EXTRA_KEYS = ['path', 'paths', 'mediaUrl', 'mediaUrls'] as const;

export type UnifiedOutboundSendInput = {
  /** Primary text body (channel text / tool message). */
  text?: string;
  message?: string;
  caption?: string;
  mediaUrl?: string;
  media?: string;
  path?: string;
  filePath?: string;
  mediaUrls?: unknown;
  asVoice: boolean;
  audioAsVoice: boolean;
  downloadMedia?: boolean;
  type?: string;
  kind?: string;
  replyToId?: string;
  replyToMessageId?: string;
  extra?: Record<string, unknown>;
  forceDocument?: boolean;
  gifPlayback?: boolean;
  silent?: boolean;
};

export type NormalizedOutboundSend = {
  markerHasMsg?: boolean;
  text: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  asVoice: boolean;
  audioAsVoice: boolean;
  downloadMedia?: boolean;
  type?: string;
  hasMedia?: boolean;
  extra?: Record<string, unknown>;
  kind?: 'tool' | 'block' | 'final';
  replyToId?: string;
};

function asTrimmedStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function normalizeReplyKind(value: unknown): 'tool' | 'block' | 'final' | undefined {
  return value === 'tool' || value === 'block' || value === 'final' ? value : undefined;
}

/** Strip media-source keys so they cannot override resolved media frame fields. */
function stripMediaSourceFieldsFromExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const next: Record<string, unknown> = { ...extra };
  for (const key of MEDIA_SOURCE_EXTRA_KEYS) {
    delete next[key];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Build extra for the chosen branch.
 * - media: strip media-source keys (path already resolved into mediaUrl)
 * - text: re-inject consumed media type for adapter passthrough when present
 */
function buildBranchExtra(args: {
  hasMedia?: boolean;
  extra?: Record<string, unknown>;
  consumedType?: string;
}): Record<string, unknown> | undefined {
  if (args.hasMedia) {
    return stripMediaSourceFieldsFromExtra(args.extra);
  }
  const textExtra =
    args.consumedType && args.extra
      ? { ...args.extra, type: args.consumedType }
      : args.consumedType
        ? { type: args.consumedType }
        : args.extra
          ? { ...args.extra }
          : undefined;
  return textExtra && Object.keys(textExtra).length > 0 ? textExtra : undefined;
}

/**
 * Parse markers from one or more text fields and merge extras.
 * Marker params always override host/params extra and host control flags.
 */
export function mergeMarkerAndHostFields(args: {
  texts: string[];
  hostExtra?: Record<string, unknown>;
  forceDocument?: boolean;
  gifPlayback?: boolean;
  silent?: boolean;
}): {
  cleanTexts: string[];
  markerParams: Record<string, unknown>;
  consumed: Partial<{
    asVoice: boolean;
    audioAsVoice: boolean;
    type: string;
    kind: string;
    replyToId: string;
    downloadMedia: boolean;
    ismedia: boolean;
  }>;
  remaining: Record<string, unknown>;
  markerHasMsg: boolean;
} {
  const markerParams: Record<string, unknown> = {};
  const cleanTexts: string[] = [];

  for (const raw of args.texts) {
    const { cleanText, params } = parseBncrMarker(raw);
    cleanTexts.push(cleanText);
    Object.assign(markerParams, params);
  }

  const merged: Record<string, unknown> = {
    ...(isPlainObject(args.hostExtra) ? { ...args.hostExtra } : {}),
    ...markerParams,
  };
  if (args.forceDocument === true) merged.forceDocument = true;
  if (args.gifPlayback === true) merged.gifPlayback = true;
  if (args.silent === true) merged.silent = true;

  // Marker wins over host force* when marker also set them (already via Object.assign order)

  const { consumed, remaining } = extractConsumptionFields(
    Object.keys(merged).length > 0 ? merged : undefined,
  );

  return {
    cleanTexts,
    markerParams,
    consumed,
    remaining,
    markerHasMsg: typeof markerParams.msg === 'string',
  };
}

function resolveHostMediaUrl(input: UnifiedOutboundSendInput): string {
  return (
    (typeof input.media === 'string' ? input.media : '') ||
    (typeof input.path === 'string' ? input.path : '') ||
    (typeof input.filePath === 'string' ? input.filePath : '') ||
    (typeof input.mediaUrl === 'string' ? input.mediaUrl : '')
  );
}

/**
 * Resolve media sources after marker merge.
 * Host mediaUrl/mediaUrls first; marker path/paths next.
 * Marker path/paths are media evidence unless ismedia is explicitly false.
 */
function resolveDispatchMediaSources(args: {
  hostMediaUrl?: string;
  hostMediaUrls?: unknown;
  remainingExtra: Record<string, unknown>;
  consumedType?: string;
  /** Tri-state: true=force, false=skip (ismedia explicitly false), undefined=default (path is media evidence). */
  forceMedia?: boolean;
}): {
  mediaUrl?: string;
  mediaUrls?: string[];
  hasMedia?: boolean;
} {
  const hostMediaUrl = asString(args.hostMediaUrl || '').trim();
  const markerPath = asString(
    (args.remainingExtra.path as string) || (args.remainingExtra.mediaUrl as string) || '',
  ).trim();
  const markerPaths =
    asTrimmedStringList(args.remainingExtra.paths) ||
    asTrimmedStringList(args.remainingExtra.mediaUrls);
  const useMarkerPath = Boolean(markerPath) && args.forceMedia !== false;

  const singleFromHost = hostMediaUrl || undefined;
  const multiFromHost = asTrimmedStringList(args.hostMediaUrls);
  const mediaUrls = multiFromHost || markerPaths;
  let mediaUrl = singleFromHost || (useMarkerPath ? markerPath : undefined);

  // If mediaUrl is already in mediaUrls, drop single to avoid double-send.
  if (mediaUrl && mediaUrls?.includes(mediaUrl)) {
    mediaUrl = undefined;
  } else if (mediaUrl && mediaUrls?.length) {
    // Keep both: single + multi as mediaUrls list with single first
    const merged = [mediaUrl, ...mediaUrls.filter((u) => u !== mediaUrl)];
    return {
      mediaUrl: undefined,
      mediaUrls: merged,
      hasMedia: true,
    };
  }

  const hasMedia = Boolean(mediaUrl || mediaUrls?.length) || args.forceMedia === true;
  return {
    mediaUrl,
    mediaUrls,
    hasMedia,
  };
}

/**
 * Normalize any outbound send input into a single dispatch shape.
 * Callers only need to branch on `hasMedia` after this.
 */
export function normalizeOutboundSend(input: UnifiedOutboundSendInput): NormalizedOutboundSend {
  const rawText = asString(input.text ?? input.message ?? '', '');
  const rawCaption = asString(input.caption ?? '', '');
  // Prefer text/message; also parse caption so marker in either field works.
  const textsToParse = rawCaption && rawCaption !== rawText ? [rawText, rawCaption] : [rawText];

  const { cleanTexts, consumed, remaining, markerHasMsg } = mergeMarkerAndHostFields({
    texts: textsToParse,
    hostExtra: isPlainObject(input.extra) ? input.extra : undefined,
    forceDocument: input.forceDocument,
    gifPlayback: input.gifPlayback,
    silent: input.silent,
  });

  const cleanText = cleanTexts[0] || '';
  const cleanCaption = cleanTexts.length > 1 ? cleanTexts[1] || '' : '';

  const forceMedia = consumed.ismedia;
  const consumedType = typeof consumed.type === 'string' ? consumed.type : undefined;
  const hostType = asString(input.type || '').trim() || undefined;

  const media = resolveDispatchMediaSources({
    hostMediaUrl: resolveHostMediaUrl(input),
    hostMediaUrls: input.mediaUrls,
    remainingExtra: remaining,
    consumedType,
    forceMedia,
  });

  const asVoice = typeof consumed.asVoice === 'boolean' ? consumed.asVoice : input.asVoice === true;
  const audioAsVoice =
    typeof consumed.audioAsVoice === 'boolean'
      ? consumed.audioAsVoice
      : input.audioAsVoice === true;
  // Tri-state: marker boolean wins; otherwise host value; else undefined (scene cascade).
  const downloadMedia =
    typeof consumed.downloadMedia === 'boolean' ? consumed.downloadMedia : input.downloadMedia;
  const type = consumedType ?? hostType;

  // For media sends: text becomes caption (prefer caption field when both exist).
  // For text sends: prefer message/text, fall back to caption.
  const body = media.hasMedia ? cleanCaption || cleanText : cleanText || cleanCaption;

  const kind = normalizeReplyKind(consumed.kind) ?? normalizeReplyKind(input.kind) ?? undefined;
  const replyToId =
    asString(consumed.replyToId || input.replyToId || input.replyToMessageId || '').trim() ||
    undefined;

  const extra = buildBranchExtra({
    hasMedia: media.hasMedia,
    extra: Object.keys(remaining).length > 0 ? remaining : undefined,
    consumedType,
  });

  return {
    text: body,
    markerHasMsg,
    mediaUrl: media.mediaUrl,
    mediaUrls: media.mediaUrls,
    asVoice,
    audioAsVoice,
    ...(downloadMedia !== undefined ? { downloadMedia } : {}),
    ...(type ? { type } : {}),
    hasMedia: media.hasMedia,
    ...(extra ? { extra } : {}),
    ...(kind ? { kind } : {}),
    ...(replyToId ? { replyToId } : {}),
  };
}

/**
 * Given an already-normalized output, produce the full list of sends.
 *
 * When the marker supplies a `msg` field that will override the clean text
 * body (non-empty `text` different from `extra.msg`), the list includes
 * the clean text as a standalone text-only entry first, followed by the
 * main payload.  Otherwise the list contains just the single entry.
 */
export function buildNormalizedSends(normalized: NormalizedOutboundSend): NormalizedOutboundSend[] {
  if (
    normalized.markerHasMsg &&
    normalized.text &&
    typeof normalized.extra?.msg === 'string' &&
    normalized.extra.msg !== normalized.text
  ) {
    return [
      // Pre-send: clean text only, no media, no extra
      {
        text: normalized.text,
        markerHasMsg: true,
        hasMedia: false,
        asVoice: false,
        audioAsVoice: false,
        kind: normalized.kind,
        replyToId: normalized.replyToId,
      },
      // Main send: as-is (adapter uses extra.msg as body)
      normalized,
    ];
  }

  return [normalized];
}
