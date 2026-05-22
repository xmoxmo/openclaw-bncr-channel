import type { OutboxEntry } from './types.ts';

export type TextPushGuardResult =
  | { ok: false; reason: 'no-gateway-context' }
  | {
      ok: false;
      reason: 'no-active-connection';
      recentInboundReachable: boolean;
    }
  | {
      ok: true;
      connIds: Set<string>;
      recentInboundReachable: boolean;
      routeReason: string;
      ownerConnId?: string;
    };

export function resolveTextPushGuard(args: {
  gatewayContext: unknown;
  entry: OutboxEntry;
  routeSelection: {
    connIds: Iterable<string>;
    recentInboundReachable: boolean;
    routeReason: string;
    ownerConnId?: string;
  };
}): TextPushGuardResult {
  if (!args.gatewayContext) {
    return {
      ok: false,
      reason: 'no-gateway-context',
    };
  }

  const connIds = new Set(args.routeSelection.connIds);
  if (!connIds.size) {
    return {
      ok: false,
      reason: 'no-active-connection',
      recentInboundReachable: args.routeSelection.recentInboundReachable,
    };
  }

  return {
    ok: true,
    connIds,
    recentInboundReachable: args.routeSelection.recentInboundReachable,
    routeReason: args.routeSelection.routeReason,
    ownerConnId: args.routeSelection.ownerConnId,
  };
}
