import type { BncrExtendedDiagnostics } from '../core/extended-diagnostics.ts';
import { buildExtendedDiagnostics as buildExtendedDiagnosticsFromRuntime } from '../core/extended-diagnostics.ts';
import type {
  RegisterDriftSnapshot,
  RegisterTraceEntry,
  RegisterTraceSummary,
} from '../core/register-trace.ts';
import { buildExtendedOutboundDiagnostics } from '../messaging/outbound/diagnostics.ts';
import type {
  buildBncrDeadLetterDiagnosticsSnapshot,
  ExtendedDiagnosticsAssemblerOptions,
  ExtendedDiagnosticsAssemblerRuntime,
} from './runtime-diagnostics-helpers.ts';
import {
  buildBncrExtendedConnectionDiagnostics,
  buildBncrExtendedOutboundDiagnosticsInput,
  buildBncrExtendedRegisterDiagnostics,
} from './runtime-diagnostics-payload-builders.ts';

export function createBncrExtendedDiagnosticsAssembler(
  runtime: ExtendedDiagnosticsAssemblerRuntime,
) {
  return (
    accountId: string,
    options: ExtendedDiagnosticsAssemblerOptions = {},
  ): BncrExtendedDiagnostics => {
    const acc = runtime.normalizeAccountId(accountId);
    const diagnostics =
      options.integratedDiagnostics ||
      runtime.buildIntegratedDiagnostics(acc, options.runtimeStatusInput);
    const outboxDiagnostics = runtime.buildOutboxDiagnostics(acc);
    const ackObservability = runtime.buildRuntimeAckObservability(acc);
    const prePushGuardSkipCount = runtime.getCounter(runtime.prePushGuardSkipCountByAccount, acc);
    const lastPrePushGuardSkipAt = runtime.lastPrePushGuardSkipAtByAccount.get(acc) || null;
    const lastPrePushGuardSkipReason = runtime.lastPrePushGuardSkipReasonByAccount.get(acc) || null;
    const hasGatewayContext = runtime.hasGatewayContext();
    const registerRuntime = runtime.getRegisterRuntime();
    const connectionRuntime = runtime.getConnectionRuntime();
    const outboundRuntime = runtime.getOutboundRuntime();

    return buildBncrExtendedDiagnosticsSnapshot({
      diagnostics,
      runtimeSurface: runtime.buildRuntimeSurfaceDiagnostics(),
      register: buildBncrExtendedRegisterDiagnostics({
        bridgeId: registerRuntime.bridgeId,
        gatewayPid: registerRuntime.gatewayPid,
        pluginVersion: registerRuntime.pluginVersion,
        source: registerRuntime.pluginSource,
        apiInstanceId: registerRuntime.lastApiInstanceId,
        registryFingerprint: registerRuntime.lastRegistryFingerprint,
        registerCount: registerRuntime.registerCount,
        firstRegisterAt: registerRuntime.firstRegisterAt,
        lastRegisterAt: registerRuntime.lastRegisterAt,
        lastApiRebindAt: registerRuntime.lastApiRebindAt,
        apiGeneration: registerRuntime.apiGeneration,
        traceRecent: registerRuntime.registerTraceRecent,
        traceSummary: runtime.buildRegisterTraceSummary(),
        lastDriftSnapshot: registerRuntime.lastDriftSnapshot ?? null,
      }),
      connection: buildBncrExtendedConnectionDiagnostics({
        active: runtime.activeConnectionCount(acc),
        hasGatewayContext,
        lastGatewayContextAt: connectionRuntime.lastGatewayContextAt,
        primaryLeaseId: connectionRuntime.primaryLeaseId,
        primaryEpoch: connectionRuntime.connectionEpoch || null,
        acceptedConnections: connectionRuntime.acceptedConnections,
        lastConnectAt: connectionRuntime.lastConnectAt,
        lastDisconnectAt: connectionRuntime.lastDisconnectAt,
        lastActivityAt: connectionRuntime.lastActivityAtGlobal,
        lastInboundAt: connectionRuntime.lastInboundAtGlobal,
        lastAckAt: connectionRuntime.lastAckAtGlobal,
        recentConnections: connectionRuntime.recentConnections,
      }),
      outbound: buildBncrExtendedOutboundDiagnosticsInput({
        outbox: outboxDiagnostics,
        enqueueCount: runtime.getCounter(outboundRuntime.outboundEnqueueCountByAccount, acc),
        lastEnqueueAt: outboundRuntime.lastOutboundEnqueueAtByAccount.get(acc) || null,
        prePushGuardSkipCount,
        lastPrePushGuardSkipAt,
        lastPrePushGuardSkipReason,
        hasGatewayContext,
        lastGatewayContextAt: connectionRuntime.lastGatewayContextAt,
        ackObservability,
        nowMs: runtime.now(),
      }),
      deadLetterSummary: runtime.buildDeadLetterDiagnostics(acc),
      protocol: {
        bridgeVersion: runtime.bridgeVersion,
        protocolVersion: 2,
        minClientProtocol: 1,
        features: {
          leaseId: true,
          connectionEpoch: true,
          staleObserveOnly: true,
          staleRejectAck: false,
          staleRejectFile: false,
        },
      },
      stale: runtime.staleCounters,
      nowMs: runtime.now(),
    });
  };
}

export function buildBncrExtendedDiagnosticsSnapshot(args: {
  diagnostics: import('../core/types.ts').BncrDiagnosticsSummary;
  runtimeSurface: ReturnType<
    typeof import('../openclaw/runtime-surface.ts')['buildOpenClawChannelRuntimeSurfaceDiagnostics']
  >;
  register: {
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
  };
  connection: {
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
    recent: Array<{
      leaseId: string;
      epoch: number;
      connectedAt: number;
      lastActivityAt: number | null;
      isPrimary: boolean;
    }>;
  };
  outbound: Parameters<typeof buildExtendedOutboundDiagnostics>[0];
  deadLetterSummary: ReturnType<typeof buildBncrDeadLetterDiagnosticsSnapshot>;
  protocol: {
    bridgeVersion: number;
    protocolVersion: number;
    minClientProtocol: number;
    features: {
      leaseId: boolean;
      connectionEpoch: boolean;
      staleObserveOnly: boolean;
      staleRejectAck: boolean;
      staleRejectFile: boolean;
    };
  };
  stale: {
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
  nowMs: number;
}): BncrExtendedDiagnostics {
  return buildExtendedDiagnosticsFromRuntime({
    diagnostics: args.diagnostics,
    runtimeSurface: args.runtimeSurface,
    register: args.register,
    connection: args.connection,
    outbound: buildExtendedOutboundDiagnostics(args.outbound),
    deadLetterSummary: args.deadLetterSummary,
    protocol: args.protocol,
    stale: args.stale,
  });
}
