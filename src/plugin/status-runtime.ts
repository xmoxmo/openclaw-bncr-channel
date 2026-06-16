import path from 'node:path';
import { normalizeAccountId } from '../core/accounts.ts';
import { buildDownlinkHealth as buildDownlinkHealthFromRuntime } from '../core/downlink-health.ts';
import {
  buildAccountRuntimeSnapshot,
  buildIntegratedDiagnostics as buildIntegratedDiagnosticsFromRuntime,
  buildStatusHeadlineFromRuntime,
  buildStatusMetaFromRuntime,
} from '../core/status.ts';
import type {
  BncrAckObservability,
  BncrAckStrategy,
  BncrRuntimeLastSession,
  OutboxEntry,
} from '../core/types.ts';
import { buildBncrRuntimeFlags, buildBncrRuntimeStatusInput } from '../runtime/outbound-flags.ts';
import type { RuntimeStatusSnapshots } from '../runtime/status-snapshots.ts';
import { buildRuntimeStatusSnapshots } from '../runtime/status-snapshots.ts';

type RuntimeStatusInput = Parameters<typeof buildIntegratedDiagnosticsFromRuntime>[0];

export type BncrStatusRuntimeHelpers = {
  api: unknown;
  getPluginRoot: () => string | null;
  startedAt: number;
  debugVerbose: boolean;
  adaptiveAckTimeoutEnabled: boolean;
  defaultMessageAckTimeoutMs: number;
  fileAckTimeoutMs: number;
  maxAckTimeoutMs: number;
  now: () => number;
  resolveMessageAckTimeoutMs: (accountId?: string) => number;
  isOnline: (accountId: string) => boolean;
  outboxValues: () => Iterable<OutboxEntry>;
  deadLetterEntries: () => OutboxEntry[];
  sessionRouteValues: () => Iterable<{ accountId: string }>;
  countInvalidOutboxSessionKeys: (accountId: string) => number;
  countLegacyAccountResidue: (accountId: string) => number;
  connectEventsByAccount: Map<string, number>;
  inboundEventsByAccount: Map<string, number>;
  activityEventsByAccount: Map<string, number>;
  ackEventsByAccount: Map<string, number>;
  activeConnectionCount: (accountId: string) => number;
  lastSessionByAccount: Map<string, BncrRuntimeLastSession>;
  lastActivityByAccount: Map<string, number>;
  lastInboundByAccount: Map<string, number>;
  lastOutboundByAccount: Map<string, number>;
  buildRuntimeAckObservability: (accountId: string) => BncrAckObservability;
  buildRuntimeAckStrategy: (ackObservability: BncrAckObservability) => BncrAckStrategy;
  lastAckOkByAccount: Map<string, number>;
  lastAckTimeoutByAccount: Map<string, number>;
  getAckTimeoutCount: (accountId: string) => number;
  getAccountPendingOutboxEntries: (accountId: string) => OutboxEntry[];
  getAccountDeadLetterEntries: (accountId: string) => OutboxEntry[];
  connectionsValues: () => Iterable<{ lastSeenAt: number }>;
  connectTtlMs: number;
};

export function createBncrStatusRuntime(runtime: BncrStatusRuntimeHelpers) {
  const buildRuntimeFlags = (accountId?: string) =>
    buildBncrRuntimeFlags({
      api: runtime.api,
      accountId,
      resolveMessageAckTimeoutMs: (acc?: string) => runtime.resolveMessageAckTimeoutMs(acc),
      adaptiveAckTimeoutEnabled: runtime.adaptiveAckTimeoutEnabled,
      defaultMessageAckTimeoutMs: runtime.defaultMessageAckTimeoutMs,
      fileAckTimeoutMs: runtime.fileAckTimeoutMs,
      debugVerbose: runtime.debugVerbose,
    });

  const buildAccountQueueCounters = (accountId: string) => ({
    activeConnections: runtime.activeConnectionCount(accountId),
    pending: runtime.getAccountPendingOutboxEntries(accountId).length,
    deadLetter: runtime.getAccountDeadLetterEntries(accountId).length,
  });

  const buildRuntimeStatusCore = (accountId: string, snapshots: RuntimeStatusSnapshots) => {
    const acc = normalizeAccountId(accountId);
    const counters = buildAccountQueueCounters(acc);
    return {
      accountId: acc,
      connected: runtime.isOnline(acc),
      pending: counters.pending,
      deadLetter: counters.deadLetter,
      activeConnections: counters.activeConnections,
      connectEvents: snapshots.eventCounters?.connectEvents ?? 0,
      inboundEvents: snapshots.eventCounters?.inboundEvents ?? 0,
      activityEvents: snapshots.eventCounters?.activityEvents ?? 0,
      ackEvents: snapshots.eventCounters?.ackEvents ?? 0,
      lastSession: snapshots.activitySnapshot?.lastSession ?? null,
      lastActivityAt: snapshots.activitySnapshot?.lastActivityAt ?? null,
      lastInboundAt: snapshots.activitySnapshot?.lastInboundAt ?? null,
      lastOutboundAt: snapshots.activitySnapshot?.lastOutboundAt ?? null,
      sessionRoutesCount: snapshots.queueSnapshot?.sessionRoutesCount ?? 0,
      invalidOutboxSessionKeys: snapshots.queueSnapshot?.invalidOutboxSessionKeys ?? 0,
      legacyAccountResidue: snapshots.queueSnapshot?.legacyAccountResidue ?? 0,
    };
  };

  const buildRuntimeStatusInput = (
    accountId: string,
    overrides: {
      running?: boolean;
      invalidOutboxSessionKeys?: number;
      legacyAccountResidue?: number;
    } = {},
  ): RuntimeStatusInput => {
    const acc = normalizeAccountId(accountId);
    const snapshots: RuntimeStatusSnapshots = buildRuntimeStatusSnapshots({
      accountId: acc,
      outboxEntries: runtime.outboxValues(),
      deadLetterEntries: runtime.deadLetterEntries(),
      sessionRouteEntries: runtime.sessionRouteValues(),
      countInvalidOutboxSessionKeys: (snapshotAccountId) =>
        normalizeAccountId(snapshotAccountId) === acc &&
        typeof overrides.invalidOutboxSessionKeys === 'number'
          ? overrides.invalidOutboxSessionKeys
          : runtime.countInvalidOutboxSessionKeys(snapshotAccountId),
      countLegacyAccountResidue: (snapshotAccountId) =>
        normalizeAccountId(snapshotAccountId) === acc &&
        typeof overrides.legacyAccountResidue === 'number'
          ? overrides.legacyAccountResidue
          : runtime.countLegacyAccountResidue(snapshotAccountId),
      connectEventsByAccount: runtime.connectEventsByAccount,
      inboundEventsByAccount: runtime.inboundEventsByAccount,
      activityEventsByAccount: runtime.activityEventsByAccount,
      ackEventsByAccount: runtime.ackEventsByAccount,
      activeConnectionCount: (snapshotAccountId) =>
        runtime.activeConnectionCount(snapshotAccountId),
      lastSessionByAccount: runtime.lastSessionByAccount,
      lastActivityByAccount: runtime.lastActivityByAccount,
      lastInboundByAccount: runtime.lastInboundByAccount,
      lastOutboundByAccount: runtime.lastOutboundByAccount,
    });
    const core = buildRuntimeStatusCore(acc, snapshots);
    const base = buildBncrRuntimeStatusInput({
      accountId: core.accountId,
      connected: core.connected,
      ...snapshots,
      startedAt: runtime.startedAt || runtime.now(),
      running: overrides.running,
      channelRoot: runtime.getPluginRoot() || path.join(process.cwd(), 'plugins', 'bncr'),
    });
    return {
      ...core,
      startedAt: Number(base.startedAt || runtime.startedAt || runtime.now()),
      running: base.running,
      channelRoot: base.channelRoot,
    };
  };

  const buildIntegratedDiagnostics = (
    accountId: string,
    runtimeStatusInput?: RuntimeStatusInput,
  ) => {
    const ackObservability = runtime.buildRuntimeAckObservability(accountId);
    const ackStrategy = runtime.buildRuntimeAckStrategy(ackObservability);
    return {
      ...buildIntegratedDiagnosticsFromRuntime(
        runtimeStatusInput || buildRuntimeStatusInput(accountId),
      ),
      ackObservability,
      ackStrategy,
    };
  };

  const buildDownlinkHealth = (accountId: string) => {
    const acc = normalizeAccountId(accountId);
    return buildDownlinkHealthFromRuntime({
      accountId: acc,
      now: runtime.now(),
      outboxEntries: runtime.outboxValues(),
      lastAckOkAt: runtime.lastAckOkByAccount.get(acc) || null,
      lastAckTimeoutAt: runtime.lastAckTimeoutByAccount.get(acc) || null,
      recentAckTimeoutCount: runtime.getAckTimeoutCount(acc),
      activeConnectionCount: runtime.activeConnectionCount(acc),
      lastInboundAt: runtime.lastInboundByAccount.get(acc) || null,
      lastActivityAt: runtime.lastActivityByAccount.get(acc) || null,
      onlineByConn: runtime.isOnline(acc),
    });
  };

  const buildStatusMeta = (accountId: string) =>
    buildStatusMetaFromRuntime(buildRuntimeStatusInput(accountId));

  const getAccountRuntimeSnapshot = (
    accountId: string,
    runtimeStatusInput = buildRuntimeStatusInput(accountId, { running: true }),
  ) => {
    const snapshot = buildAccountRuntimeSnapshot(runtimeStatusInput);
    const ackObservability = runtime.buildRuntimeAckObservability(accountId);
    const ackStrategy = runtime.buildRuntimeAckStrategy(ackObservability);
    return {
      ...snapshot,
      ackObservability,
      ackStrategy,
      diagnostics: {
        ...(snapshot.diagnostics || {}),
        ackObservability,
        ackStrategy,
      },
      meta: {
        ...(snapshot.meta || {}),
        ackObservability,
        ackStrategy,
        diagnostics: {
          ...(snapshot.meta?.diagnostics || {}),
          ackObservability,
          ackStrategy,
        },
      },
    };
  };

  const buildStatusHeadline = (accountId: string) =>
    buildStatusHeadlineFromRuntime(buildRuntimeStatusInput(accountId));

  const getStatusHeadline = (accountId: string) => buildStatusHeadline(accountId);

  const getChannelSummary = (defaultAccountId: string) => {
    const accountId = normalizeAccountId(defaultAccountId);
    const runtimeSnapshot = getAccountRuntimeSnapshot(accountId);
    const headline = buildStatusHeadline(accountId);

    if (runtimeSnapshot.connected) {
      return { linked: true, self: { e164: headline } };
    }

    const currentTime = runtime.now();
    for (const connection of runtime.connectionsValues()) {
      if (currentTime - connection.lastSeenAt <= runtime.connectTtlMs) {
        return { linked: true, self: { e164: headline } };
      }
    }

    return { linked: false, self: { e164: headline } };
  };

  return {
    buildRuntimeFlags,
    buildAccountQueueCounters,
    buildRuntimeStatusInput,
    buildIntegratedDiagnostics,
    buildDownlinkHealth,
    buildStatusMeta,
    getAccountRuntimeSnapshot,
    buildStatusHeadline,
    getStatusHeadline,
    getChannelSummary,
  };
}
