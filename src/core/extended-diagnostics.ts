import type { RegisterTraceEntry } from './register-trace.ts';

type ExtendedDiagnosticsInput = {
  diagnostics: Record<string, any>;
  runtimeSurface?: {
    channel: Record<string, boolean>;
    missing: string[];
  };
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
    traceSummary: Record<string, any>;
    lastDriftSnapshot: any;
  };
  connection: {
    active: number;
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
  protocol: {
    bridgeVersion: number;
    protocolVersion: number;
    minClientProtocol: number;
    features: Record<string, boolean>;
  };
  stale: Record<string, any>;
};

export function buildExtendedDiagnostics(input: ExtendedDiagnosticsInput) {
  return {
    ...input.diagnostics,
    runtimeSurface: input.runtimeSurface
      ? {
          channel: { ...input.runtimeSurface.channel },
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
    protocol: {
      ...input.protocol,
      features: { ...input.protocol.features },
    },
    stale: { ...input.stale },
  };
}
