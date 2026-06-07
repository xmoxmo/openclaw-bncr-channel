import fs from 'node:fs';
import path from 'node:path';
import { buildRuntimeStatusMetaDisplay } from './status-meta.ts';
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

function nonNegativeFiniteNumberOr(value: unknown, fallback: number): number {
  return Math.max(0, finiteNumberOr(value, fallback));
}

export function buildIntegratedDiagnostics(input: RuntimeStatusInput): BncrDiagnosticsSummary {
  const root = input.channelRoot || path.join(process.cwd(), 'plugins', 'bncr');
  const pluginIndexExists = fs.existsSync(path.join(root, 'index.ts'));
  const pluginChannelExists = fs.existsSync(path.join(root, 'src', 'channel.ts'));
  const currentTime = now();
  const startedAt = finiteNumberOr(input.startedAt, currentTime);
  const pending = nonNegativeFiniteNumberOr(input.pending, 0);
  const deadLetter = nonNegativeFiniteNumberOr(input.deadLetter, 0);
  const activeConnections = nonNegativeFiniteNumberOr(input.activeConnections, 0);
  const connectEvents = nonNegativeFiniteNumberOr(input.connectEvents, 0);
  const inboundEvents = nonNegativeFiniteNumberOr(input.inboundEvents, 0);
  const activityEvents = nonNegativeFiniteNumberOr(input.activityEvents, 0);
  const ackEvents = nonNegativeFiniteNumberOr(input.ackEvents, 0);
  const sessionRoutesCount = nonNegativeFiniteNumberOr(input.sessionRoutesCount, 0);
  const invalidOutboxSessionKeys = nonNegativeFiniteNumberOr(input.invalidOutboxSessionKeys, 0);
  const legacyAccountResidue = nonNegativeFiniteNumberOr(input.legacyAccountResidue, 0);

  return {
    health: {
      connected: input.connected,
      pending,
      pendingAdmissions: Array.isArray(input.pendingAdmissions)
        ? input.pendingAdmissions.length
        : 0,
      deadLetter,
      activeConnections,
      connectEvents,
      inboundEvents,
      activityEvents,
      ackEvents,
      uptimeSec: Math.max(0, Math.floor((currentTime - startedAt) / 1000)),
    },
    regression: {
      pluginFilesPresent: pluginIndexExists && pluginChannelExists,
      pluginIndexExists,
      pluginChannelExists,
      totalKnownRoutes: sessionRoutesCount,
      invalidOutboxSessionKeys,
      legacyAccountResidue,
      ok: invalidOutboxSessionKeys === 0 && legacyAccountResidue === 0,
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
  const display = buildRuntimeStatusMetaDisplay(input);
  return {
    pending: diagnostics.health.pending,
    pendingAdmissionsCount: display.pendingAdmissionsCount,
    pendingAdmissions: display.pendingAdmissions,
    deadLetter: diagnostics.health.deadLetter,
    lastSessionScope: display.lastSessionScope,
    lastSessionAt: display.lastSessionAt,
    lastSessionAgo: display.lastSessionAgo,
    lastActivityAt: display.lastActivityAt,
    lastActivityAgo: display.lastActivityAgo,
    lastInboundAt: display.lastInboundAt,
    lastInboundAgo: display.lastInboundAgo,
    lastOutboundAt: display.lastOutboundAt,
    lastOutboundAgo: display.lastOutboundAgo,
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
    lastEventAt: meta.lastActivityAt,
    lastInboundAt: meta.lastInboundAt,
    lastOutboundAt: meta.lastOutboundAt,
    mode: input.connected ? 'linked' : 'configured',
    lastError: input.lastError ?? null,
    pending: meta.pending,
    deadLetter: meta.deadLetter,
    lastSessionKey: input.lastSession?.sessionKey || null,
    lastSessionScope: input.lastSession?.scope || null,
    lastSessionAt: meta.lastSessionAt,
    lastActivityAt: meta.lastActivityAt,
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

  const pending = nonNegativeFiniteNumberOr(rt?.pending ?? meta.pending, 0);
  const deadLetter = nonNegativeFiniteNumberOr(rt?.deadLetter ?? meta.deadLetter, 0);
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
