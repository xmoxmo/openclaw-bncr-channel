import type { RegisterDriftSnapshot, RegisterTraceEntry } from '../core/register-trace.ts';
import type { BncrConnection } from '../core/types.ts';

export function buildRegisterRuntimeSnapshot(args: {
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
}) {
  return {
    bridgeId: args.bridgeId,
    gatewayPid: args.gatewayPid,
    pluginVersion: args.pluginVersion,
    pluginSource: args.pluginSource,
    lastApiInstanceId: args.lastApiInstanceId,
    lastRegistryFingerprint: args.lastRegistryFingerprint,
    registerCount: args.registerCount,
    firstRegisterAt: args.firstRegisterAt,
    lastRegisterAt: args.lastRegisterAt,
    lastApiRebindAt: args.lastApiRebindAt,
    apiGeneration: args.apiGeneration,
    registerTraceRecent: args.registerTraceRecent,
    lastDriftSnapshot: args.lastDriftSnapshot ?? null,
  };
}

export function buildConnectionRuntimeSnapshot(args: {
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
}) {
  return {
    lastGatewayContextAt: args.lastGatewayContextAt,
    primaryLeaseId: args.primaryLeaseId,
    connectionEpoch: args.connectionEpoch,
    acceptedConnections: args.acceptedConnections,
    lastConnectAt: args.lastConnectAt,
    lastDisconnectAt: args.lastDisconnectAt,
    lastActivityAtGlobal: args.lastActivityAtGlobal,
    lastInboundAtGlobal: args.lastInboundAtGlobal,
    lastAckAtGlobal: args.lastAckAtGlobal,
    recentConnections: args.recentConnections,
  };
}

export function buildOutboundRuntimeSnapshot(args: {
  outboundEnqueueCountByAccount: Map<string, number>;
  lastOutboundEnqueueAtByAccount: Map<string, number>;
}) {
  return {
    outboundEnqueueCountByAccount: args.outboundEnqueueCountByAccount,
    lastOutboundEnqueueAtByAccount: args.lastOutboundEnqueueAtByAccount,
  };
}

export function buildStatusWorkerLastEventAt(args: {
  accountId: string;
  previous: { lastEventAt?: number | null };
  lastActivityByAccount: ReadonlyMap<string, number>;
  lastInboundByAccount: ReadonlyMap<string, number>;
  lastOutboundByAccount: ReadonlyMap<string, number>;
}) {
  return (
    args.lastActivityByAccount.get(args.accountId) ||
    args.lastInboundByAccount.get(args.accountId) ||
    args.lastOutboundByAccount.get(args.accountId) ||
    args.previous?.lastEventAt ||
    null
  );
}

export function buildStatusWorkerActiveConnections(args: {
  accountId: string;
  connections: Iterable<BncrConnection>;
}) {
  return Array.from(args.connections)
    .filter((connection) => connection.accountId === args.accountId)
    .map((connection) => ({
      connId: connection.connId,
      clientId: connection.clientId,
      inboundOnly: connection.inboundOnly === true,
      outboundReady: connection.outboundReady === true,
      preferredForOutbound: connection.preferredForOutbound === true,
    }));
}
