import type { OutboxEntry } from './types.ts';

type OutboxSummaryMessage = { type?: unknown; msg?: unknown; mediaUrl?: unknown };

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

function summarizeOutboxType(msg: OutboxSummaryMessage, asString: (value: unknown) => string) {
  return asString(msg.type || '') || 'unknown';
}

function summarizeOutboxText(msg: OutboxSummaryMessage, asString: (value: unknown) => string) {
  const text = asString(msg.msg || '').trim();
  if (text) return text;
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
  const payload = args.entry.payload as { message?: OutboxSummaryMessage } | undefined;
  const msg = payload?.message || {};
  const type = summarizeOutboxType(msg, args.asString);
  const text = summarizeOutboxText(msg, args.asString);
  const preview = args.summarizeTextPreview(text);
  return [type, args.formatDisplayScope(args.entry.route), preview].join('|');
}
