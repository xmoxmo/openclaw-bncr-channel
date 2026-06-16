import { buildCapabilitySnapshot } from '../core/connection-capability.ts';
import type { BncrConnection } from '../core/types.ts';
import type { BncrActiveConnectionDebugEntry } from './connection-state.ts';

type BncrCapabilityConnection = BncrConnection & {
  outboundReadyUntil?: number;
  preferredForOutboundUntil?: number;
  inboundOnly?: boolean;
};

export function buildConnectionPromotePayload(args: {
  bridgeId: string;
  accountId: string;
  reason: string;
  previousActiveKey: string | null;
  previousActiveConn: BncrConnection | null;
  nextActiveKey: string;
  nextActiveConn: BncrConnection;
  activeConnections: BncrActiveConnectionDebugEntry[];
}) {
  return {
    bridge: args.bridgeId,
    accountId: args.accountId,
    reason: args.reason,
    previousActiveKey: args.previousActiveKey,
    previousActiveConn: args.previousActiveConn,
    nextActiveKey: args.nextActiveKey,
    nextActiveConn: args.nextActiveConn,
    activeConnections: args.activeConnections,
  };
}

export function buildConnectionCapabilityDebugPayload(args: {
  bridgeId: string;
  accountId: string;
  connection: BncrConnection;
  outboundReady: boolean;
  preferredForOutbound: boolean;
}) {
  const snapshot = buildCapabilitySnapshot(args.connection);
  return {
    payload: {
      bridge: args.bridgeId,
      accountId: args.accountId,
      connId: args.connection.connId,
      clientId: args.connection.clientId,
      outboundReady: args.outboundReady,
      preferredForOutbound: args.preferredForOutbound,
      inboundOnly: snapshot.inboundOnly,
      outboundReadyUntil: snapshot.outboundReadyUntil,
      preferredForOutboundUntil: snapshot.preferredForOutboundUntil,
    },
    snapshot,
  };
}

export function buildConnectionCapabilityDebugSig(args: {
  bridgeId: string;
  accountId: string;
  connection: BncrConnection;
  outboundReady: boolean;
  preferredForOutbound: boolean;
  snapshot: ReturnType<typeof buildCapabilitySnapshot>;
  nowMs: number;
}) {
  return JSON.stringify({
    bridge: args.bridgeId,
    accountId: args.accountId,
    connId: args.connection.connId,
    clientId: args.connection.clientId || null,
    outboundReady: args.outboundReady,
    preferredForOutbound: args.preferredForOutbound,
    inboundOnly: args.snapshot.inboundOnly,
    outboundReadyActive: Number(args.snapshot.outboundReadyUntil || 0) > args.nowMs,
    preferredForOutboundActive: Number(args.snapshot.preferredForOutboundUntil || 0) > args.nowMs,
  });
}

export function buildConnectionDegradeSkipPayload(args: {
  bridgeId: string;
  accountId: string;
  connection: BncrConnection;
  reason: string;
  at: number;
  currentActiveKey: string | null;
  degradedKey: string;
  before: ReturnType<typeof buildCapabilitySnapshot>;
}) {
  return {
    bridge: args.bridgeId,
    accountId: args.accountId,
    connId: args.connection.connId,
    clientId: args.connection.clientId,
    reason: args.reason,
    at: args.at,
    currentActiveKey: args.currentActiveKey,
    degradedKey: args.degradedKey,
    skipReason: 'no-alternative-live-connection',
    before: args.before,
  };
}

export function buildConnectionDegradePayload(args: {
  bridgeId: string;
  accountId: string;
  connection: BncrConnection;
  reason: string;
  at: number;
  currentActiveKey: string | null;
  degradedKey: string;
  before: ReturnType<typeof buildCapabilitySnapshot>;
  after: ReturnType<typeof buildCapabilitySnapshot>;
}) {
  return {
    bridge: args.bridgeId,
    accountId: args.accountId,
    connId: args.connection.connId,
    clientId: args.connection.clientId,
    reason: args.reason,
    at: args.at,
    currentActiveKey: args.currentActiveKey,
    degradedKey: args.degradedKey,
    before: args.before,
    after: args.after,
  };
}

export function buildSeenConnection(args: {
  accountId: string;
  connId: string;
  clientId?: string;
  nowMs: number;
  previous?: BncrCapabilityConnection | null;
}): BncrCapabilityConnection {
  return {
    accountId: args.accountId,
    connId: args.connId,
    clientId: String(args.clientId || '').trim() || undefined,
    connectedAt: args.previous?.connectedAt || args.nowMs,
    lastSeenAt: args.nowMs,
    outboundReadyUntil: args.previous?.outboundReadyUntil,
    preferredForOutboundUntil: args.previous?.preferredForOutboundUntil,
    inboundOnly: args.previous?.inboundOnly,
  };
}

export function resolveSeenConnectionPromoteReason(args: {
  currentActiveKey: string | null;
  currentConnection: BncrConnection | null;
  nowMs: number;
  connectTtlMs: number;
}) {
  if (!args.currentActiveKey) return 'no-current-active' as const;
  if (!args.currentConnection) return 'current-missing' as const;
  if (args.nowMs - args.currentConnection.lastSeenAt > args.connectTtlMs) {
    return 'current-stale' as const;
  }
  return null;
}
