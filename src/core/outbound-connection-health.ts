import type { BncrConnection } from './types.ts';
import { finiteNumberOr } from './value-sanitize.ts';

export const OUTBOUND_FAILURE_KIND = {
  PRE_PUSH_ABSENCE: 'pre-push-absence',
  BROADCAST_FAILURE: 'broadcast-failure',
  ACK_TIMEOUT: 'ack-timeout',
  BUSINESS_ERROR: 'business-error',
  RPC_TRANSPORT_TIMEOUT: 'rpc-transport-timeout',
} as const;

export type OutboundFailureKind =
  (typeof OUTBOUND_FAILURE_KIND)[keyof typeof OUTBOUND_FAILURE_KIND];

export const OUTBOUND_FAILURE_DECAY_MS = 120_000;
export const MAX_OUTBOUND_FAILURE_COUNT = 5;

type OutboundHealthConnection = BncrConnection & {
  lastAckOkAt?: number;
  lastPushTimeoutAt?: number;
  outboundFailureCount?: number;
  lastOutboundFailureAt?: number;
  lastOutboundFailureKind?: OutboundFailureKind;
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  return String(error ?? '').toLowerCase();
}

export function classifyOutboundFailure(args: {
  error: unknown;
  stage: 'broadcast' | 'rpc';
  explicitKind?: OutboundFailureKind;
}): OutboundFailureKind {
  if (args.explicitKind) return args.explicitKind;
  const text = errorText(args.error);
  if (text.includes('ack timeout')) return OUTBOUND_FAILURE_KIND.ACK_TIMEOUT;
  const timeout =
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('esockettimedout') ||
    text.includes('etimedout') ||
    text.includes('not connected') ||
    text.includes('econnreset') ||
    text.includes('socket hang up');
  if (timeout) {
    return args.stage === 'rpc'
      ? OUTBOUND_FAILURE_KIND.RPC_TRANSPORT_TIMEOUT
      : OUTBOUND_FAILURE_KIND.BROADCAST_FAILURE;
  }
  if (
    text.includes('business') ||
    text.includes('rejected') ||
    text.includes('invalid request') ||
    text.includes('method not found')
  ) {
    return OUTBOUND_FAILURE_KIND.BUSINESS_ERROR;
  }
  return OUTBOUND_FAILURE_KIND.BROADCAST_FAILURE;
}

export function isConnectionOutboundFailure(kind: OutboundFailureKind): boolean {
  return (
    kind === OUTBOUND_FAILURE_KIND.BROADCAST_FAILURE ||
    kind === OUTBOUND_FAILURE_KIND.ACK_TIMEOUT ||
    kind === OUTBOUND_FAILURE_KIND.RPC_TRANSPORT_TIMEOUT
  );
}

export function effectiveOutboundFailureScore(connection: BncrConnection, now: number): number {
  const conn = connection as OutboundHealthConnection;
  const count = Math.max(
    0,
    Math.min(MAX_OUTBOUND_FAILURE_COUNT, Math.floor(finiteNumberOr(conn.outboundFailureCount, 0))),
  );
  if (!count) return 0;
  const nowMs = finiteNumberOr(now, 0);
  const lastAt = finiteNumberOr(conn.lastOutboundFailureAt, 0);
  if (!nowMs || !lastAt) return 0;
  const age = nowMs - lastAt;
  if (age < 0) return count;
  if (age >= OUTBOUND_FAILURE_DECAY_MS) return 0;
  return count * (1 - age / OUTBOUND_FAILURE_DECAY_MS);
}

export function applyOutboundAckSuccess(connection: BncrConnection, at: number): BncrConnection {
  const conn = connection as OutboundHealthConnection;
  return {
    ...conn,
    lastAckOkAt: finiteNumberOr(at, 0),
    lastPushTimeoutAt: undefined,
    outboundFailureCount: 0,
    lastOutboundFailureAt: undefined,
    lastOutboundFailureKind: undefined,
  };
}

export function applyOutboundFailure(
  connection: BncrConnection,
  args: { kind: OutboundFailureKind; at: number },
): BncrConnection {
  if (!isConnectionOutboundFailure(args.kind)) return connection;
  const conn = connection as OutboundHealthConnection;
  const at = finiteNumberOr(args.at, 0);
  const previousAt = finiteNumberOr(conn.lastOutboundFailureAt, 0);
  const withinDecay = !!at && !!previousAt && at - previousAt < OUTBOUND_FAILURE_DECAY_MS;
  const previousCount = withinDecay
    ? Math.max(0, Math.floor(finiteNumberOr(conn.outboundFailureCount, 0)))
    : 0;
  return {
    ...conn,
    ...(args.kind === OUTBOUND_FAILURE_KIND.ACK_TIMEOUT ? { lastPushTimeoutAt: at } : {}),
    outboundFailureCount: Math.min(MAX_OUTBOUND_FAILURE_COUNT, previousCount + 1),
    lastOutboundFailureAt: at || undefined,
    lastOutboundFailureKind: args.kind,
  };
}
