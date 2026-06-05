import { buildPushBroadcastPayload, buildPushRouteSelectArgs } from './outbox-push-args.ts';
import type { BncrConnection, OutboxEntry } from './types.ts';

export function buildFileTransferBroadcastPayload(args: {
  frame: Record<string, unknown>;
  messageId: string;
}) {
  return buildPushBroadcastPayload({
    payload: args.frame,
    messageId: args.messageId,
  });
}

export function buildFileTransferRouteSelectArgs(args: {
  entry: OutboxEntry;
  connIds: Iterable<string>;
  routeReason: string;
  recentInboundReachable: boolean;
  owner: BncrConnection | null;
  event: string;
}) {
  return buildPushRouteSelectArgs({
    entry: args.entry,
    connIds: args.connIds,
    routeReason: args.routeReason,
    recentInboundReachable: args.recentInboundReachable,
    owner: args.owner,
    event: args.event,
    kind: 'file-transfer',
  });
}
