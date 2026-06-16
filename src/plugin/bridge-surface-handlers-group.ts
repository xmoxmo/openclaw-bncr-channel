import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { BncrExtendedDiagnostics } from '../core/extended-diagnostics.ts';
import type {
  BncrAccountRuntimeSnapshot,
  buildIntegratedDiagnostics as buildIntegratedDiagnosticsFromRuntime,
} from '../core/status.ts';
import type {
  BncrDeadLetterDiagnosticsSummary,
  BncrDownlinkHealthSummary,
  FileSendTransferState,
  OutboxEntry,
} from '../core/types.ts';
import type { BncrRuntimeFlags } from '../runtime/outbound-flags.ts';
import {
  createBncrBridgeDiagnosticsHandlersComponent,
  createBncrConnectionHandlersComponent,
} from './channel-components.ts';
import type { ConnectionQueueCounters } from './connection-handlers.ts';

type DiagnosticsRuntimeStatusInput = Parameters<typeof buildIntegratedDiagnosticsFromRuntime>[0] & {
  running: boolean | undefined;
  channelRoot: string;
};

type DiagnosticsComponentRuntime = Parameters<
  typeof createBncrBridgeDiagnosticsHandlersComponent
>[0];
type ConnectionComponentRuntime = Parameters<typeof createBncrConnectionHandlersComponent>[0];
type DiagnosticsExtendedArgs = Parameters<
  DiagnosticsComponentRuntime['buildExtendedDiagnostics']
>[1];

export function createBncrBridgeSurfaceHandlersGroup(runtime: {
  bridgeId: string;
  gatewayPid: number;
  pushEvent: string;
  bridgeVersion: number;
  getApi: DiagnosticsComponentRuntime['getApi'];
  channelId: string;
  asString: (value: unknown, fallback?: string) => string;
  now: () => number;
  finiteNonNegativeNumberOrNull: (value: unknown) => number | null;
  syncDebugFlag: () => Promise<void>;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  normalizeAccountId: (value: string) => string;
  pluginRoot: string;
  buildAccountQueueCounters: (accountId: string) => ConnectionQueueCounters;
  buildExtendedDiagnostics: (
    accountId: string,
    args?: DiagnosticsExtendedArgs,
  ) => BncrExtendedDiagnostics;
  buildRuntimeFlags: (accountId: string) => BncrRuntimeFlags;
  buildRuntimeStatusInput: (
    accountId: string,
    overrides: {
      running: boolean;
      invalidOutboxSessionKeys?: number;
      legacyAccountResidue?: number;
    },
  ) => DiagnosticsRuntimeStatusInput;
  getAccountRuntimeSnapshot: (
    accountId: string,
    runtimeStatusInput: DiagnosticsRuntimeStatusInput,
  ) => BncrAccountRuntimeSnapshot;
  buildIntegratedDiagnostics: (
    accountId: string,
    runtimeStatusInput: DiagnosticsRuntimeStatusInput,
  ) => ReturnType<typeof buildIntegratedDiagnosticsFromRuntime>;
  buildDownlinkHealth: (accountId: string) => BncrDownlinkHealthSummary;
  isPrimaryConnection: (accountId: string, clientId?: string) => boolean;
  acceptConnection: () => { leaseId: string; connectionEpoch: number; acceptedAt: number };
  refreshLiveConnectionState: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady: boolean;
    preferredForOutbound: boolean;
    inboundOnly: boolean;
    context: GatewayRequestHandlerOptions['context'];
  }) => void;
  flushOnConnect: (accountId: string) => void;
  flushOnActivity: (accountId: string) => void;
  shouldIgnoreStaleEvent: (args: {
    kind:
      | 'inbound'
      | 'activity'
      | 'ack'
      | 'file.init'
      | 'file.chunk'
      | 'file.complete'
      | 'file.abort';
    payload: { leaseId?: string; connectionEpoch?: number };
    accountId: string;
    connId: string;
    clientId?: string;
  }) => boolean;
  incrementConnectEvents: (accountId: string) => void;
  incrementActivityEvents: (accountId: string) => void;
  incrementAckEvents: (accountId: string) => void;
  markLastActivityAt: () => void;
  markLastAckAt: () => void;
  messageAckWaiterCount: () => number;
  fileAckWaiterCount: () => number;
  prepareAckHandling: (args: {
    params: GatewayRequestHandlerOptions['params'];
    respond: GatewayRequestHandlerOptions['respond'];
    client: GatewayRequestHandlerOptions['client'];
    context: GatewayRequestHandlerOptions['context'];
  }) => ReturnType<ConnectionComponentRuntime['prepareAckHandling']>;
  handleAckOutcome: (
    args: {
      params: GatewayRequestHandlerOptions['params'];
      respond: GatewayRequestHandlerOptions['respond'];
    } & NonNullable<ReturnType<ConnectionComponentRuntime['prepareAckHandling']>>,
  ) => void;
  fileSendTransfers: Map<string, FileSendTransferState>;
  hasFileAckWaiter: (key: string) => boolean;
  fileAckKey: (transferId: string, stage: string, chunkIndex?: number) => string;
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
    payload: { leaseId?: string; connectionEpoch?: number },
  ) => { stale: boolean };
  tryAdoptTransferOwner: (args: {
    accountId: string;
    transfer: FileSendTransferState | undefined;
    connId: string;
    clientId?: string;
  }) => boolean;
  refreshAcceptedFileTransferLiveState: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    context: GatewayRequestHandlerOptions['context'];
  }) => void;
  resolveFileAck: (args: {
    transferId: string;
    stage: string;
    chunkIndex?: number;
    payload: {
      ok: boolean;
      transferId: string;
      stage: string;
      path: string;
      errorCode: string;
      errorMessage: string;
    };
    ok: boolean;
  }) => void;
  countInvalidOutboxSessionKeys: (accountId: string) => number;
  countLegacyAccountResidue: (accountId: string) => number;
  activeConnectionCount: (accountId: string) => number;
  getMessageAckWaiterCount: () => number;
  getFileAckWaiterCount: () => number;
  filterDeadLetterEntries: (args: {
    accountId: string;
    reason: string | null;
    olderThan: number | null;
  }) => OutboxEntry[];
  listDeadLetterEntries: () => OutboxEntry[];
  buildDeadLetterDiagnostics: (accountId: string) => BncrDeadLetterDiagnosticsSummary;
  replaceDeadLetterEntries: (nextEntries: OutboxEntry[]) => void;
  scheduleSave: () => void;
  logDeadLetterSummary: (accountId: string, args: { force: boolean; source: string }) => void;
}) {
  const connectionHandlers = createBncrConnectionHandlersComponent({
    bridgeId: runtime.bridgeId,
    gatewayPid: runtime.gatewayPid,
    pushEvent: runtime.pushEvent,
    bridgeVersion: runtime.bridgeVersion,
    asString: runtime.asString,
    now: runtime.now,
    finiteNonNegativeNumberOrNull: runtime.finiteNonNegativeNumberOrNull,
    syncDebugFlag: runtime.syncDebugFlag,
    logInfo: runtime.logInfo,
    logWarn: runtime.logWarn,
    normalizeAccountId: runtime.normalizeAccountId,
    buildAccountQueueCounters: runtime.buildAccountQueueCounters,
    buildExtendedDiagnostics: runtime.buildExtendedDiagnostics,
    buildRuntimeFlags: runtime.buildRuntimeFlags,
    isPrimaryConnection: runtime.isPrimaryConnection,
    acceptConnection: runtime.acceptConnection,
    refreshLiveConnectionState: runtime.refreshLiveConnectionState,
    flushOnConnect: runtime.flushOnConnect,
    flushOnActivity: runtime.flushOnActivity,
    shouldIgnoreStaleEvent: runtime.shouldIgnoreStaleEvent,
    incrementConnectEvents: runtime.incrementConnectEvents,
    incrementActivityEvents: runtime.incrementActivityEvents,
    incrementAckEvents: runtime.incrementAckEvents,
    markLastActivityAt: runtime.markLastActivityAt,
    markLastAckAt: runtime.markLastAckAt,
    messageAckWaiterCount: runtime.messageAckWaiterCount,
    fileAckWaiterCount: runtime.fileAckWaiterCount,
    prepareAckHandling: runtime.prepareAckHandling,
    handleAckOutcome: runtime.handleAckOutcome,
    fileSendTransfers: runtime.fileSendTransfers,
    hasFileAckWaiter: runtime.hasFileAckWaiter,
    fileAckKey: runtime.fileAckKey,
    observeLease: runtime.observeLease,
    tryAdoptTransferOwner: runtime.tryAdoptTransferOwner,
    refreshAcceptedFileTransferLiveState: runtime.refreshAcceptedFileTransferLiveState,
    resolveFileAck: runtime.resolveFileAck,
  });

  const diagnosticsHandlers = createBncrBridgeDiagnosticsHandlersComponent({
    getApi: runtime.getApi,
    channelId: runtime.channelId,
    asString: runtime.asString,
    now: runtime.now,
    countInvalidOutboxSessionKeys: runtime.countInvalidOutboxSessionKeys,
    countLegacyAccountResidue: runtime.countLegacyAccountResidue,
    pluginRoot: runtime.pluginRoot,
    buildRuntimeStatusInput: runtime.buildRuntimeStatusInput,
    getAccountRuntimeSnapshot: runtime.getAccountRuntimeSnapshot,
    buildIntegratedDiagnostics: runtime.buildIntegratedDiagnostics,
    buildExtendedDiagnostics: runtime.buildExtendedDiagnostics,
    buildDownlinkHealth: runtime.buildDownlinkHealth,
    buildRuntimeFlags: runtime.buildRuntimeFlags,
    activeConnectionCount: runtime.activeConnectionCount,
    getMessageAckWaiterCount: runtime.getMessageAckWaiterCount,
    getFileAckWaiterCount: runtime.getFileAckWaiterCount,
    filterDeadLetterEntries: runtime.filterDeadLetterEntries,
    listDeadLetterEntries: runtime.listDeadLetterEntries,
    buildDeadLetterDiagnostics: runtime.buildDeadLetterDiagnostics,
    replaceDeadLetterEntries: runtime.replaceDeadLetterEntries,
    scheduleSave: runtime.scheduleSave,
    logDeadLetterSummary: runtime.logDeadLetterSummary,
  });

  return {
    connectionHandlers,
    diagnosticsHandlers,
  };
}
