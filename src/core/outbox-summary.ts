import type { OutboxEntry } from './types.ts';

type OutboxSummaryMeta = {
  kind?: string;
  asVoice?: boolean;
  audioAsVoice?: boolean;
  type?: unknown;
  mediaUrl?: unknown;
  text?: unknown;
};

type OutboxSummaryMessage = {
  type?: unknown;
  msg?: unknown;
};

type OutboxSummaryPayload = {
  type?: unknown;
  message?: OutboxSummaryMessage;
  _meta?: OutboxSummaryMeta;
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

  const meta = payload?._meta || {};
  if (meta.kind === 'file-transfer') {
    if (meta.asVoice === true || meta.audioAsVoice === true) return 'voice';
    const hintedType = asString(meta.type || '').trim();
    if (hintedType) return hintedType;
    return inferMediaTypeFromUrl(asString(meta.mediaUrl || ''));
  }

  return asString(payload?.type || 'unknown');
}

function summarizeOutboxText(
  payload: OutboxSummaryPayload,
  msg: OutboxSummaryMessage,
  asString: (value: unknown) => string,
) {
  const text = asString(msg.msg || payload?._meta?.text || '').trim();
  if (text) return text;
  const meta = payload?._meta || {};
  if (meta.kind === 'file-transfer') return filenameFromUrl(asString(meta.mediaUrl || ''));
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
  const text = summarizeOutboxText(payload, msg, args.asString);
  const preview = args.summarizeTextPreview(text);
  return [type, args.formatDisplayScope(args.entry.route), preview].join('|');
}
