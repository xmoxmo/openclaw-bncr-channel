export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  return String(value);
}

/** Alias: same as asString, named for call-sites that want a sanitization signal. */
export const asSanitizedString = asString;

export function finiteNumberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function now(): number {
  return Date.now();
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (!raw) return fallback;
    if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;
  }
  return fallback;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function finiteNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function nonNegativeFiniteNumberOr(value: unknown, fallback: number): number {
  return Math.max(0, finiteNumberOr(value, fallback));
}

export function clampFiniteNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const finite = finiteNumberOr(value, fallback);
  return Math.max(min, Math.min(finite, max));
}

export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((item) => asString(item).trim()).filter(Boolean);
  }
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}
