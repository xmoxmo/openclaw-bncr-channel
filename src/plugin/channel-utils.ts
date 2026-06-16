import path from 'node:path';

export function now() {
  return Date.now();
}

export function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

export function finiteNumberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function finiteNonNegativeNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function clampFiniteNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value);
  const finite = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(finite, max));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function backoffMs(retryCount: number): number {
  return Math.max(1_000, 1_000 * 2 ** Math.max(0, retryCount - 1));
}

function fileExtFromMime(mimeType?: string): string {
  const mt = asString(mimeType || '').toLowerCase();
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
  };
  return map[mt] || '';
}

function sanitizeFileName(rawName?: string, fallback = 'file.bin'): string {
  const name = asString(rawName || '').trim();
  const base = name || fallback;
  const cleaned = Array.from(base, (ch) => {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f) return '_';
    if ('\\/:*?"<>|'.includes(ch)) return '_';
    return ch;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function buildTimestampFileName(mimeType?: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const ext = fileExtFromMime(mimeType) || '.bin';
  return `bncr_${ts}_${Math.random().toString(16).slice(2, 8)}${ext}`;
}

export function resolveOutboundFileName(params: {
  mediaUrl?: string;
  fileName?: string;
  mimeType?: string;
}): string {
  const mediaUrl = asString(params.mediaUrl || '').trim();
  const mimeType = asString(params.mimeType || '').trim();

  if (/^https?:\/\//i.test(mediaUrl)) {
    return buildTimestampFileName(mimeType);
  }

  const candidate = sanitizeFileName(params.fileName, 'file.bin');
  if (candidate.length <= 80) return candidate;

  const ext = path.extname(candidate);
  const stem = candidate.slice(0, Math.max(1, 80 - ext.length));
  return `${stem}${ext}`;
}
