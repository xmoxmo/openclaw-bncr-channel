import {
  buildDeadLetterDiagnostics as buildDeadLetterDiagnosticsFromRuntime,
  filterDeadLetterEntries as filterDeadLetterEntriesFromRuntime,
} from '../core/dead-letter-diagnostics.ts';
import type {
  RegisterDriftSnapshot,
  RegisterTraceEntry,
  RegisterTraceSummary,
} from '../core/register-trace.ts';
import type { buildIntegratedDiagnostics as buildIntegratedDiagnosticsFromRuntime } from '../core/status.ts';
import type {
  BncrAckObservability,
  BncrConnection,
  BncrOutboxQueueDiagnostics,
  OutboxEntry,
} from '../core/types.ts';
import { buildBncrRuntimeAckObservability } from '../runtime/outbound-ack-timeout.ts';
import {
  buildBncrActiveConnectionDebugList,
  buildBncrDeadLetterSummaryMessage,
} from './runtime-diagnostics-payload-builders.ts';

type RuntimeStatusInput = Parameters<typeof buildIntegratedDiagnosticsFromRuntime>[0];
type IntegratedDiagnostics = ReturnType<typeof buildIntegratedDiagnosticsFromRuntime>;
type BncrConnectionDebugView = BncrConnection & {
  outboundReadyUntil?: number;
  preferredForOutboundUntil?: number;
  lastAckOkAt?: number;
  lastPushTimeoutAt?: number;
  pushFailureScore?: number;
};

export type ExtendedDiagnosticsAssemblerRuntime = {
  normalizeAccountId: (accountId: string) => string;
  buildIntegratedDiagnostics: (
    accountId: string,
    runtimeStatusInput?: RuntimeStatusInput,
  ) => IntegratedDiagnostics;
  buildOutboxDiagnostics: (accountId: string) => BncrOutboxQueueDiagnostics;
  buildRuntimeAckObservability: (accountId: string) => BncrAckObservability;
  getCounter: (map: Map<string, number>, accountId: string) => number;
  prePushGuardSkipCountByAccount: Map<string, number>;
  lastPrePushGuardSkipAtByAccount: Map<string, number>;
  lastPrePushGuardSkipReasonByAccount: Map<string, string>;
  hasGatewayContext: () => boolean;
  buildRuntimeSurfaceDiagnostics: () => ReturnType<
    typeof import('../openclaw/runtime-surface.ts')['buildOpenClawChannelRuntimeSurfaceDiagnostics']
  >;
  getRegisterRuntime: () => {
    bridgeId: string;
    gatewayPid: number;
    pluginVersion: string | null;
    pluginSource: string | null;
    lastApiInstanceId: string | null;
    lastRegistryFingerprint: string | null;
    registerCount: number;
    firstRegisterAt: number | null;
    lastRegisterAt: number | null;
    lastApiRebindAt: number | null;
    apiGeneration: number;
    registerTraceRecent: RegisterTraceEntry[];
    lastDriftSnapshot: RegisterDriftSnapshot | null;
  };
  buildRegisterTraceSummary: () => RegisterTraceSummary;
  activeConnectionCount: (accountId: string) => number;
  getConnectionRuntime: () => {
    lastGatewayContextAt: number | null;
    primaryLeaseId: string | null;
    connectionEpoch: number;
    acceptedConnections: number;
    lastConnectAt: number | null;
    lastDisconnectAt: number | null;
    lastActivityAtGlobal: number | null;
    lastInboundAtGlobal: number | null;
    lastAckAtGlobal: number | null;
    recentConnections: Map<
      string,
      { epoch: number; connectedAt: number; lastActivityAt: number | null; isPrimary: boolean }
    >;
  };
  getOutboundRuntime: () => {
    outboundEnqueueCountByAccount: Map<string, number>;
    lastOutboundEnqueueAtByAccount: Map<string, number>;
  };
  buildDeadLetterDiagnostics: (
    accountId: string,
  ) => ReturnType<typeof buildBncrDeadLetterDiagnosticsSnapshot>;
  bridgeVersion: number;
  staleCounters: {
    staleConnect: number;
    staleInbound: number;
    staleActivity: number;
    staleAck: number;
    staleFileInit: number;
    staleFileChunk: number;
    staleFileComplete: number;
    staleFileAbort: number;
    lastStaleAt: number | null;
  };
  now: () => number;
};

export type ExtendedDiagnosticsAssemblerOptions = {
  runtimeStatusInput?: RuntimeStatusInput;
  integratedDiagnostics?: IntegratedDiagnostics;
};

export function buildBncrDeadLetterDiagnosticsSnapshot(args: {
  accountId: string;
  entries: OutboxEntry[];
  allAccountsTotal: number;
  sinceStart: number;
  cappedAt: number;
}) {
  return buildDeadLetterDiagnosticsFromRuntime({
    entries: args.entries,
    allAccountsTotal: args.allAccountsTotal,
    sinceStart: args.sinceStart,
    cappedAt: args.cappedAt,
  });
}

export function createBncrOutboxDiagnosticsHelpers(runtime: {
  normalizeAccountId: (accountId: string) => string;
  outboxValues: () => Iterable<OutboxEntry>;
  pendingAllAccounts: () => number;
  resolvePushConnIds: (accountId: string) => Set<string>;
  buildOutboxQueueDiagnostics: typeof import('../messaging/outbound/diagnostics.ts').buildOutboxQueueDiagnostics;
  buildBncrOutboxQueueDiagnosticsInput: typeof import('./runtime-diagnostics-payload-builders.ts').buildBncrOutboxQueueDiagnosticsInput;
}) {
  const buildOutboxDiagnostics = (accountId: string) => {
    const acc = runtime.normalizeAccountId(accountId);
    return runtime.buildOutboxQueueDiagnostics(
      runtime.buildBncrOutboxQueueDiagnosticsInput({
        accountId: acc,
        outboxEntries: runtime.outboxValues(),
        pendingAllAccounts: runtime.pendingAllAccounts(),
        pushConnIds: runtime.resolvePushConnIds(acc),
      }),
    );
  };

  return { buildOutboxDiagnostics };
}

export function createBncrRuntimeAckObservabilityBuilder(runtime: {
  normalizeAccountId: (accountId: string) => string;
  getCounter: (map: Map<string, number>, accountId: string) => number;
  ackTimeoutCountByAccount: Map<string, number>;
  lateAckOkCountByAccount: Map<string, number>;
  lastLateAckPushLatencyMsByAccount: Map<string, number>;
  lastLateAckOkByAccount: Map<string, number>;
  adaptiveAckRecoveryOkCountByAccount: Map<string, number>;
  lastAckOkByAccount: Map<string, number>;
  lastAckTimeoutByAccount: Map<string, number>;
  lastAckQueueLatencyMsByAccount: Map<string, number>;
  lastAckPushLatencyMsByAccount: Map<string, number>;
  lastLateAckQueueLatencyMsByAccount: Map<string, number>;
  adaptiveAckTimeoutEnabled: boolean;
  defaultAckTimeoutMs: number;
  resolveMessageAckTimeoutMs: (accountId: string) => number;
  minAckTimeoutMs: number;
  maxAckTimeoutMs: number;
  lateAckObservationTtlMs: number;
  recoveryOkThreshold: number;
  now: () => number;
}) {
  return (accountId: string): BncrAckObservability => {
    const acc = runtime.normalizeAccountId(accountId);
    const recentAckTimeoutCount = runtime.getCounter(runtime.ackTimeoutCountByAccount, acc);
    const lateAckOkCount = runtime.getCounter(runtime.lateAckOkCountByAccount, acc);
    const lastLateAckPushLatencyMs = runtime.lastLateAckPushLatencyMsByAccount.get(acc) || null;
    const lastLateAckOkAt = runtime.lastLateAckOkByAccount.get(acc) || null;
    const nowMs = runtime.now();
    const adaptiveAckRecoveryOkCount = runtime.getCounter(
      runtime.adaptiveAckRecoveryOkCountByAccount,
      acc,
    );
    return buildBncrRuntimeAckObservability({
      lastAckOkAt: runtime.lastAckOkByAccount.get(acc) || null,
      lastAckTimeoutAt: runtime.lastAckTimeoutByAccount.get(acc) || null,
      recentAckTimeoutCount,
      lateAckOkCount,
      lastLateAckOkAt,
      adaptiveAckRecoveryOkCount,
      lastAckQueueLatencyMs: runtime.lastAckQueueLatencyMsByAccount.get(acc) || null,
      lastAckPushLatencyMs: runtime.lastAckPushLatencyMsByAccount.get(acc) || null,
      lastLateAckQueueLatencyMs: runtime.lastLateAckQueueLatencyMsByAccount.get(acc) || null,
      lastLateAckPushLatencyMs,
      adaptiveAckTimeoutEnabled: runtime.adaptiveAckTimeoutEnabled,
      defaultAckTimeoutMs: runtime.defaultAckTimeoutMs,
      currentAckTimeoutMs: runtime.resolveMessageAckTimeoutMs(acc),
      minAckTimeoutMs: runtime.minAckTimeoutMs,
      maxAckTimeoutMs: runtime.maxAckTimeoutMs,
      lateAckObservationTtlMs: runtime.lateAckObservationTtlMs,
      recoveryOkThreshold: runtime.recoveryOkThreshold,
      nowMs,
    });
  };
}

export function createBncrDeadLetterDiagnosticsHelpers(runtime: {
  normalizeAccountId: (accountId: string) => string;
  getDeadLetterEntries: () => OutboxEntry[];
  maxDeadLetterEntries: number;
  getCounter: (map: Map<string, number>, accountId: string) => number;
  deadLetterSinceStartByAccount: Map<string, number>;
  getAccountDeadLetterEntries: (accountId: string) => OutboxEntry[];
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logInfoDedup: (
    scope: string,
    message: string,
    options: { key: string; sig: string; windowMs?: number },
  ) => void;
}) {
  const buildDeadLetterDiagnostics = (accountId: string) => {
    const acc = runtime.normalizeAccountId(accountId);
    return buildBncrDeadLetterDiagnosticsSnapshot({
      accountId: acc,
      entries: runtime.getAccountDeadLetterEntries(acc),
      allAccountsTotal: runtime.getDeadLetterEntries().length,
      sinceStart: runtime.getCounter(runtime.deadLetterSinceStartByAccount, acc),
      cappedAt: runtime.maxDeadLetterEntries,
    });
  };

  const logDeadLetterSummary = (
    accountId: string,
    options?: { force?: boolean; source?: string },
  ) => {
    const acc = runtime.normalizeAccountId(accountId);
    const summary = buildDeadLetterDiagnostics(acc);
    const message = buildBncrDeadLetterSummaryMessage({
      accountId: acc,
      summary,
      source: options?.source,
    });
    if (options?.force) {
      runtime.logInfo('deadLetter summary', message);
      return;
    }
    runtime.logInfoDedup('deadLetter summary', message, {
      key: `dead-letter-summary:${acc}:update`,
      sig: 'dead-letter-summary',
      windowMs: 5 * 60 * 1000,
    });
  };

  const filterDeadLetterEntries = (params: {
    accountId: string;
    reason?: string | null;
    olderThan?: number | null;
  }) => {
    return filterDeadLetterEntriesFromRuntime({
      accountId: params.accountId,
      entries: runtime.getDeadLetterEntries(),
      reason: params.reason,
      olderThan: params.olderThan,
    });
  };

  return {
    buildDeadLetterDiagnostics,
    filterDeadLetterEntries,
    logDeadLetterSummary,
  };
}

export function createBncrDiagnosticsSelectionHelpers(runtime: {
  normalizeAccountId: (accountId: string) => string;
  outboxValues: () => Iterable<OutboxEntry>;
  getDeadLetterEntries: () => OutboxEntry[];
  connectionsValues: () => Iterable<BncrConnection>;
}) {
  const getAccountPendingOutboxEntries = (accountId: string) => {
    const acc = runtime.normalizeAccountId(accountId);
    return Array.from(runtime.outboxValues()).filter((entry) => entry.accountId === acc);
  };

  const getAccountDeadLetterEntries = (accountId: string) => {
    const acc = runtime.normalizeAccountId(accountId);
    return runtime.getDeadLetterEntries().filter((entry) => entry.accountId === acc);
  };

  const buildActiveConnectionDebugList = (
    accountId: string,
    options?: { includeOutboundState?: boolean },
  ) => {
    const acc = runtime.normalizeAccountId(accountId);
    return buildBncrActiveConnectionDebugList({
      accountId: acc,
      connections: runtime.connectionsValues() as Iterable<BncrConnectionDebugView>,
      options,
    });
  };

  return {
    getAccountPendingOutboxEntries,
    getAccountDeadLetterEntries,
    buildActiveConnectionDebugList,
  };
}
