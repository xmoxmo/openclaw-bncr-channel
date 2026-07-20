/**
 * [BncrParam:JSON] marker parser.
 *
 * Extracts embedded JSON control parameters from agent text, removes the
 * marker from the visible message, and returns the parsed key-value pairs.
 *
 * Format: [BncrParam:{"key":"val","asVoice":true}]
 *
 * - Complete marker whose JSON parses successfully → stripped, params merged.
 * - Complete marker whose JSON fails to parse → left in text (not stripped)
 *   so the user can see and fix the bad payload.
 * - Incomplete marker (no closing ]) → left in text, does NOT block later
 *   complete markers.
 * - Multiple valid markers → all stripped, params merge (later same-key wins).
 */

const PREFIX = '[BncrParam:';

/**
 * Locate the closing `]` of a complete marker starting at `prefixIdx`.
 * Returns the index of the closing `]`, or -1 if incomplete.
 */
function findMarkerEnd(text: string, prefixIdx: number): number {
  const start = prefixIdx + PREFIX.length;
  if (start >= text.length) return -1;

  // Scan character-by-character tracking brace/bracket depth so that
  // ] inside JSON values (e.g. CDATA / lyric tags) is not mistaken for
  // the closing marker bracket.
  let depth = 0;
  let inString = false;
  let esc = false;
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
            return i + 1;
          }
          return -1;
        }
      }
    }
  }

  return -1;
}

export function parseBncrMarker(text: string): {
  cleanText: string;
  params: Record<string, unknown>;
} {
  const params: Record<string, unknown> = {};
  let result = text;
  let searchFrom = 0;

  while (true) {
    const idx = result.indexOf(PREFIX, searchFrom);
    if (idx === -1) break;

    const end = findMarkerEnd(result, idx);
    if (end === -1) {
      // Incomplete marker (missing ]): leave in place,
      // keep looking after this PREFIX so later valid markers are not blocked.
      searchFrom = idx + PREFIX.length;
      continue;
    }

    const rawJson = result.slice(idx + PREFIX.length, end);
    let parsedOk = false;
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(params, parsed as Record<string, unknown>);
        parsedOk = true;
      }
    } catch {
      // JSON parse failed — do NOT strip marker so the user can debug it
    }

    if (parsedOk) {
      // Strip the complete valid marker
      result = result.slice(0, idx) + result.slice(end + 1);
      searchFrom = idx;
    } else {
      // Leave the invalid marker in place, continue after it
      searchFrom = end + 1;
    }
  }

  // Only trim whitespace when markers were actually stripped (result changed).
  // Without markers the original text is returned as-is for maximum fidelity.
  const cleanText = result !== text ? result.replace(/ {2,}/g, ' ').trim() : result;
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
  'ismedia',
  'asVoice',
  'audioAsVoice',
  'kind',
  'replyToId',
  'downloadMedia',
]);

export function extractConsumptionFields(extra: Record<string, unknown> | undefined): {
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
    if (CONSUMPTION_FIELDS_NO_TYPE.has(key)) {
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
