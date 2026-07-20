/*
 * Intentionally separate from outbox-text-push-guards.ts.
 * File transfer guard has distinct output type (includes owner/mediaUrl)
 * and extra mediaUrl validation that text push doesn't need.
 * Merging would add unnecessary conditional branches.
 */
import type { BncrConnection, OutboxEntry } from './types.ts';

export type FileTransferGuardResult =
  | { ok: false; reason: 'no-gateway-context'; lastError: 'gateway context unavailable' }
  | {
      ok: false;
      reason: 'no-active-connection';
      lastError: 'no active bncr client for file chunk transfer';
      recentInboundReachable: boolean;
    }
  | { ok: false; reason: 'media-url-missing'; lastError: 'file transfer mediaUrl missing' }
  | {
      ok: true;
      owner: BncrConnection | null;
      connIds: Set<string>;
      recentInboundReachable: boolean;
      routeReason: string;
      mediaUrl: string;
    };

export function resolveFileTransferGuard(args: {
  gatewayContext: unknown;
  entry: OutboxEntry;
  owner: BncrConnection | null;
  routeSelection: {
    connIds: Iterable<string>;
    recentInboundReachable: boolean;
    routeReason: string;
  };
  mediaUrl: string;
}): FileTransferGuardResult {
  if (!args.gatewayContext) {
    return {
      ok: false,
      reason: 'no-gateway-context',
      lastError: 'gateway context unavailable',
    };
  }

  const connIds = new Set(args.routeSelection.connIds);
  if (!connIds.size) {
    return {
      ok: false,
      reason: 'no-active-connection',
      lastError: 'no active bncr client for file chunk transfer',
      recentInboundReachable: args.routeSelection.recentInboundReachable,
    };
  }

  if (!args.mediaUrl) {
    return {
      ok: false,
      reason: 'media-url-missing',
      lastError: 'file transfer mediaUrl missing',
    };
  }

  return {
    ok: true,
    owner: args.owner,
    connIds,
    recentInboundReachable: args.routeSelection.recentInboundReachable,
    routeReason: args.routeSelection.routeReason,
    mediaUrl: args.mediaUrl,
  };
}
