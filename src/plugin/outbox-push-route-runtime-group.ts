import type { BncrConnection, OutboxEntry } from '../core/types.ts';
import { createBncrOutboxPush } from './outbox-push.ts';
import { createBncrOutboxRoute } from './outbox-route.ts';

export function createBncrOutboxPushRouteRuntimeGroup(runtime: {
  bridgeId: string;
  pushEvent: string;
  now: () => number;
  connectTtlMs: number;
  finiteNumberOr: (value: unknown, fallback: number) => number;
  outboxSize: () => number;
  gatewayBroadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
  ) => void;
  recordOutboxPushSuccess: (args: {
    entry: OutboxEntry;
    connIds: Iterable<string>;
    ownerConnId?: string;
    ownerClientId?: string;
  }) => void;
  recordOutboxPushFailure: (args: {
    entry: OutboxEntry;
    error: unknown;
    fallbackError: string;
    persist?: boolean;
  }) => void;
  recordOutboxPrePushFailure: (args: {
    entry: OutboxEntry;
    lastError: string;
    persist?: boolean;
  }) => void;
  recordPrePushGuardSkip: (args: { accountId: string; reason: string }) => void;
  moveToDeadLetter: (entry: OutboxEntry, reason: string) => void;
  activeConnectionCount: (accountId: string) => number;
  connections: Map<string, BncrConnection>;
  connectionsValues: () => Iterable<BncrConnection>;
  activeConnectionByAccount: Map<string, string>;
  resolveRecentInboundConnIds: (accountId: string) => Set<string>;
  connectionKey: (accountId: string, clientId?: string) => string;
  isRetryableFileTransferError: (value: unknown) => boolean;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  buildActiveConnectionDebugList: (
    accountId: string,
    options?: { includeOutboundState?: boolean },
  ) => unknown;
}) {
  const outboxPush = createBncrOutboxPush({
    pushEvent: runtime.pushEvent,
    outboxSize: runtime.outboxSize,
    gatewayBroadcastToConnIds: runtime.gatewayBroadcastToConnIds,
    recordOutboxPushSuccess: runtime.recordOutboxPushSuccess,
    recordOutboxPushFailure: runtime.recordOutboxPushFailure,
    recordOutboxPrePushFailure: runtime.recordOutboxPrePushFailure,
    recordPrePushGuardSkip: runtime.recordPrePushGuardSkip,
    moveToDeadLetter: runtime.moveToDeadLetter,
    activeConnectionCount: runtime.activeConnectionCount,
    connectionsValues: runtime.connectionsValues,
    isRetryableFileTransferError: runtime.isRetryableFileTransferError,
    logInfo: runtime.logInfo,
  });

  const outboxRoute = createBncrOutboxRoute({
    bridgeId: runtime.bridgeId,
    now: runtime.now,
    connectTtlMs: runtime.connectTtlMs,
    finiteNumberOr: runtime.finiteNumberOr,
    connections: runtime.connections,
    activeConnectionByAccount: runtime.activeConnectionByAccount,
    resolveRecentInboundConnIds: runtime.resolveRecentInboundConnIds,
    connectionKey: runtime.connectionKey,
    logInfo: runtime.logInfo,
    buildActiveConnectionDebugList: runtime.buildActiveConnectionDebugList,
  });

  return {
    outboxPush,
    outboxRoute,
  };
}
