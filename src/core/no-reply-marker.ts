/**
 * Detect the agent's explicit "no reply" marker in outbound text.
 *
 * Marker: `NO_REPLY FROM AGENT` (case-insensitive). The host treats a bare
 * `NO_REPLY` as an empty/invalid reply, so the agent uses this longer phrase to
 * signal "explicitly no reply"; the plugin recognises it and drops the message.
 *
 * A reply matches when, after trimming edge decoration (whitespace, quotes,
 * brackets, markdown emphasis, punctuation):
 *  - any whole line equals the marker, or
 *  - the whole reply starts with the marker followed by a boundary, or
 *  - the whole reply ends with the marker preceded by a boundary.
 * A marker embedded inside a middle line is ordinary text and must not match.
 */

const NO_REPLY_MARKER = 'NO_REPLY FROM AGENT';

/** Strip non-alphanumeric decoration from both edges of a line. */
const EDGE_NOISE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
/** Characters that continue a word/token (so a match here means "not a boundary"). */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Collapse runs of horizontal whitespace (incl. full-width spaces) to one space. */
function normalizeHorizontalWhitespace(value: string): string {
  return value.replace(/[^\S\r\n]+/gu, ' ').trim();
}

function stripEdgeNoise(value: string): string {
  return normalizeHorizontalWhitespace(value).replace(EDGE_NOISE, '');
}

/** Whole line is exactly the marker after removing edge decoration. */
function isStandaloneMarkerLine(line: string): boolean {
  return stripEdgeNoise(line).toUpperCase() === NO_REPLY_MARKER;
}

/** Value begins with the marker followed by a boundary (space, punctuation, end). */
function startsWithMarker(value: string): boolean {
  const head = normalizeHorizontalWhitespace(value)
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .toUpperCase();
  if (!head.startsWith(NO_REPLY_MARKER)) return false;
  const next = head.charAt(NO_REPLY_MARKER.length);
  return next === '' || !WORD_CHAR.test(next);
}

/** Value ends with the marker preceded by a boundary (space, punctuation, start). */
function endsWithMarker(value: string): boolean {
  const tail = normalizeHorizontalWhitespace(value)
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .toUpperCase();
  if (!tail.endsWith(NO_REPLY_MARKER)) return false;
  const before = tail.charAt(tail.length - NO_REPLY_MARKER.length - 1);
  return before === '' || !WORD_CHAR.test(before);
}

export function isNoReplyMarkerText(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;

  // Any line that is exactly the marker (first, middle, or last).
  if (lines.some(isStandaloneMarkerLine)) return true;

  // When not a standalone line, only the head and tail of the whole reply count.
  const whole = text.trim();
  if (startsWithMarker(whole)) return true;
  if (endsWithMarker(whole)) return true;

  return false;
}

/**
 * Decide whether an outbound text body should be dropped as the agent's
 * explicit no-reply marker. `extraMsg` is the alternate body carried through
 * extra.msg (host or marker param). A real alternate body keeps the send.
 */
export function isNoReplyDropText(
  text: string | null | undefined,
  extraMsg?: string | null | undefined,
): boolean {
  const body = typeof text === 'string' ? text.trim() : '';
  const extra = typeof extraMsg === 'string' ? extraMsg.trim() : '';
  if (body) {
    if (!isNoReplyMarkerText(body)) return false;
    return !extra || isNoReplyMarkerText(extra);
  }
  return Boolean(extra) && isNoReplyMarkerText(extra);
}
