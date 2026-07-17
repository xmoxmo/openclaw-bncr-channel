/**
 * [BncrParam:JSON] marker parser.
 *
 * Extracts embedded JSON control parameters from agent text, removes the
 * marker from the visible message, and returns the parsed key-value pairs.
 *
 * Format: [BncrParam:{"key":"val","asVoice":true}]
 *
 * Incomplete markers (missing closing ]) are left in text unchanged.
 * Invalid JSON within a complete marker - marker is removed but no params.
 */

const PREFIX = '[BncrParam:';

export function parseBncrMarker(text: string): {
  cleanText: string;
  params: Record<string, unknown>;
} {
  const idx = text.indexOf(PREFIX);
  if (idx === -1) return { cleanText: text, params: {} };

  const start = idx + PREFIX.length;
  if (start >= text.length) return { cleanText: text, params: {} };

  // Scan character-by-character tracking brace/bracket depth so that
  // ] inside JSON values (e.g. CDATA content) is not mistaken for
  // the closing marker bracket.
  let depth = 0;
  let inString = false;
  let esc = false;
  let end = -1;
  let started = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\' && inString) {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (!started) {
        if (ch === '{' || ch === '[') {
          started = true;
          depth = 1;
        }
        continue;
      }

      if (ch === '{' || ch === '[') {
        depth++;
      } else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          // JSON content complete - expect ] to close the marker
          if (i + 1 < text.length && text[i + 1] === ']') {
            end = i + 1;
          }
          break;
        }
      }
    }
  }

  if (end === -1) return { cleanText: text, params: {} };

  const rawJson = text.slice(start, end);
  let params: Record<string, unknown> = {};

  try {
    const parsed = JSON.parse(rawJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      params = parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid JSON — remove marker but don't apply params
  }

  const cleanText = (text.slice(0, idx) + text.slice(end + 1)).replace(/ {2,}/g, ' ').trim();
  return { cleanText, params };
}

/**
 * Media types that the pipeline internally routes as media sends.
 * Only these types are consumed (stripped) from extra.
 * Non-media types like "appmsg" remain in extra for downstream passthrough.
 */
const MEDIA_CONSUMPTION_TYPES = new Set(['file', 'image', 'video', 'audio', 'voice']);

/**
 * Known fields that the bncr plugin unconditionally consumes during outbound
 * processing. These are stripped from extra at entry and set as independent
 * pipeline params.  `type` is NOT in this set — it is consumed conditionally
 * based on whether its value is a recognized media type.
 */
const CONSUMPTION_FIELDS_NO_TYPE = new Set([
  'asVoice',
  'audioAsVoice',
  'kind',
  'replyToId',
  'downloadMedia',
]);

const CONSUMPTION_FIELDS = new Set([...CONSUMPTION_FIELDS_NO_TYPE]);

export function extractConsumptionFields(extra: Record<string, unknown> | undefined): {
  consumed: Partial<{
    asVoice: boolean;
    audioAsVoice: boolean;
    type: string;
    kind: string;
    replyToId: string;
    downloadMedia: boolean;
  }>;
  remaining: Record<string, unknown>;
} {
  const consumed: Record<string, unknown> = {};
  const remaining: Record<string, unknown> = {};

  if (!extra) return { consumed: {}, remaining: {} };

  for (const [key, value] of Object.entries(extra)) {
    // type is only consumed when its value is a recognized media type
    // (file/image/video/audio/voice).  Non-media types like "appmsg"
    // stay in remaining for downstream passthrough.
    if (key === 'type' && typeof value === 'string') {
      if (MEDIA_CONSUMPTION_TYPES.has(value.trim().toLowerCase())) {
        consumed[key] = value;
      } else {
        remaining[key] = value;
      }
      continue;
    }
    if (CONSUMPTION_FIELDS.has(key)) {
      consumed[key] = value;
    } else {
      remaining[key] = value;
    }
  }

  return {
    consumed: consumed as Record<string, unknown>,
    remaining,
  };
}
