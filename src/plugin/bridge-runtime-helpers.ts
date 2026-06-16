import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { BncrExtendedDiagnostics } from '../core/extended-diagnostics.ts';
import type {
  BncrAccountRuntimeSnapshot,
  buildIntegratedDiagnostics as buildIntegratedDiagnosticsFromRuntime,
} from '../core/status.ts';
import type { BncrDownlinkHealthSummary, BncrRoute } from '../core/types.ts';
import { OUTBOUND_FLUSH_REASON, OUTBOUND_FLUSH_TRIGGER } from '../messaging/outbound/reasons.ts';
import type { ReplyPayloadInput } from '../messaging/outbound/reply-enqueue.ts';
import type { BncrRuntimeFlags } from '../runtime/outbound-flags.ts';
import type { BncrVerifiedTarget } from './channel-runtime-types.ts';
import type { ConnectionQueueCounters, LeaseEventPayload } from './connection-handlers.ts';
import type { BncrActiveConnectionDebugEntry } from './connection-state.ts';

type DiagnosticsRuntimeStatusInput = Parameters<typeof buildIntegratedDiagnosticsFromRuntime>[0] & {
  running: boolean | undefined;
  channelRoot: string;
};

type DiagnosticsRuntimeStatusOverrides = {
  running: boolean;
  invalidOutboxSessionKeys?: number;
  legacyAccountResidue?: number;
};

type ExtendedDiagnosticsOptions = {
  runtimeStatusInput?: DiagnosticsRuntimeStatusInput;
  integratedDiagnostics?: ReturnType<typeof buildIntegratedDiagnosticsFromRuntime>;
};

export function buildBridgeRuntimeStatusInput<T extends object>(args: {
  runtimeStatusInput: T;
  running: boolean | undefined;
  channelRoot: string;
}): T & { running: boolean | undefined; channelRoot: string } {
  return {
    ...args.runtimeStatusInput,
    running: args.running,
    channelRoot: args.channelRoot,
  };
}

export function buildFlushOnConnectArgs(accountId: string) {
  return {
    accountId,
    trigger: OUTBOUND_FLUSH_TRIGGER.CONNECT,
    reason: OUTBOUND_FLUSH_REASON.WS_ONLINE,
  };
}

export function buildFlushOnActivityArgs(accountId: string) {
  return {
    accountId,
    trigger: OUTBOUND_FLUSH_TRIGGER.ACTIVITY,
    reason: OUTBOUND_FLUSH_REASON.ACTIVITY_HEARTBEAT,
  };
}

export function buildBridgeStatusProjectionRuntime(args: {
  buildAccountQueueCounters: (accountId: string) => ConnectionQueueCounters;
  buildExtendedDiagnostics: (
    accountId: string,
    options?: ExtendedDiagnosticsOptions,
  ) => BncrExtendedDiagnostics;
  buildRuntimeFlags: (accountId?: string) => BncrRuntimeFlags;
  buildRuntimeStatusInput: (
    accountId: string,
    overrides: DiagnosticsRuntimeStatusOverrides,
  ) => Parameters<typeof buildIntegratedDiagnosticsFromRuntime>[0];
  getAccountRuntimeSnapshot: (
    accountId: string,
    runtimeStatusInput: DiagnosticsRuntimeStatusInput,
  ) => BncrAccountRuntimeSnapshot;
  buildIntegratedDiagnostics: (
    accountId: string,
    runtimeStatusInput: DiagnosticsRuntimeStatusInput,
  ) => ReturnType<typeof buildIntegratedDiagnosticsFromRuntime>;
  buildDownlinkHealth: (accountId: string) => BncrDownlinkHealthSummary;
  resolveChannelRoot: () => string;
}) {
  return {
    buildAccountQueueCounters: (accountId: string) => args.buildAccountQueueCounters(accountId),
    buildExtendedDiagnostics: (accountId: string, options?: ExtendedDiagnosticsOptions) =>
      args.buildExtendedDiagnostics(accountId, options),
    buildRuntimeFlags: (accountId?: string) => args.buildRuntimeFlags(accountId),
    buildRuntimeStatusInput: (accountId: string, overrides: DiagnosticsRuntimeStatusOverrides) =>
      buildBridgeRuntimeStatusInput({
        runtimeStatusInput: args.buildRuntimeStatusInput(accountId, overrides),
        running: overrides.running,
        channelRoot: args.resolveChannelRoot(),
      }),
    getAccountRuntimeSnapshot: (
      accountId: string,
      runtimeStatusInput: DiagnosticsRuntimeStatusInput,
    ) => args.getAccountRuntimeSnapshot(accountId, runtimeStatusInput),
    buildIntegratedDiagnostics: (
      accountId: string,
      runtimeStatusInput: DiagnosticsRuntimeStatusInput,
    ) => args.buildIntegratedDiagnostics(accountId, runtimeStatusInput),
    buildDownlinkHealth: (accountId: string) => args.buildDownlinkHealth(accountId),
  };
}

export function buildBridgeDrainTriggers(args: {
  flushPushQueueBestEffort: (args: { accountId: string; trigger: string; reason: string }) => void;
}) {
  return {
    flushOnConnect: (accountId: string) =>
      args.flushPushQueueBestEffort(buildFlushOnConnectArgs(accountId)),
    flushOnActivity: (accountId: string) =>
      args.flushPushQueueBestEffort(buildFlushOnActivityArgs(accountId)),
  };
}

export function buildBridgeLifecycleMarkers(args: {
  markLastActivityAt: () => void;
  markLastAckAt: () => void;
}) {
  return {
    markLastActivityAt: () => args.markLastActivityAt(),
    markLastAckAt: () => args.markLastAckAt(),
  };
}

export function buildInboundSurfaceActivityRuntime(args: {
  markInboundGlobalActivity: () => void;
  incrementInboundEvents: (accountId: string) => void;
  setLastInboundByAccount: (accountId: string, at: number) => void;
  markActivity: (accountId: string, at: number) => void;
}) {
  return {
    markLastInboundAt: (accountId: string) => {
      args.markInboundGlobalActivity();
      args.incrementInboundEvents(accountId);
    },
    setInboundActivity: (accountId: string, at: number) => {
      args.setLastInboundByAccount(accountId, at);
      args.markActivity(accountId, at);
    },
  };
}

export function buildInboundSurfaceConnectionRuntime(args: {
  shouldIgnoreStaleEvent: (args: {
    kind:
      | 'inbound'
      | 'activity'
      | 'ack'
      | 'file.init'
      | 'file.chunk'
      | 'file.complete'
      | 'file.abort';
    payload: LeaseEventPayload;
    accountId: string;
    connId: string;
    clientId?: string;
  }) => boolean;
  observeLease: (
    kind:
      | 'connect'
      | 'inbound'
      | 'activity'
      | 'ack'
      | 'file.init'
      | 'file.chunk'
      | 'file.complete'
      | 'file.abort',
    payload: LeaseEventPayload,
  ) => { stale: boolean };
  matchesTransferOwner: (args: {
    ownerConnId?: string;
    ownerClientId?: string;
    connId: string;
    clientId?: string;
  }) => boolean;
  refreshAcceptedFileTransferLiveState: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    context: GatewayRequestHandlerOptions['context'];
  }) => void;
  refreshLiveConnectionState: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady: boolean;
    preferredForOutbound: boolean;
    inboundOnly: boolean;
    context: GatewayRequestHandlerOptions['context'];
  }) => void;
  isOnline: (accountId: string) => boolean;
  hasRecentInboundReachability: (accountId: string) => boolean;
  getActiveConnectionKey: (accountId: string) => string | null;
  buildActiveConnectionDebugList: (accountId: string) => BncrActiveConnectionDebugEntry[];
}) {
  return {
    shouldIgnoreStaleEvent: (runtimeArgs: Parameters<typeof args.shouldIgnoreStaleEvent>[0]) =>
      args.shouldIgnoreStaleEvent(runtimeArgs),
    observeLease: (
      kind: Parameters<typeof args.observeLease>[0],
      payload: Parameters<typeof args.observeLease>[1],
    ) => args.observeLease(kind, payload),
    matchesTransferOwner: (runtimeArgs: Parameters<typeof args.matchesTransferOwner>[0]) =>
      args.matchesTransferOwner(runtimeArgs),
    refreshAcceptedFileTransferLiveState: (
      runtimeArgs: Parameters<typeof args.refreshAcceptedFileTransferLiveState>[0],
    ) => args.refreshAcceptedFileTransferLiveState(runtimeArgs),
    refreshLiveConnectionState: (
      runtimeArgs: Parameters<typeof args.refreshLiveConnectionState>[0],
    ) => args.refreshLiveConnectionState(runtimeArgs),
    isOnline: (accountId: string) => args.isOnline(accountId),
    hasRecentInboundReachability: (accountId: string) =>
      args.hasRecentInboundReachability(accountId),
    getActiveConnectionKey: (accountId: string) => args.getActiveConnectionKey(accountId),
    buildActiveConnectionDebugList: (accountId: string) =>
      args.buildActiveConnectionDebugList(accountId),
  };
}

export function buildChannelSendTargetRuntime(args: {
  resolveVerifiedTarget: (to: string, accountId: string) => BncrVerifiedTarget;
  rememberSessionRoute: (sessionKey: string, accountId: string, route: BncrRoute) => void;
  enqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: ReplyPayloadInput;
    mediaLocalRoots?: readonly string[];
  }) => Promise<void>;
}) {
  return {
    resolveVerifiedTarget: (to: string, accountId: string) =>
      args.resolveVerifiedTarget(to, accountId),
    rememberSessionRoute: (sessionKey: string, accountId: string, route: BncrRoute) =>
      args.rememberSessionRoute(sessionKey, accountId, route),
    enqueueFromReply: (runtimeArgs: Parameters<typeof args.enqueueFromReply>[0]) =>
      args.enqueueFromReply(runtimeArgs),
  };
}

export function buildFlushBestEffortError(args: {
  accountId?: string;
  trigger?: string;
  reason?: string;
  error: unknown;
  asString: (value: unknown, fallback?: string) => string;
  normalizeAccountId: (accountId: string) => string;
  nextRetryCount: number;
  retryLimit: number;
}) {
  const accountId = args.accountId ? args.normalizeAccountId(args.accountId) : '';
  const reason = args.asString(args.reason || args.trigger || 'flush-error');
  const err =
    args.error && typeof args.error === 'object' && 'message' in args.error
      ? args.asString((args.error as { message?: unknown }).message || 'flush-error')
      : args.asString(args.error || 'flush-error');
  const willRetry = args.nextRetryCount <= args.retryLimit;

  return {
    accountId,
    reason,
    err,
    willRetry,
    retryDisplay: willRetry ? args.nextRetryCount : 'false',
  };
}
