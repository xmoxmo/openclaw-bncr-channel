import {
  buildPushBroadcastPayload,
  buildPushOkArgs,
  buildPushRouteSelectArgs,
} from './outbox-push-args.ts';
import type { BncrConnection, OutboxEntry } from './types.ts';

export function buildTextPushBroadcastPayload(args: {
  payload: Record<string, unknown>;
  messageId: string;
}) {
  return buildPushBroadcastPayload({
    payload: args.payload,
    messageId: args.messageId,
  });
}

export function buildTextPushRouteSelectArgs(args: {
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
  });
}

export function buildTextPushSuccessArgs(args: {
  entry: OutboxEntry;
  connIds: Iterable<string>;
  ownerConnId?: string;
  ownerClientId?: string;
}) {
  return {
    entry: args.entry,
    connIds: args.connIds,
    ownerConnId: args.ownerConnId,
    ownerClientId: args.ownerClientId,
  };
}

export function buildTextPushOkArgs(args: {
  entry: OutboxEntry;
  connIds: Iterable<string>;
  recentInboundReachable: boolean;
  event: string;
}) {
  return buildPushOkArgs({
    entry: args.entry,
    connIds: args.connIds,
    recentInboundReachable: args.recentInboundReachable,
    event: args.event,
  });
}
