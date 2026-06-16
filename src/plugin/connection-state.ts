import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import { normalizeAccountId } from '../core/accounts.ts';
import {
  applyOutboundCapability,
  buildCapabilitySnapshot,
  clearOutboundCapability,
  findCapabilityConnection,
} from '../core/connection-capability.ts';
import {
  getRevalidatedAttemptReason,
  hasAlternativeLiveConnection as hasAlternativeLiveConnectionFromRuntime,
  hasRecentInboundReachability as hasRecentInboundReachabilityFromRuntime,
  isRecentlyReachableConn as isRecentlyReachableConnFromRuntime,
  resolveRecentInboundConnIds as resolveRecentInboundConnIdsFromRuntime,
} from '../core/connection-reachability.ts';
import type { BncrConnection, OutboxEntry } from '../core/types.ts';
import {
  buildConnectionCapabilityDebugPayload,
  buildConnectionCapabilityDebugSig,
  buildConnectionDegradePayload,
  buildConnectionDegradeSkipPayload,
  buildConnectionPromotePayload,
  buildSeenConnection,
  resolveSeenConnectionPromoteReason,
} from './connection-state-helpers.ts';

export type BncrActiveConnectionDebugEntry = {
  accountId: string;
  connId: string;
  clientId?: string;
  connectedAt: number;
  lastSeenAt: number;
  outboundReadyUntil?: number | null;
  preferredForOutboundUntil?: number | null;
  inboundOnly?: boolean;
};

type BncrCapabilityConnection = BncrConnection & {
  outboundReadyUntil?: number;
  preferredForOutboundUntil?: number;
  inboundOnly?: boolean;
};

// This module owns the live connection model used by outbound routing:
// seen/active state, outbound capability, recent inbound reachability, and
// degradation when ACK / push signals prove a connection is no longer usable.

function logSeenConnectionPromotion(args: {
  runtime: Pick<
    BncrConnectionStateRuntime,
    'bridgeId' | 'buildActiveConnectionDebugList' | 'logInfo'
  >;
  accountId: string;
  reason: string;
  previousActiveKey: string | null;
  previousActiveConn: BncrConnection | null;
  nextActiveKey: string;
  nextActiveConn: BncrConnection;
}) {
  args.runtime.logInfo(
    'connection',
    `seen:promote ${JSON.stringify(
      buildConnectionPromotePayload({
        bridgeId: args.runtime.bridgeId,
        accountId: args.accountId,
        reason: args.reason,
        previousActiveKey: args.previousActiveKey,
        previousActiveConn: args.previousActiveConn,
        nextActiveKey: args.nextActiveKey,
        nextActiveConn: args.nextActiveConn,
        activeConnections: args.runtime.buildActiveConnectionDebugList(args.accountId, {
          includeOutboundState: true,
        }),
      }),
    )}`,
    { debugOnly: true },
  );
}

export type TransferOwnerState = {
  ownerConnId?: string;
  ownerClientId?: string;
};

export type BncrConnectionStateRuntime = {
  bridgeId: string;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  connectTtlMs: number;
  recentInboundSendWindowMs: number;
  outboundReadyTtlMs: number;
  preferredOutboundTtlMs: number;
  connections: Map<string, BncrConnection>;
  activeConnectionByAccount: Map<string, string>;
  lastInboundByAccount: Map<string, number>;
  lastActivityByAccount: Map<string, number>;
  gcTransientState: () => void;
  connectionKey: (accountId: string, clientId?: string) => string;
  buildActiveConnectionDebugList: (
    accountId: string,
    options?: { includeOutboundState?: boolean },
  ) => BncrActiveConnectionDebugEntry[];
  rememberGatewayContext: (context: GatewayRequestHandlerOptions['context']) => void;
  markActivity: (accountId: string, at?: number) => void;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logInfoDedupJson: (
    scope: string,
    label: string,
    payload: unknown,
    options?: { key?: string; sig?: string; debugOnly?: boolean },
  ) => void;
};

export function createBncrConnectionState(runtime: BncrConnectionStateRuntime) {
  // 1) Reachability/read helpers
  // 2) Live-state refresh entrypoints
  // 3) Canonical live-connection mutations
  // 4) Outbound capability degradation / online probes
  //
  // Keep this order stable. The later mutation paths depend on the earlier
  // read-model helpers, and that dependency direction makes the file easier to
  // scan than grouping everything by event type.

  // Reachability helpers are grouped first because they are consumed by both
  // ownership adoption and outbound route-selection decisions later in the file.

  const hasRecentInboundReachability = (accountId: string): boolean => {
    const acc = normalizeAccountId(accountId);
    return hasRecentInboundReachabilityFromRuntime({
      now: runtime.now(),
      windowMs: runtime.recentInboundSendWindowMs,
      lastInboundAt: runtime.lastInboundByAccount.get(acc) || 0,
      lastActivityAt: runtime.lastActivityByAccount.get(acc) || 0,
    });
  };

  const resolveRecentInboundConnIds = (accountId: string): Set<string> => {
    const acc = normalizeAccountId(accountId);
    return resolveRecentInboundConnIdsFromRuntime({
      accountId: acc,
      now: runtime.now(),
      connectTtlMs: runtime.connectTtlMs,
      recentInboundReachable: hasRecentInboundReachability(acc),
      connections: runtime.connections.values(),
    });
  };

  const isRecentlyReachableConn = (
    accountId: string,
    connId?: string,
    clientId?: string,
  ): boolean => {
    const acc = normalizeAccountId(accountId);
    const activeKey = runtime.activeConnectionByAccount.get(acc);
    const active = activeKey ? runtime.connections.get(activeKey) || null : null;
    return isRecentlyReachableConnFromRuntime({
      accountId: acc,
      connId,
      clientId,
      recentConnIds: resolveRecentInboundConnIds(acc),
      activeConnection: active,
    });
  };

  const isRevalidatedAttemptedConn = (entry: OutboxEntry, connId: string): boolean => {
    const acc = normalizeAccountId(entry.accountId);
    const revalidated = getRevalidatedAttemptReason({
      entry,
      connId,
      accountId: acc,
      now: runtime.now(),
      connectTtlMs: runtime.connectTtlMs,
      recentInboundReachable: hasRecentInboundReachability(acc),
      connections: runtime.connections.values(),
    });
    if (!revalidated) return false;

    runtime.logInfo(
      'outbox',
      `revalidated-retry ${JSON.stringify({
        messageId: entry.messageId,
        accountId: acc,
        connId: String(connId || '').trim(),
        ...revalidated,
      })}`,
      { debugOnly: true },
    );
    return true;
  };

  const tryAdoptTransferOwner = (args: {
    accountId: string;
    transfer: TransferOwnerState | undefined;
    connId: string;
    clientId?: string;
  }): boolean => {
    const { accountId, transfer, connId, clientId } = args;
    if (!transfer) return false;
    if (!hasRecentInboundReachability(accountId)) return false;
    if (!isRecentlyReachableConn(accountId, connId, clientId)) return false;

    transfer.ownerConnId = connId;
    transfer.ownerClientId = runtime.asString(clientId || '').trim() || undefined;
    return true;
  };

  // Live-state refresh entrypoints -----------------------------------------
  // These are the external-facing refresh paths used by connect/activity/file
  // transfer acceptance before deeper capability or routing decisions.

  // Live-state refresh is the steady-state entrypoint used by connection and
  // activity events before any explicit routing/capability mutations happen.

  const refreshAcceptedFileTransferLiveState = (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    context: GatewayRequestHandlerOptions['context'];
  }) => {
    const { accountId, connId, clientId, context } = args;
    runtime.rememberGatewayContext(context);
    markSeen(accountId, connId, clientId);
    runtime.markActivity(accountId);
  };

  const refreshLiveConnectionState = (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady: boolean;
    preferredForOutbound: boolean;
    inboundOnly: boolean;
    context: GatewayRequestHandlerOptions['context'];
  }) => {
    const {
      accountId,
      connId,
      clientId,
      outboundReady,
      preferredForOutbound,
      inboundOnly,
      context,
    } = args;
    refreshAcceptedFileTransferLiveState({
      accountId,
      connId,
      clientId,
      context,
    });
    markOutboundCapability({
      accountId,
      connId,
      clientId,
      outboundReady,
      preferredForOutbound,
      inboundOnly,
    });
  };

  // The remaining helpers mutate the canonical live-connection model used by
  // route selection, ownership recovery, and capability degradation.

  // Canonical live-connection mutations ------------------------------------

  const markSeen = (accountId: string, connId: string, clientId?: string) => {
    runtime.gcTransientState();

    const acc = normalizeAccountId(accountId);
    const key = runtime.connectionKey(acc, clientId);
    const t = runtime.now();
    const prev = runtime.connections.get(key) as BncrCapabilityConnection | undefined;
    const previousActiveKey = runtime.activeConnectionByAccount.get(acc) || null;
    const previousActiveConn = previousActiveKey
      ? runtime.connections.get(previousActiveKey) || null
      : null;

    const nextConn = buildSeenConnection({
      accountId: acc,
      connId,
      clientId: runtime.asString(clientId || '').trim() || undefined,
      nowMs: t,
      previous: prev || null,
    });

    runtime.connections.set(key, nextConn);
    const connectionSeenPayload = {
      bridge: runtime.bridgeId,
      accountId: acc,
      connId,
      clientId: nextConn.clientId,
      connectedAt: nextConn.connectedAt,
      lastSeenAt: nextConn.lastSeenAt,
      outboundReadyUntil: nextConn.outboundReadyUntil || null,
      preferredForOutboundUntil: nextConn.preferredForOutboundUntil || null,
      inboundOnly: nextConn.inboundOnly === true,
    };
    const connectionSeenSig = JSON.stringify({
      bridge: runtime.bridgeId,
      accountId: acc,
      connId,
      clientId: nextConn.clientId || null,
      inboundOnly: nextConn.inboundOnly === true,
      outboundReadyActive: Number(nextConn.outboundReadyUntil || 0) > t,
      preferredForOutboundActive: Number(nextConn.preferredForOutboundUntil || 0) > t,
    });
    runtime.logInfoDedupJson('connection', 'seen', connectionSeenPayload, {
      key: `connection-seen:${acc}:${nextConn.clientId || connId}`,
      sig: connectionSeenSig,
      debugOnly: true,
    });

    const current = runtime.activeConnectionByAccount.get(acc) || null;
    const curConn = current ? runtime.connections.get(current) || null : null;
    const promoteReason = resolveSeenConnectionPromoteReason({
      currentActiveKey: current,
      currentConnection: curConn,
      nowMs: t,
      connectTtlMs: runtime.connectTtlMs,
    });

    if (promoteReason === 'no-current-active') {
      runtime.activeConnectionByAccount.set(acc, key);
      logSeenConnectionPromotion({
        runtime,
        accountId: acc,
        reason: promoteReason,
        previousActiveKey,
        previousActiveConn,
        nextActiveKey: key,
        nextActiveConn: nextConn,
      });
      return;
    }

    if (promoteReason) {
      runtime.activeConnectionByAccount.set(acc, key);
      logSeenConnectionPromotion({
        runtime,
        accountId: acc,
        reason: promoteReason,
        previousActiveKey,
        previousActiveConn,
        nextActiveKey: key,
        nextActiveConn: nextConn,
      });
    }
  };

  // Capability updates keep the live routing model in sync with what the
  // client claims it can currently do for outbound delivery.

  // Outbound capability / degradation --------------------------------------

  const markOutboundCapability = (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady?: boolean;
    preferredForOutbound?: boolean;
    inboundOnly?: boolean;
    at?: number;
  }) => {
    const acc = normalizeAccountId(args.accountId);
    const key = runtime.connectionKey(acc, args.clientId);
    const t = Number(args.at || runtime.now());
    const current = runtime.connections.get(key) as BncrCapabilityConnection | undefined;
    if (!current || current.connId !== args.connId) return;

    const next = applyOutboundCapability({
      connection: current,
      at: t,
      outboundReadyTtlMs: runtime.outboundReadyTtlMs,
      preferredOutboundTtlMs: runtime.preferredOutboundTtlMs,
      outboundReady: args.outboundReady,
      preferredForOutbound: args.preferredForOutbound,
      inboundOnly: args.inboundOnly,
    });

    runtime.connections.set(key, next);
    const { payload: connectionCapabilityPayload, snapshot } =
      buildConnectionCapabilityDebugPayload({
        bridgeId: runtime.bridgeId,
        accountId: acc,
        connection: next,
        outboundReady: args.outboundReady === true,
        preferredForOutbound: args.preferredForOutbound === true,
      });
    const connectionCapabilitySig = buildConnectionCapabilityDebugSig({
      bridgeId: runtime.bridgeId,
      accountId: acc,
      connection: next,
      outboundReady: args.outboundReady === true,
      preferredForOutbound: args.preferredForOutbound === true,
      snapshot,
      nowMs: t,
    });
    runtime.logInfoDedupJson('connection', 'capability', connectionCapabilityPayload, {
      key: `connection-capability:${acc}:${next.clientId || next.connId}`,
      sig: connectionCapabilitySig,
      debugOnly: true,
    });
  };

  const hasAlternativeLiveConnection = (
    accountId: string,
    currentConnId?: string,
    currentClientId?: string,
  ): boolean => {
    const acc = normalizeAccountId(accountId);
    return hasAlternativeLiveConnectionFromRuntime({
      accountId: acc,
      now: runtime.now(),
      connectTtlMs: runtime.connectTtlMs,
      currentConnId,
      currentClientId,
      connections: runtime.connections.values(),
    });
  };

  // Degradation is the corrective path after push/ACK evidence says the current
  // outbound capability should no longer be trusted for routing decisions.

  const degradeOutboundCapability = (args: {
    accountId: string;
    connId?: string;
    clientId?: string;
    reason: string;
    at?: number;
  }) => {
    const acc = normalizeAccountId(args.accountId);
    const t = Number(args.at || runtime.now());
    const hasAlternative = hasAlternativeLiveConnection(acc, args.connId, args.clientId);
    const currentKey = runtime.activeConnectionByAccount.get(acc) || null;
    const matched = findCapabilityConnection({
      accountId: acc,
      connId: args.connId,
      clientId: args.clientId,
      connections: runtime.connections.entries(),
    });

    if (!matched) return;

    const before = buildCapabilitySnapshot(matched.connection);

    if (!hasAlternative) {
      runtime.logInfo(
        'connection',
        `outbound-degrade skip ${JSON.stringify(
          buildConnectionDegradeSkipPayload({
            bridgeId: runtime.bridgeId,
            accountId: acc,
            connection: matched.connection,
            reason: args.reason,
            at: t,
            currentActiveKey: currentKey,
            degradedKey: matched.key,
            before,
          }),
        )}`,
        { debugOnly: true },
      );
      return;
    }

    const next = clearOutboundCapability(matched.connection);
    runtime.connections.set(matched.key, next);

    runtime.logInfo(
      'connection',
      `outbound-degrade ${JSON.stringify(
        buildConnectionDegradePayload({
          bridgeId: runtime.bridgeId,
          accountId: acc,
          connection: next,
          reason: args.reason,
          at: t,
          currentActiveKey: currentKey,
          degradedKey: matched.key,
          before,
          after: buildCapabilitySnapshot(next),
        }),
      )}`,
      { debugOnly: true },
    );
  };

  // Online/read-model helpers ----------------------------------------------
  // These stay at the end because they are pure projections over the runtime
  // maps after all mutation logic above has established the current state.

  const isOnline = (accountId: string): boolean => {
    const acc = normalizeAccountId(accountId);
    const t = runtime.now();
    for (const c of runtime.connections.values()) {
      if (c.accountId !== acc) continue;
      if (t - c.lastSeenAt <= runtime.connectTtlMs) return true;
    }
    return false;
  };

  const activeConnectionCount = (accountId: string): number => {
    const acc = normalizeAccountId(accountId);
    const t = runtime.now();
    let n = 0;
    for (const c of runtime.connections.values()) {
      if (c.accountId !== acc) continue;
      if (t - c.lastSeenAt <= runtime.connectTtlMs) n += 1;
    }
    return n;
  };

  return {
    hasRecentInboundReachability,
    resolveRecentInboundConnIds,
    isRecentlyReachableConn,
    isRevalidatedAttemptedConn,
    tryAdoptTransferOwner,
    refreshAcceptedFileTransferLiveState,
    refreshLiveConnectionState,
    markSeen,
    markOutboundCapability,
    hasAlternativeLiveConnection,
    degradeOutboundCapability,
    isOnline,
    activeConnectionCount,
  };
}
