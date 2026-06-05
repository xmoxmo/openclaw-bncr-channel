import { buildPushOkArgs } from './outbox-push-args.ts';
import type { BncrConnection, OutboxEntry } from './types.ts';

export function buildFileTransferPushSuccessArgs(args: {
  entry: OutboxEntry;
  connIds: Iterable<string>;
  owner: BncrConnection | null;
}) {
  return {
    entry: args.entry,
    connIds: args.connIds,
    ownerConnId: args.owner?.connId,
    ownerClientId: args.owner?.clientId,
    clearLastError: true,
  };
}

export function buildFileTransferPushOkArgs(args: {
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
    kind: 'file-transfer',
  });
}
