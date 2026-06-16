import {
  buildMediaTextFallback,
  type MediaDedupeCacheEntry,
  normalizeMessageText,
  normalizeReplyToId,
} from '../messaging/outbound/media-dedupe.ts';

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

export function createBncrMediaDedupeRuntime(runtime: {
  now: () => number;
  recentMediaDedupeBySession: Map<string, Map<string, MediaDedupeCacheEntry>>;
}) {
  function pruneMediaDedupeCache(sessionKey: string, currentTime = runtime.now()) {
    const sessionCache = runtime.recentMediaDedupeBySession.get(sessionKey);
    if (!sessionCache) return;

    for (const [mediaUrl, entry] of sessionCache.entries()) {
      if (currentTime - entry.createdAt > 10_000) {
        sessionCache.delete(mediaUrl);
      }
    }

    if (sessionCache.size === 0) {
      runtime.recentMediaDedupeBySession.delete(sessionKey);
    }
  }

  function rememberRecentMediaSend(params: {
    sessionKey: string;
    mediaUrl: string;
    text: string;
    replyToId: string;
    createdAt?: number;
  }) {
    const sessionKey = asString(params.sessionKey || '').trim();
    const mediaUrl = asString(params.mediaUrl || '').trim();
    if (!sessionKey || !mediaUrl) return;

    const createdAt = typeof params.createdAt === 'number' ? params.createdAt : runtime.now();
    pruneMediaDedupeCache(sessionKey, createdAt);
    let sessionCache = runtime.recentMediaDedupeBySession.get(sessionKey);
    if (!sessionCache) {
      sessionCache = new Map<string, MediaDedupeCacheEntry>();
      runtime.recentMediaDedupeBySession.set(sessionKey, sessionCache);
    }
    sessionCache.set(mediaUrl, {
      mediaUrl,
      text: normalizeMessageText(params.text),
      replyToId: normalizeReplyToId(params.replyToId),
      createdAt,
    });
  }

  function tryBuildMediaDedupeFallback(params: {
    sessionKey: string;
    mediaUrl: string;
    text: string;
    replyToId: string;
    currentTime?: number;
  }): { text: string; reason: 'same-text-sent-checkmark' | 'text-changed-downgrade' } | null {
    const sessionKey = asString(params.sessionKey || '').trim();
    const mediaUrl = asString(params.mediaUrl || '').trim();
    if (!sessionKey || !mediaUrl) return null;

    const currentTime = typeof params.currentTime === 'number' ? params.currentTime : runtime.now();
    pruneMediaDedupeCache(sessionKey, currentTime);
    const sessionCache = runtime.recentMediaDedupeBySession.get(sessionKey);
    const previous = sessionCache?.get(mediaUrl);
    if (!previous) return null;
    if (currentTime - previous.createdAt > 10_000) return null;

    return buildMediaTextFallback({
      currentText: normalizeMessageText(params.text),
      previousText: previous.text,
      currentReplyToId: normalizeReplyToId(params.replyToId),
      previousReplyToId: previous.replyToId,
    });
  }

  return {
    pruneMediaDedupeCache,
    rememberRecentMediaSend,
    tryBuildMediaDedupeFallback,
  };
}
