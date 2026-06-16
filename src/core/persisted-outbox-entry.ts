import { normalizeAccountId } from './accounts.ts';
import { normalizeStoredSessionKey, parseRouteLike } from './targets.ts';
import type { OutboxEntry } from './types.ts';

type PersistedOutboxEntryInput = Partial<OutboxEntry> & {
  payload?: Record<string, unknown>;
};

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
  entry: PersistedOutboxEntryInput | null | undefined;
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
  const payload: Record<string, unknown> =
    entry.payload && typeof entry.payload === 'object' ? { ...entry.payload } : {};
  payload.sessionKey = normalized.sessionKey;
  payload.platform = route.platform;
  payload.groupId = route.groupId;
  payload.userId = route.userId;

  return {
    ...entry,
    messageId: asString(entry.messageId).trim(),
    accountId,
    sessionKey: normalized.sessionKey,
    route,
    payload,
    createdAt: finiteNumberOr(entry.createdAt, args.now()),
    retryCount: finiteNumberOr(entry.retryCount, 0),
    nextAttemptAt: finiteNumberOr(entry.nextAttemptAt, args.now()),
    lastAttemptAt: optionalFiniteNumber(entry.lastAttemptAt),
    lastError: entry.lastError ? asString(entry.lastError) : undefined,
    lastPushAt: optionalFiniteNumber(entry.lastPushAt),
    lastPushConnId: entry.lastPushConnId ? asString(entry.lastPushConnId) : undefined,
    lastPushClientId: entry.lastPushClientId ? asString(entry.lastPushClientId) : undefined,
    routeAttemptConnIds: Array.isArray(entry.routeAttemptConnIds)
      ? entry.routeAttemptConnIds.map((value) => asString(value)).filter(Boolean)
      : undefined,
    routeAttemptRound: optionalFiniteNumber(entry.routeAttemptRound),
    fastReroutePending: entry.fastReroutePending === true,
    awaitingRetryPush: entry.awaitingRetryPush === true,
  };
}
