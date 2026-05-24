import fs from 'node:fs';
import path from 'node:path';
import type { BncrDiagnosticsSummary, PendingAdmission } from './types.ts';

type RuntimeStatusInput = {
  accountId: string;
  connected: boolean;
  pending: number;
  deadLetter: number;
  activeConnections: number;
  connectEvents: number;
  inboundEvents: number;
  activityEvents: number;
  ackEvents: number;
  startedAt: number;
  pendingAdmissions?: PendingAdmission[];
  lastSession?: { sessionKey: string; scope: string; updatedAt: number } | null;
  lastActivityAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  sessionRoutesCount: number;
  invalidOutboxSessionKeys: number;
  legacyAccountResidue: number;
  running?: boolean;
  lastError?: string | null;
  channelRoot?: string;
};

function now() {
  return Date.now();
}

function finiteNumberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

export function buildIntegratedDiagnostics(input: RuntimeStatusInput): BncrDiagnosticsSummary {
  const root = input.channelRoot || path.join(process.cwd(), 'plugins', 'bncr');
  const pluginIndexExists = fs.existsSync(path.join(root, 'index.ts'));
  const pluginChannelExists = fs.existsSync(path.join(root, 'src', 'channel.ts'));

  return {
    health: {
      connected: input.connected,
      pending: input.pending,
      pendingAdmissions: Array.isArray(input.pendingAdmissions)
        ? input.pendingAdmissions.length
        : 0,
      deadLetter: input.deadLetter,
      activeConnections: input.activeConnections,
      connectEvents: input.connectEvents,
      inboundEvents: input.inboundEvents,
      activityEvents: input.activityEvents,
      ackEvents: input.ackEvents,
      uptimeSec: Math.floor((now() - input.startedAt) / 1000),
    },
    regression: {
      pluginFilesPresent: pluginIndexExists && pluginChannelExists,
      pluginIndexExists,
      pluginChannelExists,
      totalKnownRoutes: input.sessionRoutesCount,
      invalidOutboxSessionKeys: input.invalidOutboxSessionKeys,
      legacyAccountResidue: input.legacyAccountResidue,
      ok: input.invalidOutboxSessionKeys === 0 && input.legacyAccountResidue === 0,
    },
  };
}

export function buildStatusHeadlineFromRuntime(input: RuntimeStatusInput): string {
  const diag = buildIntegratedDiagnostics(input);
  const h = diag.health;
  const parts = [
    input.connected ? 'linked' : 'status',
    `p:${h.pending}`,
    `d:${h.deadLetter}`,
    `c:${h.activeConnections}`,
  ];
  return parts.join(' ');
}

export function buildStatusMetaFromRuntime(input: RuntimeStatusInput) {
  const diagnostics = buildIntegratedDiagnostics(input);
  return {
    pending: input.pending,
    pendingAdmissionsCount: Array.isArray(input.pendingAdmissions)
      ? input.pendingAdmissions.length
      : 0,
    pendingAdmissions: Array.isArray(input.pendingAdmissions)
      ? input.pendingAdmissions.map((item) => ({
          clientId: item.clientId,
          scope: item.route
            ? `${item.route.platform}:${item.route.groupId}:${item.route.userId}`
            : null,
          scopes: Array.isArray(item.routes)
            ? item.routes.map((route) => `${route.platform}:${route.groupId}:${route.userId}`)
            : [],
          firstSeenAt: item.firstSeenAt,
          lastSeenAt: item.lastSeenAt,
          attempts: item.attempts,
        }))
      : [],
    deadLetter: input.deadLetter,
    lastSessionScope: input.lastSession?.scope || null,
    lastSessionAt: input.lastSession?.updatedAt || null,
    lastSessionAgo: fmtAgo(input.lastSession?.updatedAt || null),
    lastActivityAt: input.lastActivityAt || null,
    lastActivityAgo: fmtAgo(input.lastActivityAt || null),
    lastInboundAt: input.lastInboundAt || null,
    lastInboundAgo: fmtAgo(input.lastInboundAt || null),
    lastOutboundAt: input.lastOutboundAt || null,
    lastOutboundAgo: fmtAgo(input.lastOutboundAt || null),
    diagnostics,
  };
}

export function buildAccountRuntimeSnapshot(input: RuntimeStatusInput) {
  const meta = buildStatusMetaFromRuntime(input);
  return {
    accountId: input.accountId,
    running: input.running ?? true,
    connected: input.connected,
    linked: input.connected,
    lastEventAt: input.lastActivityAt || null,
    lastInboundAt: input.lastInboundAt || null,
    lastOutboundAt: input.lastOutboundAt || null,
    mode: input.connected ? 'linked' : 'configured',
    lastError: input.lastError ?? null,
    pending: input.pending,
    deadLetter: input.deadLetter,
    lastSessionKey: input.lastSession?.sessionKey || null,
    lastSessionScope: input.lastSession?.scope || null,
    lastSessionAt: input.lastSession?.updatedAt || null,
    lastActivityAt: input.lastActivityAt || null,
    diagnostics: meta.diagnostics,
    meta,
  };
}

export function buildAccountStatusSnapshot(input: {
  account: { accountId: string; name?: string; enabled?: boolean };
  runtime: any;
  healthSummary: string;
  displayName: string;
}) {
  const rt = input.runtime || {};
  const meta = rt?.meta || {};

  const pending = finiteNumberOr(rt?.pending ?? meta.pending, 0);
  const deadLetter = finiteNumberOr(rt?.deadLetter ?? meta.deadLetter, 0);
  const lastSessionKey = rt?.lastSessionKey ?? meta.lastSessionKey ?? null;
  const lastSessionScope = rt?.lastSessionScope ?? meta.lastSessionScope ?? null;
  const lastSessionAt = rt?.lastSessionAt ?? meta.lastSessionAt ?? null;
  const lastSessionAgo = rt?.lastSessionAgo ?? meta.lastSessionAgo ?? '-';
  const lastActivityAt = rt?.lastActivityAt ?? meta.lastActivityAt ?? null;
  const lastActivityAgo = rt?.lastActivityAgo ?? meta.lastActivityAgo ?? '-';
  const lastInboundAt = rt?.lastInboundAt ?? meta.lastInboundAt ?? null;
  const lastInboundAgo = rt?.lastInboundAgo ?? meta.lastInboundAgo ?? '-';
  const lastOutboundAt = rt?.lastOutboundAt ?? meta.lastOutboundAt ?? null;
  const lastOutboundAgo = rt?.lastOutboundAgo ?? meta.lastOutboundAgo ?? '-';
  const diagnostics = rt?.diagnostics ?? meta.diagnostics ?? null;
  const normalizedMode = rt?.mode === 'linked' ? 'linked' : 'Status';

  return {
    accountId: input.account.accountId,
    name: input.displayName,
    enabled: input.account.enabled !== false,
    configured: true,
    linked: Boolean(rt?.connected),
    running: rt?.running ?? false,
    connected: rt?.connected ?? false,
    lastEventAt: rt?.lastEventAt ?? null,
    lastError: rt?.lastError ?? null,
    mode: normalizedMode,
    pending,
    deadLetter,
    healthSummary: input.healthSummary,
    lastSessionKey,
    lastSessionScope,
    lastSessionAt,
    lastSessionAgo,
    lastActivityAt,
    lastActivityAgo,
    lastInboundAt,
    lastInboundAgo,
    lastOutboundAt,
    lastOutboundAgo,
    diagnostics,
  };
}

export function buildChannelSummaryFromRuntime(input: RuntimeStatusInput) {
  const headline = buildStatusHeadlineFromRuntime(input);
  return {
    linked: input.connected,
    self: { e164: headline },
  };
}
