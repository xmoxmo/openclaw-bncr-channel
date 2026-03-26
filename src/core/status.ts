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
  const r = diag.regression;

  const parts = [
    r.ok ? 'diag:ok' : 'diag:warn',
    `p:${h.pending}`,
    `d:${h.deadLetter}`,
    `c:${h.activeConnections}`,
  ];

  if (!r.ok) {
    if (r.invalidOutboxSessionKeys > 0) parts.push(`invalid:${r.invalidOutboxSessionKeys}`);
    if (r.legacyAccountResidue > 0) parts.push(`legacy:${r.legacyAccountResidue}`);
  }

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
    meta: buildStatusMetaFromRuntime(input),
  };
}

export function buildChannelSummaryFromRuntime(input: RuntimeStatusInput) {
  const headline = buildStatusHeadlineFromRuntime(input);
  return {
    linked: input.connected,
    self: { e164: headline },
  };
}
