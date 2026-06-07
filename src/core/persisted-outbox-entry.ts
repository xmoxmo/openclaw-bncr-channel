import { normalizeAccountId } from './accounts.ts';
import { normalizeStoredSessionKey, parseRouteLike } from './targets.ts';
import type { OutboxEntry } from './types.ts';

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

function finiteNumberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function normalizePersistedOutboxEntry(args: {
  entry: any;
  canonicalAgentId: string;
  now: () => number;
}): OutboxEntry | null {
  const { entry, canonicalAgentId } = args;
  if (!entry?.messageId) return null;
  const accountId = normalizeAccountId(entry.accountId);
  const sessionKey = asString(entry.sessionKey || '').trim();
  const normalized = normalizeStoredSessionKey(sessionKey, canonicalAgentId);
  if (!normalized) return null;

  const route = parseRouteLike(entry.route) || normalized.route;
  const payload = entry.payload && typeof entry.payload === 'object' ? { ...entry.payload } : {};
  (payload as any).sessionKey = normalized.sessionKey;
  (payload as any).platform = route.platform;
  (payload as any).groupId = route.groupId;
  (payload as any).userId = route.userId;

  return {
    ...entry,
    accountId,
    sessionKey: normalized.sessionKey,
    route,
    payload,
    createdAt: finiteNumberOr(entry.createdAt, args.now()),
    retryCount: finiteNumberOr(entry.retryCount, 0),
    nextAttemptAt: finiteNumberOr(entry.nextAttemptAt, args.now()),
    lastAttemptAt: optionalFiniteNumber(entry.lastAttemptAt),
    lastError: entry.lastError ? asString(entry.lastError) : undefined,
  };
}
