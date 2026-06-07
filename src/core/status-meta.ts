import type { PendingAdmission } from './types.ts';

type RuntimeStatusMetaDisplayInput = {
  pendingAdmissions?: PendingAdmission[];
  lastSession?: { scope: string; updatedAt: number } | null;
  lastActivityAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
};

function now() {
  return Date.now();
}

function finiteNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatPendingAdmissionScope(route: unknown): string | null {
  if (!route || typeof route !== 'object') return null;
  const record = route as Record<string, unknown>;
  if (
    typeof record.platform !== 'string' ||
    typeof record.groupId !== 'string' ||
    typeof record.userId !== 'string'
  ) {
    return null;
  }
  return `${record.platform}:${record.groupId}:${record.userId}`;
}

function fmtAgo(ts?: number | null): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return '-';
  const diff = Math.max(0, now() - ts);
  if (diff < 1_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function buildRuntimeStatusMetaDisplay(input: RuntimeStatusMetaDisplayInput) {
  const lastSessionAt = finiteNumberOrNull(input.lastSession?.updatedAt);
  const lastActivityAt = finiteNumberOrNull(input.lastActivityAt);
  const lastInboundAt = finiteNumberOrNull(input.lastInboundAt);
  const lastOutboundAt = finiteNumberOrNull(input.lastOutboundAt);

  return {
    pendingAdmissionsCount: Array.isArray(input.pendingAdmissions)
      ? input.pendingAdmissions.length
      : 0,
    pendingAdmissions: Array.isArray(input.pendingAdmissions)
      ? input.pendingAdmissions.map((item) => ({
          clientId: item.clientId,
          scope: formatPendingAdmissionScope(item.route),
          scopes: Array.isArray(item.routes)
            ? item.routes
                .map((route) => formatPendingAdmissionScope(route))
                .filter((scope): scope is string => scope !== null)
            : [],
          firstSeenAt: item.firstSeenAt,
          lastSeenAt: item.lastSeenAt,
          attempts: item.attempts,
        }))
      : [],
    lastSessionScope: input.lastSession?.scope || null,
    lastSessionAt,
    lastSessionAgo: fmtAgo(lastSessionAt),
    lastActivityAt,
    lastActivityAgo: fmtAgo(lastActivityAt),
    lastInboundAt,
    lastInboundAgo: fmtAgo(lastInboundAt),
    lastOutboundAt,
    lastOutboundAgo: fmtAgo(lastOutboundAt),
  };
}
