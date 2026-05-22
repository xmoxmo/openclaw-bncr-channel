import type { BncrConnection, OutboxEntry } from './types.ts';

export function buildPushBroadcastPayload(args: {
  payload: Record<string, unknown>;
  messageId: string;
}) {
  return {
    ...args.payload,
    idempotencyKey: args.messageId,
  };
}

export function buildPushRouteSelectArgs(args: {
  entry: OutboxEntry;
  connIds: Iterable<string>;
  routeReason: string;
  recentInboundReachable: boolean;
  owner: BncrConnection | null;
  event: string;
  kind?: 'file-transfer';
}) {
  return {
    messageId: args.entry.messageId,
    accountId: args.entry.accountId,
    kind: args.kind,
    routeReason: args.routeReason,
    connIds: args.connIds,
    ownerConnId: args.owner?.connId || '',
    ownerClientId: args.owner?.clientId || '',
    recentInboundReachable: args.recentInboundReachable,
    event: args.event,
  };
}

export function buildPushOkArgs(args: {
  entry: OutboxEntry;
  connIds: Iterable<string>;
  recentInboundReachable: boolean;
  event: string;
  kind?: 'file-transfer';
}) {
  return {
    messageId: args.entry.messageId,
    accountId: args.entry.accountId,
    kind: args.kind,
    connIds: args.connIds,
    ownerConnId: args.entry.lastPushConnId || '',
    ownerClientId: args.entry.lastPushClientId || '',
    recentInboundReachable: args.recentInboundReachable,
    event: args.event,
  };
}

export function buildPushFailureArgs(args: {
  entry: OutboxEntry;
  retryable?: boolean;
  kind?: 'file-transfer';
}) {
  return {
    messageId: args.entry.messageId,
    accountId: args.entry.accountId,
    retryCount: args.entry.retryCount,
    kind: args.kind,
    retryable: args.retryable,
    lastError: args.entry.lastError,
  };
}
