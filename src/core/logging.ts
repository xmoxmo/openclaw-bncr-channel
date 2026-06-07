import { createHash } from 'node:crypto';
import path from 'node:path';

export type BncrLogLevel = 'info' | 'warn' | 'error';
export type BncrLogOptions = { debugOnly?: boolean };

const BNCR_PREFIX = '[bncr]';
const DEBUG_TEXT_PREVIEW_LIMIT = 24;
const DEBUG_HASH_LENGTH = 12;

const TEXT_PAYLOAD_KEYS = new Set([
  'caption',
  'fallbackText',
  'messageText',
  'msg',
  'rawText',
  'text',
]);
const MEDIA_PAYLOAD_KEYS = new Set(['mediaUrl', 'path']);
const MEDIA_LIST_PAYLOAD_KEYS = new Set(['mediaUrls', 'mediaList']);
const SENSITIVE_DEBUG_KEY_PATTERN =
  /(?:authorization|cookie|password|secret|token|api[-_]?key|access[-_]?key|refresh[-_]?key)/i;
const REDACTED_DEBUG_VALUE = '[redacted]';

type DebugGate = () => boolean;

type ConsoleMethod = 'log' | 'warn' | 'error';

function resolveConsoleMethod(level: BncrLogLevel): ConsoleMethod {
  switch (level) {
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'log';
  }
}

function emitConsole(method: ConsoleMethod, line: string) {
  if (method === 'warn') {
    console.warn(line);
    return;
  }
  if (method === 'error') {
    console.error(line);
    return;
  }
  console.log(line);
}

export function normalizeBncrLogLine(raw: string | undefined) {
  const text = String(raw || '').trim();
  if (!text) return BNCR_PREFIX;
  return text.startsWith(BNCR_PREFIX) ? text : `${BNCR_PREFIX} ${text}`;
}

export function formatBncrLogLine(scope: string | undefined, message: string | undefined) {
  const normalizedScope = String(scope || '').trim();
  const normalizedMessage = String(message || '').trim();
  const prefix = normalizedScope ? `${BNCR_PREFIX} ${normalizedScope}` : BNCR_PREFIX;
  return normalizedMessage ? `${prefix} ${normalizedMessage}` : prefix;
}

function shortHash(raw: string) {
  return createHash('sha256').update(raw).digest('hex').slice(0, DEBUG_HASH_LENGTH);
}

function summarizeDebugTextValue(raw: string) {
  const compact = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    preview: summarizeBncrTextPreview(compact, DEBUG_TEXT_PREVIEW_LIMIT),
    length: compact.length,
    sha256: shortHash(compact),
  };
}

function mediaUrlBasename(raw: string) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const decodedPath = decodeURIComponent(parsed.pathname || '');
    return path.basename(decodedPath) || parsed.hostname || '';
  } catch {
    return path.basename(value.split(/[?#]/, 1)[0] || value);
  }
}

function summarizeDebugMediaValue(raw: string) {
  const value = String(raw || '').trim();
  if (!value) return '';
  return {
    basename: mediaUrlBasename(value),
    scheme: /^[a-z][a-z0-9+.-]*:/i.exec(value)?.[0].slice(0, -1) || 'path',
    sha256: shortHash(value),
  };
}

function sanitizeDebugValue(key: string, value: unknown): unknown {
  if (SENSITIVE_DEBUG_KEY_PATTERN.test(key)) return REDACTED_DEBUG_VALUE;
  if (typeof value === 'string') {
    if (TEXT_PAYLOAD_KEYS.has(key)) return summarizeDebugTextValue(value);
    if (MEDIA_PAYLOAD_KEYS.has(key)) return summarizeDebugMediaValue(value);
    return value;
  }
  if (Array.isArray(value)) {
    if (MEDIA_LIST_PAYLOAD_KEYS.has(key))
      return value.map((item) => summarizeDebugMediaValue(String(item || '')));
    return value.map((item) => sanitizeDebugValue('', item));
  }
  if (value && typeof value === 'object')
    return sanitizeDebugPayload(value as Record<string, unknown>);
  return value;
}

export function sanitizeBncrDebugPayload(payload: Record<string, unknown>) {
  return sanitizeDebugPayload(payload);
}

function sanitizeDebugPayload(payload: Record<string, unknown>) {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    sanitized[key] = sanitizeDebugValue(key, value);
  }
  return sanitized;
}

export function buildBncrDebugJsonMessage(event: string, payload: Record<string, unknown>) {
  return `${event} ${JSON.stringify(sanitizeBncrDebugPayload(payload))}`;
}

export function summarizeBncrTextPreview(raw: string, limit = 8) {
  const compact = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return '-';
  const chars = Array.from(compact);
  return chars.length > limit ? `${chars.slice(0, Math.max(1, limit)).join('')}…` : compact;
}

export function emitBncrLog(
  level: BncrLogLevel,
  scope: string | undefined,
  message: string | undefined,
  options?: BncrLogOptions,
  isDebugEnabled?: DebugGate,
) {
  if (options?.debugOnly && !(isDebugEnabled?.() ?? false)) return;
  emitConsole(resolveConsoleMethod(level), formatBncrLogLine(scope, message));
}

export function emitBncrLogLine(
  level: BncrLogLevel,
  line: string | undefined,
  options?: BncrLogOptions,
  isDebugEnabled?: DebugGate,
) {
  if (options?.debugOnly && !(isDebugEnabled?.() ?? false)) return;
  emitConsole(resolveConsoleMethod(level), normalizeBncrLogLine(line));
}
