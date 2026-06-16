import type { OpenClawChannelRuntimeSurfaceDiagnostics } from '../openclaw/runtime-surface.ts';
import type {
  RegisterDriftSnapshot,
  RegisterTraceEntry,
  RegisterTraceSummary,
} from './register-trace.ts';
import type {
  BncrDeadLetterDiagnosticsSummary,
  BncrDiagnosticsSummary,
  BncrExtendedOutboundDiagnostics,
  BncrStaleCounterSummary,
} from './types.ts';

type ExtendedConnectionDiagnostics = {
  active: number;
  hasGatewayContext?: boolean;
  lastGatewayContextAt?: number | null;
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

type ExtendedProtocolDiagnostics = {
  bridgeVersion: number;
  protocolVersion: number;
  minClientProtocol: number;
  features: Record<string, boolean>;
};

export type BncrExtendedDiagnostics = BncrDiagnosticsSummary & {
  runtimeSurface?: OpenClawChannelRuntimeSurfaceDiagnostics;
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
  connection: ExtendedConnectionDiagnostics;
  outbound?: BncrExtendedOutboundDiagnostics;
  deadLetterSummary?: BncrDeadLetterDiagnosticsSummary;
  protocol: ExtendedProtocolDiagnostics;
  stale: BncrStaleCounterSummary;
};

type ExtendedDiagnosticsInput = {
  diagnostics: BncrDiagnosticsSummary;
  runtimeSurface?: OpenClawChannelRuntimeSurfaceDiagnostics;
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
  outbound?: BncrExtendedOutboundDiagnostics;
  deadLetterSummary?: BncrDeadLetterDiagnosticsSummary;
  connection: ExtendedConnectionDiagnostics;
  protocol: ExtendedProtocolDiagnostics;
  stale: BncrStaleCounterSummary;
};

export function buildExtendedDiagnostics(input: ExtendedDiagnosticsInput): BncrExtendedDiagnostics {
  return {
    ...input.diagnostics,
    runtimeSurface: input.runtimeSurface
      ? {
          runtime: { ...input.runtimeSurface.runtime },
          channel: { ...input.runtimeSurface.channel },
          channelMedia: { ...input.runtimeSurface.channelMedia },
          contract: { ...input.runtimeSurface.contract },
          missing: input.runtimeSurface.missing.slice(),
        }
      : undefined,
    register: {
      ...input.register,
      traceRecent: input.register.traceRecent.slice(),
    },
    connection: {
      ...input.connection,
      recent: input.connection.recent.map((entry) => ({ ...entry })),
    },
    outbound: input.outbound ? { ...input.outbound } : undefined,
    deadLetterSummary: input.deadLetterSummary ? { ...input.deadLetterSummary } : undefined,
    protocol: {
      ...input.protocol,
      features: { ...input.protocol.features },
    },
    stale: { ...input.stale },
  };
}
