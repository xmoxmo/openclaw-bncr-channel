export type MediaDedupeCacheEntry = {
  mediaUrl: string;
  text: string;
  replyToId: string;
  createdAt: number;
};

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

export function normalizeReplyToId(value: unknown): string {
  return asString(value || '').trim();
}

export function normalizeMessageText(value: unknown): string {
  return asString(value || '').trim();
}

export function shouldTreatReplyToAsSame(
  currentReplyToId: string,
  previousReplyToId: string,
): boolean {
  if (!currentReplyToId || !previousReplyToId) return true;
  return currentReplyToId === previousReplyToId;
}

export function buildMediaTextFallback(params: {
  currentText: string;
  previousText: string;
  currentReplyToId: string;
  previousReplyToId: string;
}): { text: string; reason: 'same-text-sent-checkmark' | 'text-changed-downgrade' } | null {
  if (!shouldTreatReplyToAsSame(params.currentReplyToId, params.previousReplyToId)) {
    return null;
  }

  if (params.currentText && params.currentText !== params.previousText) {
    return {
      text: params.currentText,
      reason: 'text-changed-downgrade',
    };
  }

  return {
    text: '✅已发送',
    reason: 'same-text-sent-checkmark',
  };
}
