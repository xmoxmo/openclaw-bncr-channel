import { formatDeadLetterTopReasons } from '../core/dead-letter-diagnostics.ts';
import type {
  RegisterDriftSnapshot,
  RegisterTraceEntry,
  RegisterTraceSummary,
} from '../core/register-trace.ts';
import type {
  BncrAckObservability,
  BncrDeadLetterDiagnosticsSummary,
  BncrOutboxQueueDiagnostics,
  OutboxEntry,
} from '../core/types.ts';

export function buildBncrActiveConnectionDebugList(args: {
  accountId: string;
  connections: Iterable<{
    accountId: string;
    connId: string;
    clientId?: string;
    connectedAt: number;
    lastSeenAt: number;
    outboundReadyUntil?: number;
    preferredForOutboundUntil?: number;
    inboundOnly?: boolean;
  }>;
  options?: { includeOutboundState?: boolean };
}) {
  return Array.from(args.connections)
    .filter((conn) => conn.accountId === args.accountId)
    .map((conn) => ({
      accountId: conn.accountId,
      connId: conn.connId,
      clientId: conn.clientId,
      connectedAt: conn.connectedAt,
      lastSeenAt: conn.lastSeenAt,
      ...(args.options?.includeOutboundState
        ? {
            outboundReadyUntil: conn.outboundReadyUntil || null,
            preferredForOutboundUntil: conn.preferredForOutboundUntil || null,
            inboundOnly: conn.inboundOnly === true,
          }
        : {}),
    }));
}

export function buildBncrExtendedRegisterDiagnostics(args: {
  bridgeId: string;
  gatewayPid: number;
  pluginVersion: string | null;
  source: string | null;
  apiInstanceId: string | null;
  registryFingerprint: string | null;
  registerCount: number;
  firstRegisterAt: number | null;
  lastRegisterAt: number | null;
  lastApiRebindAt: number | null;
  apiGeneration: number;
  traceRecent: RegisterTraceEntry[];
  traceSummary: RegisterTraceSummary;
  lastDriftSnapshot: RegisterDriftSnapshot | null;
}) {
  return {
    bridgeId: args.bridgeId,
    gatewayPid: args.gatewayPid,
    pluginVersion: args.pluginVersion,
    source: args.source,
    apiInstanceId: args.apiInstanceId,
    registryFingerprint: args.registryFingerprint,
    registerCount: args.registerCount,
    firstRegisterAt: args.firstRegisterAt,
    lastRegisterAt: args.lastRegisterAt,
    lastApiRebindAt: args.lastApiRebindAt,
    apiGeneration: args.apiGeneration,
    traceRecent: args.traceRecent,
    traceSummary: args.traceSummary,
    lastDriftSnapshot: args.lastDriftSnapshot ?? null,
  };
}

export function buildBncrExtendedConnectionDiagnostics(args: {
  active: number;
  hasGatewayContext: boolean;
  lastGatewayContextAt: number | null;
  primaryLeaseId: string | null;
  primaryEpoch: number | null;
  acceptedConnections: number;
  lastConnectAt: number | null;
  lastDisconnectAt: number | null;
  lastActivityAt: number | null;
  lastInboundAt: number | null;
  lastAckAt: number | null;
  recentConnections: Map<
    string,
    { epoch: number; connectedAt: number; lastActivityAt: number | null; isPrimary: boolean }
  >;
}) {
  return {
    active: args.active,
    hasGatewayContext: args.hasGatewayContext,
    lastGatewayContextAt: args.lastGatewayContextAt,
    primaryLeaseId: args.primaryLeaseId,
    primaryEpoch: args.primaryEpoch,
    acceptedConnections: args.acceptedConnections,
    lastConnectAt: args.lastConnectAt,
    lastDisconnectAt: args.lastDisconnectAt,
    lastActivityAt: args.lastActivityAt,
    lastInboundAt: args.lastInboundAt,
    lastAckAt: args.lastAckAt,
    recent: Array.from(args.recentConnections.entries()).map(([leaseId, entry]) => ({
      leaseId,
      epoch: entry.epoch,
      connectedAt: entry.connectedAt,
      lastActivityAt: entry.lastActivityAt,
      isPrimary: entry.isPrimary,
    })),
  };
}

export function buildBncrExtendedOutboundDiagnosticsInput(args: {
  outbox: BncrOutboxQueueDiagnostics;
  enqueueCount: number;
  lastEnqueueAt: number | null;
  prePushGuardSkipCount: number;
  lastPrePushGuardSkipAt: number | null;
  lastPrePushGuardSkipReason: string | null;
  hasGatewayContext: boolean;
  lastGatewayContextAt: number | null;
  ackObservability: BncrAckObservability;
  nowMs: number;
}) {
  return {
    outbox: args.outbox,
    enqueueCount: args.enqueueCount,
    lastEnqueueAt: args.lastEnqueueAt,
    prePushGuardSkipCount: args.prePushGuardSkipCount,
    lastPrePushGuardSkipAt: args.lastPrePushGuardSkipAt,
    lastPrePushGuardSkipReason: args.lastPrePushGuardSkipReason,
    hasGatewayContext: args.hasGatewayContext,
    lastGatewayContextAt: args.lastGatewayContextAt,
    ackObservability: args.ackObservability,
    nowMs: args.nowMs,
  };
}

export function buildBncrDeadLetterSummaryMessage(args: {
  accountId: string;
  summary: BncrDeadLetterDiagnosticsSummary;
  source?: string;
}) {
  return [
    `${args.accountId}|total=${args.summary.total}`,
    `all=${args.summary.allAccountsTotal}`,
    `sinceStart=${args.summary.sinceStart}`,
    `top=${formatDeadLetterTopReasons(args.summary.topReasons)}`,
    `source=${args.source || 'update'}`,
  ].join('|');
}

export function buildBncrOutboxQueueDiagnosticsInput(args: {
  accountId: string;
  outboxEntries: Iterable<OutboxEntry>;
  pendingAllAccounts: number;
  pushConnIds: Set<string>;
}) {
  return {
    accountId: args.accountId,
    outboxEntries: args.outboxEntries,
    pendingAllAccounts: args.pendingAllAccounts,
    pushConnIds: args.pushConnIds,
  };
}
