import type { OutboxEntry } from './types.ts';

type OutboxSummaryMessage = {
  type?: unknown;
  msg?: unknown;
  mediaUrl?: unknown;
  audioAsVoice?: boolean;
  asVoice?: boolean;
};

type OutboxSummaryPayload = {
  type?: unknown;
  message?: OutboxSummaryMessage;
};

function inferMediaTypeFromUrl(raw: string): 'image' | 'video' | 'audio' | 'file' {
  const clean = String(raw || '').split(/[?#]/, 1)[0] || '';
  const ext = clean.includes('.') ? clean.slice(clean.lastIndexOf('.') + 1).toLowerCase() : '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac'].includes(ext)) return 'audio';
  return 'file';
}

function filenameFromUrl(raw: string): string {
  const clean = String(raw || '').split(/[?#]/, 1)[0] || '';
  const name = clean.split(/[\\/]/).filter(Boolean).pop() || '';
  if (!name) return '';
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function summarizeOutboxType(
  payload: OutboxSummaryPayload,
  msg: OutboxSummaryMessage,
  asString: (value: unknown) => string,
) {
  const directType = asString(msg.type || '');
  if (directType) return directType;
  // Infer type from mediaUrl when no direct type is set
  const mediaUrl = asString(msg.mediaUrl || '');
  if (mediaUrl) {
    if (msg.audioAsVoice === true || msg.asVoice === true) return 'voice';
    const inferred = inferMediaTypeFromUrl(mediaUrl);
    if (inferred) return inferred;
  }
  return asString(payload?.type || 'unknown');
}

function summarizeOutboxText(msg: OutboxSummaryMessage, asString: (value: unknown) => string) {
  const text = asString(msg.msg || '').trim();
  if (text) return text;
  // Fall back to filename from mediaUrl when no caption is set
  const mediaUrl = asString(msg.mediaUrl || '');
  if (mediaUrl) return filenameFromUrl(mediaUrl);
  return '';
}

export function summarizeOutboxEntry(args: {
  entry: OutboxEntry;
  asString: (value: unknown) => string;
  formatDisplayScope: (route: OutboxEntry['route']) => string;
  summarizeTextPreview: (raw: string, limit?: number) => string;
}) {
  const payload = args.entry.payload as OutboxSummaryPayload;
  const msg = payload?.message || {};
  const type = summarizeOutboxType(payload, msg, args.asString);
  const text = summarizeOutboxText(msg, args.asString);
  const preview = args.summarizeTextPreview(text);
  return [type, args.formatDisplayScope(args.entry.route), preview].join('|');
}
