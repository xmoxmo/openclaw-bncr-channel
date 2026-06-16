import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { BncrExtendedDiagnostics } from '../core/extended-diagnostics.ts';
import type { RegisterTraceSummary } from '../core/register-trace.ts';
import type {
  BncrAccountRuntimeSnapshot,
  buildIntegratedDiagnostics as buildIntegratedDiagnosticsFromRuntime,
} from '../core/status.ts';
import type {
  BncrAckObservability,
  BncrConnection,
  BncrDeadLetterDiagnosticsSummary,
  BncrDiagnosticsSummary,
  BncrDownlinkHealthSummary,
  BncrOutboxQueueDiagnostics,
  BncrRoute,
  FileSendTransferState,
  OutboxEntry,
} from '../core/types.ts';
import type { BncrRuntimeFlags } from '../runtime/outbound-flags.ts';
import type { createBncrBridgeDiagnosticsHandlersComponent } from './channel-components.ts';
import type { BncrChannelConfigRoot } from './channel-runtime-types.ts';
import type {
  ConnectionQueueCounters,
  FileAckPayload,
  LeaseEventPayload,
  PreparedAckHandling,
} from './connection-handlers.ts';

type DiagnosticsRuntimeStatusInput = Parameters<typeof buildIntegratedDiagnosticsFromRuntime>[0] & {
  running: boolean | undefined;
  channelRoot: string;
};

type DiagnosticsRuntimeStatusOverrides = {
  running: boolean;
  invalidOutboxSessionKeys?: number;
  legacyAccountResidue?: number;
};

type StoredRouteRecord = { accountId: string; route: BncrRoute; updatedAt: number };
type StoredLastSessionRecord = { sessionKey: string; scope: string; updatedAt: number };

// Status/diagnostics-side wiring catalog.
//
// Order is intentional:
// 1) gateway-adjacent diagnostics host surfaces
// 2) persistence/status read-model slices
// 3) diagnostics assembly slices

export function buildBncrBridgeSurfaceHandlersRuntime(deps: {
  bridgeId: string;
  gatewayPid: number;
  pushEvent: string;
  bridgeVersion: number;
  getApi: Parameters<typeof createBncrBridgeDiagnosticsHandlersComponent>[0]['getApi'];
  channelId: string;
  asString: (value: unknown, fallback?: string) => string;
  now: () => number;
  finiteNonNegativeNumberOrNull: (value: unknown) => number | null;
  syncDebugFlag: () => Promise<void>;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  normalizeAccountId: (value: string) => string;
  pluginRoot: string;
  buildAccountQueueCounters: (accountId: string) => ConnectionQueueCounters;
  buildExtendedDiagnostics: (
    accountId: string,
    args?: Record<string, unknown>,
  ) => BncrExtendedDiagnostics;
  buildRuntimeFlags: (accountId: string) => BncrRuntimeFlags;
  buildRuntimeStatusInput: (
    accountId: string,
    overrides: DiagnosticsRuntimeStatusOverrides,
  ) => DiagnosticsRuntimeStatusInput;
  getAccountRuntimeSnapshot: (
    accountId: string,
    runtimeStatusInput: DiagnosticsRuntimeStatusInput,
  ) => BncrAccountRuntimeSnapshot;
  buildIntegratedDiagnostics: (
    accountId: string,
    runtimeStatusInput: DiagnosticsRuntimeStatusInput,
  ) => ReturnType<typeof buildIntegratedDiagnosticsFromRuntime>;
  buildDownlinkHealth: (accountId: string) => BncrDownlinkHealthSummary;
  isPrimaryConnection: (accountId: string, clientId?: string) => boolean;
  acceptConnection: () => { leaseId: string; connectionEpoch: number; acceptedAt: number };
  refreshLiveConnectionState: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady: boolean;
    preferredForOutbound: boolean;
    inboundOnly: boolean;
    context: GatewayRequestHandlerOptions['context'];
  }) => void;
  flushOnConnect: (accountId: string) => void;
  flushOnActivity: (accountId: string) => void;
  shouldIgnoreStaleEvent: (args: {
    kind:
      | 'activity'
      | 'ack'
      | 'file.init'
      | 'file.chunk'
      | 'file.complete'
      | 'file.abort'
      | 'inbound';
    payload: LeaseEventPayload;
    accountId: string;
    connId: string;
    clientId?: string;
  }) => boolean;
  incrementConnectEvents: (accountId: string) => void;
  incrementActivityEvents: (accountId: string) => void;
  incrementAckEvents: (accountId: string) => void;
  markLastActivityAt: () => void;
  markLastAckAt: () => void;
  messageAckWaiterCount: () => number;
  fileAckWaiterCount: () => number;
  prepareAckHandling: (args: {
    params: GatewayRequestHandlerOptions['params'];
    respond: GatewayRequestHandlerOptions['respond'];
    client: GatewayRequestHandlerOptions['client'];
    context: GatewayRequestHandlerOptions['context'];
  }) => PreparedAckHandling | null;
  handleAckOutcome: (
    args: {
      params: GatewayRequestHandlerOptions['params'];
      respond: GatewayRequestHandlerOptions['respond'];
    } & PreparedAckHandling,
  ) => void;
  fileSendTransfers: Map<string, FileSendTransferState>;
  hasFileAckWaiter: (key: string) => boolean;
  fileAckKey: (transferId: string, stage: string, chunkIndex?: number) => string;
  observeLease: (
    kind:
      | 'connect'
      | 'inbound'
      | 'activity'
      | 'ack'
      | 'file.init'
      | 'file.chunk'
      | 'file.complete'
      | 'file.abort',
    payload: LeaseEventPayload,
  ) => { stale: boolean };
  tryAdoptTransferOwner: (args: {
    accountId: string;
    transfer: FileSendTransferState | undefined;
    connId: string;
    clientId?: string;
  }) => boolean;
  refreshAcceptedFileTransferLiveState: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    context: GatewayRequestHandlerOptions['context'];
  }) => void;
  resolveFileAck: (args: {
    transferId: string;
    stage: string;
    chunkIndex?: number;
    payload: FileAckPayload;
    ok: boolean;
  }) => void;
  countInvalidOutboxSessionKeys: (accountId: string) => number;
  countLegacyAccountResidue: (accountId: string) => number;
  activeConnectionCount: (accountId: string) => number;
  getMessageAckWaiterCount: () => number;
  getFileAckWaiterCount: () => number;
  filterDeadLetterEntries: (args: {
    accountId: string;
    reason?: string | null;
    olderThan?: number | null;
  }) => OutboxEntry[];
  listDeadLetterEntries: () => OutboxEntry[];
  buildDeadLetterDiagnostics: (accountId: string) => BncrDeadLetterDiagnosticsSummary;
  replaceDeadLetterEntries: (nextEntries: OutboxEntry[]) => void;
  scheduleSave: () => void;
  logDeadLetterSummary: (accountId: string, args: { force: boolean; source: string }) => void;
}) {
  return { ...deps };
}

export function buildBncrTargetStatusRuntime(deps: {
  api: unknown;
  channelId: string;
  canonicalAgentId: string | null;
  getPluginRoot: () => string | null;
  startedAt: number;
  debugVerbose: boolean;
  adaptiveAckTimeoutEnabled: boolean;
  defaultMessageAckTimeoutMs: number;
  fileAckTimeoutMs: number;
  maxAckTimeoutMs: number;
  now: () => number;
  normalizeAccountId: (accountId: string) => string;
  sessionRoutes: Map<string, StoredRouteRecord>;
  routeAliases: Map<string, StoredRouteRecord>;
  lastSessionByAccount: Map<string, StoredLastSessionRecord>;
  markActivity: (accountId: string, at?: number) => void;
  scheduleSave: () => void;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  ensureCanonicalAgentId: (args: {
    cfg: BncrChannelConfigRoot;
    accountId: string;
    peer?: unknown;
    channelId?: string;
  }) => string;
  recentMediaDedupeBySession: Map<string, Map<string, unknown>>;
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
  lastActivityByAccount: Map<string, number>;
  lastInboundByAccount: Map<string, number>;
  lastOutboundByAccount: Map<string, number>;
  buildRuntimeAckObservability: (accountId: string) => BncrAckObservability;
  buildRuntimeAckStrategy: (ackObservability: BncrAckObservability) => {
    timeoutMs: number;
    reason:
      | 'static-default'
      | 'adaptive-disabled'
      | 'invalid-observability'
      | 'late-ack-observed'
      | 'capped-max';
  };
  lastAckOkByAccount: Map<string, number>;
  lastAckTimeoutByAccount: Map<string, number>;
  getAckTimeoutCount: (accountId: string) => number;
  getAccountPendingOutboxEntries: (accountId: string) => OutboxEntry[];
  getAccountDeadLetterEntries: (accountId: string) => OutboxEntry[];
  connectionsValues: () => Iterable<{ lastSeenAt: number }>;
  connectTtlMs: number;
}) {
  return { ...deps };
}

export function buildBncrDiagnosticsSelectionRuntime(deps: {
  normalizeAccountId: (accountId: string) => string;
  outboxValues: () => Iterable<OutboxEntry>;
  getDeadLetterEntries: () => OutboxEntry[];
  connectionsValues: () => Iterable<BncrConnection>;
}) {
  return { ...deps };
}

export function buildBncrOutboxDiagnosticsRuntime(deps: {
  normalizeAccountId: (accountId: string) => string;
  outboxValues: () => Iterable<OutboxEntry>;
  pendingAllAccounts: () => number;
  resolvePushConnIds: (accountId: string) => Set<string>;
}) {
  return { ...deps };
}

export function buildBncrRuntimeAckObservabilityRuntime(deps: {
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
  return { ...deps };
}

export function buildBncrDeadLetterDiagnosticsRuntime(deps: {
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
  return { ...deps };
}

export function buildBncrExtendedDiagnosticsAssemblerRuntime(deps: {
  normalizeAccountId: (accountId: string) => string;
  buildIntegratedDiagnostics: (
    accountId: string,
    runtimeStatusInput?: Parameters<typeof buildIntegratedDiagnosticsFromRuntime>[0],
  ) => BncrDiagnosticsSummary;
  buildOutboxDiagnostics: (accountId: string) => BncrOutboxQueueDiagnostics;
  buildRuntimeAckObservability: (accountId: string) => BncrAckObservability;
  getCounter: (map: Map<string, number>, accountId: string) => number;
  prePushGuardSkipCountByAccount: Map<string, number>;
  lastPrePushGuardSkipAtByAccount: Map<string, number>;
  lastPrePushGuardSkipReasonByAccount: Map<string, string>;
  hasGatewayContext: () => boolean;
  buildRuntimeSurfaceDiagnostics: () => Record<string, unknown>;
  getRegisterRuntime: () => Record<string, unknown>;
  buildRegisterTraceSummary: () => RegisterTraceSummary;
  activeConnectionCount: (accountId: string) => number;
  getConnectionRuntime: () => Record<string, unknown>;
  getOutboundRuntime: () => Record<string, unknown>;
  buildDeadLetterDiagnostics: (accountId: string) => BncrDeadLetterDiagnosticsSummary;
  bridgeVersion: number;
  staleCounters: Record<string, number>;
  now: () => number;
}) {
  return { ...deps };
}
