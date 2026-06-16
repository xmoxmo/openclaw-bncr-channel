import type { BncrConnection } from '../core/types.ts';
import type { ChannelAccountWorkerHandle } from '../runtime/status-worker.ts';
import {
  buildStatusWorkerActiveConnections,
  buildStatusWorkerLastEventAt,
} from './bridge-surface-helpers.ts';

export function createBncrBridgeStatusWorkerFacade(runtime: {
  workers: Map<string, ChannelAccountWorkerHandle>;
  bridgeId: string;
  isOnline: (accountId: string) => boolean;
  hasRecentInboundReachability: (accountId: string) => boolean;
  lastActivityByAccount: Map<string, number>;
  lastInboundByAccount: Map<string, number>;
  lastOutboundByAccount: Map<string, number>;
  getActiveConnectionKey: (accountId: string) => string | null;
  connectionsValues: () => Iterable<BncrConnection>;
  buildStatusMeta: (accountId: string) => {
    pending?: number;
    pendingAdmissionsCount?: number;
    pendingAdmissions?: unknown[];
    deadLetter?: number;
    lastSessionScope?: string | null;
    lastSessionAt?: number | null;
    lastSessionAgo?: string | null;
    lastActivityAt?: number | null;
    lastActivityAgo?: string | null;
    lastInboundAt?: number | null;
    lastInboundAgo?: string | null;
    lastOutboundAt?: number | null;
    lastOutboundAgo?: string | null;
    diagnostics?: Record<string, unknown>;
  };
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logInfoDedup: (
    scope: string | undefined,
    message: string,
    options: { key: string; sig: string; debugOnly?: boolean; windowMs?: number },
  ) => void;
}) {
  return {
    workers: runtime.workers,
    bridgeId: runtime.bridgeId,
    hooks: {
      isOnline: (accountId: string) => runtime.isOnline(accountId),
      hasRecentInboundReachability: (accountId: string) =>
        runtime.hasRecentInboundReachability(accountId),
      getLastActivityAt: (accountId: string, previous: { lastEventAt?: number | null }) =>
        buildStatusWorkerLastEventAt({
          accountId,
          previous,
          lastActivityByAccount: runtime.lastActivityByAccount,
          lastInboundByAccount: runtime.lastInboundByAccount,
          lastOutboundByAccount: runtime.lastOutboundByAccount,
        }),
      getActiveConnectionKey: (accountId: string) => runtime.getActiveConnectionKey(accountId),
      getActiveConnections: (accountId: string) =>
        buildStatusWorkerActiveConnections({
          accountId,
          connections: runtime.connectionsValues(),
        }),
      buildStatusMeta: (accountId: string) => runtime.buildStatusMeta(accountId),
      logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) =>
        runtime.logInfo(scope, message, options),
      logInfoDedup: (
        scope: string | undefined,
        message: string,
        options: { key: string; sig: string; debugOnly?: boolean; windowMs?: number },
      ) => runtime.logInfoDedup(scope, message, options),
    },
  };
}
