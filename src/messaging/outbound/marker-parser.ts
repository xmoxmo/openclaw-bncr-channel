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
 * - When path/paths/mediaUrl/mediaUrls are present, probe for reachability.
 *   Unreachable single paths keep the marker visible in the output text.
 *   Unreachable entries in path arrays are dropped with warnings logged.
 */

import fs from 'node:fs';

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

// ---------------------------------------------------------------------------
// Media path probing
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 5_000;
const MEDIA_PATH_KEYS = new Set(['path', 'paths', 'mediaUrl', 'mediaUrls']);

function hasMediaPathParams(params: Record<string, unknown>): boolean {
  for (const key of MEDIA_PATH_KEYS) {
    if (key in params) return true;
  }
  return false;
}

/**
 * Check whether a single media path (HTTP URL or local file) is reachable.
 *
 * - HTTP/HTTPS URLs → HEAD request with short timeout (5 s), follows redirects.
 * - Local files → fs.existsSync.
 *
 * Returns `{ ok, reason }` where `reason` describes the failure when `ok` is false.
 */
async function probeMediaPath(raw: string): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const path = String(raw || '').trim();
  if (!path) return { ok: false, reason: 'empty path' };

  // HTTP(S) URL — HEAD probe
  if (path.startsWith('http://') || path.startsWith('https://')) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      const response = await fetch(path, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (response.ok || response.status === 206) return { ok: true };
      // HEAD failed — try Range GET (first 4 bytes) as fallback.
      // Some CDNs / object stores reject HEAD but serve GET with Range.
      const probeReason = `HEAD ${response.status}`;
      try {
        const controller2 = new AbortController();
        const timer2 = setTimeout(() => controller2.abort(), PROBE_TIMEOUT_MS);
        const rangeResp = await fetch(path, {
          method: 'GET',
          headers: { Range: 'bytes=0-3' },
          signal: controller2.signal,
          redirect: 'follow',
        });
        clearTimeout(timer2);
        if (rangeResp.status === 206 || rangeResp.ok) return { ok: true }; // 206=Range ok, other 2xx=server reachable
        return { ok: false, reason: `${probeReason}, Range GET ${rangeResp.status}` };
      } catch (err2: unknown) {
        const reason2 = err2 instanceof Error ? err2.message : String(err2);
        return { ok: false, reason: `${probeReason}, Range GET error: ${reason2}` };
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      // fetch-level error (DNS / timeout) — don't attempt fallback
      return { ok: false, reason };
    }
  }

  // Local file
  try {
    if (fs.existsSync(path)) return { ok: true };
    return { ok: false, reason: 'file not found' };
  } catch {
    return { ok: false, reason: 'unreadable path' };
  }
}

/**
 * After JSON marker parsing, probe any media paths found in the params.
 *
 * - Single path (`path` / `mediaUrl`): if unreachable, keeps the marker in text
 *   (returns allValid=false, warnings populated).
 * - Path arrays (`paths` / `mediaUrls`): unreachable entries are removed; if at
 *   least one entry is valid the marker is still stripped.  If ALL entries are
 *   invalid the marker is kept.
 *
 * Returns `{ params, warnings, allValid }`:
 * - `params` — (potentially filtered) params with invalid array entries removed.
 * - `warnings` — human-readable warning strings for each unreachable path.
 * - `allValid` — false when a single path or all array entries are unreachable.
 */
async function probeAndResolveMarkerPaths(params: Record<string, unknown>): Promise<{
  params: Record<string, unknown>;
  warnings: string[];
  allValid: boolean;
}> {
  const warnings: string[] = [];
  if (!hasMediaPathParams(params)) return { params, warnings, allValid: true };

  // Single path / mediaUrl
  const singlePath = String(params.path ?? params.mediaUrl ?? '').trim();
  if (singlePath) {
    const result = await probeMediaPath(singlePath);
    if (!result.ok) {
      warnings.push(`path ${singlePath} unreachable: ${result.reason}`);
      return { params, warnings, allValid: false };
    }
    // Path confirmed reachable — signal downstream that media is validated
    // Only set ismedia:true when user hasn't explicitly opted out.
    if (!('ismedia' in params && params.ismedia === false)) {
      params = { ...params, ismedia: true };
    }
    return { params, warnings, allValid: true };
  }

  // Path arrays — paths / mediaUrls
  const arraySource = (params.paths ?? params.mediaUrls) as unknown;
  if (Array.isArray(arraySource) && arraySource.length > 0) {
    const entries = arraySource.filter(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    if (entries.length === 0) return { params, warnings, allValid: true };

    const results = await Promise.all(entries.map((p) => probeMediaPath(p)));
    const valid: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (results[i].ok) {
        valid.push(entries[i]);
      } else {
        warnings.push(`path ${entries[i]} unreachable: ${results[i].reason}`);
      }
    }

    if (valid.length === 0) {
      // All invalid → keep marker
      return { params, warnings, allValid: false };
    }
    // At least one valid → strip marker, replace with filtered entries.
    // Only set ismedia=true when user hasn't explicitly opted out.
    const setMedia = !('ismedia' in params && params.ismedia === false);
    params = { ...params, ...(setMedia ? { ismedia: true } : {}), paths: valid, mediaUrls: valid };
  }

  return { params, warnings, allValid: true };
}

/**
 * Parse text markers AND probe media paths in one async step.
 *
/**
 * Unified marker strip decision: the single place that decides whether to strip
 * a [BncrParam:...] marker from the text or leave it in place.
 *
 * - Markers that JSON parse successfully AND whose media paths (if any) are
 *   reachable → stripped from text, params extracted and merged.
 * - Markers whose paths are unreachable (single path OR all array entries) →
 *   kept in text, NOT stripped, NOT extracted.
 * - Markers without path fields → stripped as normal (existing behavior).
 * - Markers that fail JSON parse → kept in text (existing behavior).
 * - Multiple markers → each evaluated independently, later markers' params
 *   overwrite earlier ones when the same key appears.
 *
 * This function IS the single decision point.  Downstream consumers of the
 * returned text never re-parse markers — they trust the decision made here.
 */
export async function resolveMarkerStripDecision(text: string): Promise<{
  cleanText: string;
  params: Record<string, unknown>;
  warnings: string[];
}> {
  const params: Record<string, unknown> = {};
  const warnings: string[] = [];
  let result = text;
  let searchFrom = 0;
  const hadMarkers = text.includes(PREFIX);

  if (!hadMarkers) return { cleanText: text, params, warnings };

  while (true) {
    const idx = result.indexOf(PREFIX, searchFrom);
    if (idx === -1) break;

    const end = findMarkerEnd(result, idx);
    if (end === -1) {
      searchFrom = idx + PREFIX.length;
      continue;
    }

    const rawJson = result.slice(idx + PREFIX.length, end);
    let parsed: Record<string, unknown> | null = null;
    try {
      const obj = JSON.parse(rawJson);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        parsed = obj as Record<string, unknown>;
      }
    } catch {
      // JSON parse failed → keep marker in text, continue scanning after it
      searchFrom = end + 1;
      continue;
    }

    // JSON parsed but is not a plain object → keep marker in text
    if (!parsed) {
      searchFrom = end + 1;
      continue;
    }

    // Marker has path fields → probe before deciding to strip
    if (hasMediaPathParams(parsed)) {
      const probeResult = await probeAndResolveMarkerPaths(parsed);
      if (probeResult.warnings.length > 0) warnings.push(...probeResult.warnings);
      if (!probeResult.allValid) {
        // Path(s) unreachable → keep marker in text, do NOT extract any params
        searchFrom = end + 1;
        continue;
      }
      // Paths valid → strip, merge params (probeResult.params includes ismedia:true + filtered arrays)
      Object.assign(params, probeResult.params);
    } else {
      // No path fields → strip marker and merge params unconditionally
      Object.assign(params, parsed);
    }
    result = result.slice(0, idx) + result.slice(end + 1);
    searchFrom = idx;
  }

  const cleanText = result !== text ? result.replace(/ {2,}/g, ' ').trim() : result;
  return { cleanText, params, warnings };
}
