import { summarizeBncrTextPreview } from './logging.ts';
import { formatDisplayScope } from './targets.ts';
import type {
  BncrDeadLetterDiagnosticsSummary,
  BncrDeadLetterEntrySummary,
  OutboxEntry,
} from './types.ts';
import { asString } from './value-sanitize.ts';

export type DeadLetterTopReason = { reason: string; count: number };

export type BuildDeadLetterDiagnosticsOptions = {
  entries: OutboxEntry[];
  allAccountsTotal: number;
  sinceStart: number;
  cappedAt: number;
};

function asPayloadMessage(payload: OutboxEntry['payload']): {
  msg?: string;
  type?: string;
  [key: string]: unknown;
} {
  const raw = payload.message;
  return raw && typeof raw === 'object' ? (raw as { msg?: string; type?: string }) : {};
}

export function buildDeadLetterDiagnostics(options: BuildDeadLetterDiagnosticsOptions) {
  const reasonCounts = new Map<string, number>();
  let oldestAt: number | null = null;
  let newestAt: number | null = null;

  for (const entry of options.entries) {
    const reason = asString(entry.lastError || 'unknown').trim() || 'unknown';
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    const createdAt = Number(entry.createdAt);
    if (Number.isFinite(createdAt)) {
      oldestAt = oldestAt === null ? createdAt : Math.min(oldestAt, createdAt);
      newestAt = newestAt === null ? createdAt : Math.max(newestAt, createdAt);
    }
  }

  return {
    total: options.entries.length,
    allAccountsTotal: options.allAccountsTotal,
    sinceStart: options.sinceStart,
    cappedAt: options.cappedAt,
    oldestAt,
    newestAt,
    topReasons: Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count })),
  } satisfies BncrDeadLetterDiagnosticsSummary;
}

export function formatDeadLetterTopReasons(topReasons: DeadLetterTopReason[]): string {
  if (!topReasons.length) return '-';
  return topReasons.map((item) => `${item.reason}:${item.count}`).join(',');
}

export function parseDeadLetterLimit(raw: unknown, defaultValue: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.max(0, Math.min(100, Math.floor(n)));
}

export function parseDeadLetterOffset(raw: unknown, defaultValue: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.max(0, Math.floor(n));
}

export function parseDeadLetterOlderThan(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const normalized = typeof raw === 'string' ? raw.trim() : raw;
  if (normalized === '') return null;
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(normalized));
  return Number.isFinite(parsed) ? parsed : null;
}

export function summarizeDeadLetterEntry(entry: OutboxEntry) {
  const msg = asPayloadMessage(entry.payload) || {};
  const text = asString(msg.msg || '');
  return {
    messageId: entry.messageId,
    accountId: entry.accountId,
    sessionKey: entry.sessionKey,
    route: formatDisplayScope(entry.route),
    kind: asString(msg.type || 'message'),
    createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : null,
    retryCount: Number.isFinite(Number(entry.retryCount)) ? Number(entry.retryCount) : 0,
    lastError: entry.lastError || null,
    textPreview: summarizeBncrTextPreview(text, 24),
  } satisfies BncrDeadLetterEntrySummary;
}

export function filterDeadLetterEntries(args: {
  accountId: string;
  entries: OutboxEntry[];
  reason?: string | null;
  olderThan?: number | null;
}) {
  const normalizedAccountId = asString(args.accountId).trim().toLowerCase();
  const reason = asString(args.reason || '').trim();
  return args.entries.filter((entry) => {
    if (asString(entry.accountId).trim().toLowerCase() !== normalizedAccountId) return false;
    if (reason && entry.lastError !== reason) return false;
    if (typeof args.olderThan === 'number') {
      const createdAt = Number(entry.createdAt);
      if (!Number.isFinite(createdAt) || createdAt >= args.olderThan) return false;
    }
    return true;
  });
}
