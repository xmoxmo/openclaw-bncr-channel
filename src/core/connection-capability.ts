import type { BncrConnection } from './types.ts';

type CapabilityConnection = BncrConnection & {
  outboundReadyUntil?: number;
  preferredForOutboundUntil?: number;
  inboundOnly?: boolean;
  lastAckOkAt?: number;
  lastPushTimeoutAt?: number;
};

export function applyOutboundCapability(args: {
  connection: CapabilityConnection;
  at: number;
  outboundReadyTtlMs: number;
  preferredOutboundTtlMs: number;
  outboundReady?: boolean;
  preferredForOutbound?: boolean;
  inboundOnly?: boolean;
}) {
  const next: CapabilityConnection = { ...args.connection };

  if (args.inboundOnly === true) {
    next.inboundOnly = true;
    next.outboundReadyUntil = undefined;
    next.preferredForOutboundUntil = undefined;
  } else {
    if (typeof args.inboundOnly === 'boolean') next.inboundOnly = false;
    if (args.outboundReady === true || args.preferredForOutbound === true) {
      next.outboundReadyUntil = args.at + args.outboundReadyTtlMs;
    }
    if (args.preferredForOutbound === true) {
      next.preferredForOutboundUntil = args.at + args.preferredOutboundTtlMs;
    }
  }

  return next;
}

export function findCapabilityConnection(args: {
  accountId: string;
  connId?: string;
  clientId?: string;
  connections: Iterable<[string, BncrConnection]>;
}) {
  for (const [key, conn] of args.connections) {
    if (conn.accountId !== args.accountId) continue;
    if (args.connId && conn.connId !== args.connId) continue;
    if (args.clientId && conn.clientId !== args.clientId) continue;
    return {
      key,
      connection: conn as CapabilityConnection,
    };
  }
  return null;
}

export function buildCapabilitySnapshot(connection: CapabilityConnection) {
  return {
    outboundReadyUntil: connection.outboundReadyUntil ?? null,
    preferredForOutboundUntil: connection.preferredForOutboundUntil ?? null,
    inboundOnly: connection.inboundOnly === true,
  };
}

export function clearOutboundCapability(connection: CapabilityConnection) {
  const next: CapabilityConnection = { ...connection };
  next.outboundReadyUntil = undefined;
  next.preferredForOutboundUntil = undefined;
  return next;
}
