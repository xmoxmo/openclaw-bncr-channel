import { createBncrConnectionState } from './connection-state.ts';

export function createBncrConnectionStateRuntimeGroup(runtime: {
  bridgeId: string;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  connectTtlMs: number;
  recentInboundSendWindowMs: number;
  outboundReadyTtlMs: number;
  preferredOutboundTtlMs: number;
  connections: Parameters<typeof createBncrConnectionState>[0]['connections'];
  activeConnectionByAccount: Parameters<
    typeof createBncrConnectionState
  >[0]['activeConnectionByAccount'];
  lastInboundByAccount: Parameters<typeof createBncrConnectionState>[0]['lastInboundByAccount'];
  lastActivityByAccount: Parameters<typeof createBncrConnectionState>[0]['lastActivityByAccount'];
  gcTransientState: Parameters<typeof createBncrConnectionState>[0]['gcTransientState'];
  connectionKey: Parameters<typeof createBncrConnectionState>[0]['connectionKey'];
  buildActiveConnectionDebugList: Parameters<
    typeof createBncrConnectionState
  >[0]['buildActiveConnectionDebugList'];
  rememberGatewayContext: Parameters<typeof createBncrConnectionState>[0]['rememberGatewayContext'];
  markActivity: Parameters<typeof createBncrConnectionState>[0]['markActivity'];
  logInfo: Parameters<typeof createBncrConnectionState>[0]['logInfo'];
  logInfoDedupJson: Parameters<typeof createBncrConnectionState>[0]['logInfoDedupJson'];
}) {
  const connectionState = createBncrConnectionState({
    bridgeId: runtime.bridgeId,
    now: runtime.now,
    asString: runtime.asString,
    connectTtlMs: runtime.connectTtlMs,
    recentInboundSendWindowMs: runtime.recentInboundSendWindowMs,
    outboundReadyTtlMs: runtime.outboundReadyTtlMs,
    preferredOutboundTtlMs: runtime.preferredOutboundTtlMs,
    connections: runtime.connections,
    activeConnectionByAccount: runtime.activeConnectionByAccount,
    lastInboundByAccount: runtime.lastInboundByAccount,
    lastActivityByAccount: runtime.lastActivityByAccount,
    gcTransientState: runtime.gcTransientState,
    connectionKey: runtime.connectionKey,
    buildActiveConnectionDebugList: runtime.buildActiveConnectionDebugList,
    rememberGatewayContext: runtime.rememberGatewayContext,
    markActivity: runtime.markActivity,
    logInfo: runtime.logInfo,
    logInfoDedupJson: runtime.logInfoDedupJson,
  });

  return {
    connectionState,
  };
}
