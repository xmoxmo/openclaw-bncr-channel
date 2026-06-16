import type { buildIntegratedDiagnostics as buildIntegratedDiagnosticsFromRuntime } from '../core/status.ts';
import type {
  BncrAckObservability,
  BncrDeadLetterDiagnosticsSummary,
  BncrOutboxQueueDiagnostics,
} from '../core/types.ts';
import type { OpenClawChannelRuntimeSurfaceDiagnostics } from '../openclaw/runtime-surface.ts';
import {
  buildConnectionRuntimeSnapshot,
  buildOutboundRuntimeSnapshot,
  buildRegisterRuntimeSnapshot,
} from './bridge-surface-helpers.ts';
import { createBncrExtendedDiagnosticsAssembler } from './runtime-diagnostics-snapshot.ts';

type RuntimeStatusInput = Parameters<typeof buildIntegratedDiagnosticsFromRuntime>[0];
type IntegratedDiagnostics = ReturnType<typeof buildIntegratedDiagnosticsFromRuntime>;
type ExtendedDiagnosticsOptions = {
  runtimeStatusInput?: RuntimeStatusInput;
  integratedDiagnostics?: IntegratedDiagnostics;
};

export function createBncrBridgeExtendedDiagnosticsFacade(runtime: {
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
  buildRuntimeSurfaceDiagnostics: () => OpenClawChannelRuntimeSurfaceDiagnostics;
  getRegisterState: () => {
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
    registerTraceRecent: ReturnType<typeof buildRegisterRuntimeSnapshot>['registerTraceRecent'];
    lastDriftSnapshot: ReturnType<typeof buildRegisterRuntimeSnapshot>['lastDriftSnapshot'];
  };
  buildRegisterTraceSummary: () => ReturnType<
    typeof import('../core/register-trace.ts')['buildRegisterTraceSummary']
  >;
  activeConnectionCount: (accountId: string) => number;
  getConnectionState: () => {
    lastGatewayContextAt: number | null;
    primaryLeaseId: string | null;
    connectionEpoch: number;
    acceptedConnections: number;
    lastConnectAt: number | null;
    lastDisconnectAt: number | null;
    lastActivityAtGlobal: number | null;
    lastInboundAtGlobal: number | null;
    lastAckAtGlobal: number | null;
    recentConnections: ReturnType<typeof buildConnectionRuntimeSnapshot>['recentConnections'];
  };
  getOutboundState: () => {
    outboundEnqueueCountByAccount: Map<string, number>;
    lastOutboundEnqueueAtByAccount: Map<string, number>;
  };
  buildDeadLetterDiagnostics: (accountId: string) => BncrDeadLetterDiagnosticsSummary;
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
}) {
  const assemble = createBncrExtendedDiagnosticsAssembler({
    normalizeAccountId: runtime.normalizeAccountId,
    buildIntegratedDiagnostics: runtime.buildIntegratedDiagnostics,
    buildOutboxDiagnostics: runtime.buildOutboxDiagnostics,
    buildRuntimeAckObservability: runtime.buildRuntimeAckObservability,
    getCounter: runtime.getCounter,
    prePushGuardSkipCountByAccount: runtime.prePushGuardSkipCountByAccount,
    lastPrePushGuardSkipAtByAccount: runtime.lastPrePushGuardSkipAtByAccount,
    lastPrePushGuardSkipReasonByAccount: runtime.lastPrePushGuardSkipReasonByAccount,
    hasGatewayContext: runtime.hasGatewayContext,
    buildRuntimeSurfaceDiagnostics: runtime.buildRuntimeSurfaceDiagnostics,
    getRegisterRuntime: () => {
      const registerState = runtime.getRegisterState();
      return buildRegisterRuntimeSnapshot({
        bridgeId: registerState.bridgeId,
        gatewayPid: registerState.gatewayPid,
        pluginVersion: registerState.pluginVersion,
        pluginSource: registerState.pluginSource,
        lastApiInstanceId: registerState.lastApiInstanceId,
        lastRegistryFingerprint: registerState.lastRegistryFingerprint,
        registerCount: registerState.registerCount,
        firstRegisterAt: registerState.firstRegisterAt,
        lastRegisterAt: registerState.lastRegisterAt,
        lastApiRebindAt: registerState.lastApiRebindAt,
        apiGeneration: registerState.apiGeneration,
        registerTraceRecent: registerState.registerTraceRecent,
        lastDriftSnapshot: registerState.lastDriftSnapshot ?? null,
      });
    },
    buildRegisterTraceSummary: runtime.buildRegisterTraceSummary,
    activeConnectionCount: runtime.activeConnectionCount,
    getConnectionRuntime: () => {
      const connectionState = runtime.getConnectionState();
      return buildConnectionRuntimeSnapshot({
        lastGatewayContextAt: connectionState.lastGatewayContextAt,
        primaryLeaseId: connectionState.primaryLeaseId,
        connectionEpoch: connectionState.connectionEpoch,
        acceptedConnections: connectionState.acceptedConnections,
        lastConnectAt: connectionState.lastConnectAt,
        lastDisconnectAt: connectionState.lastDisconnectAt,
        lastActivityAtGlobal: connectionState.lastActivityAtGlobal,
        lastInboundAtGlobal: connectionState.lastInboundAtGlobal,
        lastAckAtGlobal: connectionState.lastAckAtGlobal,
        recentConnections: connectionState.recentConnections,
      });
    },
    getOutboundRuntime: () => {
      const outboundState = runtime.getOutboundState();
      return buildOutboundRuntimeSnapshot({
        outboundEnqueueCountByAccount: outboundState.outboundEnqueueCountByAccount,
        lastOutboundEnqueueAtByAccount: outboundState.lastOutboundEnqueueAtByAccount,
      });
    },
    buildDeadLetterDiagnostics: runtime.buildDeadLetterDiagnostics,
    bridgeVersion: runtime.bridgeVersion,
    staleCounters: runtime.staleCounters,
    now: runtime.now,
  });

  return {
    buildExtendedDiagnostics: (accountId: string, options: ExtendedDiagnosticsOptions = {}) =>
      assemble(accountId, options),
  };
}
