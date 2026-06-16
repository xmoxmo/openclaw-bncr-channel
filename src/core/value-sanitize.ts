export function asSanitizedString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  return String(value);
}

export function finiteNumberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function finiteNumberOrNull(value: unknown): number | null {
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
