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
import type { createBncrBridgeDiagnosticsHandlersComponent } from './channel-components.ts';
import type {
  ConnectionQueueCounters,
  FileAckPayload,
  LeaseEventPayload,
  PreparedAckHandling,
} from './connection-handlers.ts';

type DiagnosticsRuntimeStatusInput = Parameters<typeof buildIntegratedDiagnosticsFromRuntime>[0] & {
  running: boolean | undefined;
  channelRoot: string;
};

type DiagnosticsRuntimeStatusOverrides = {
  running: boolean;
  invalidOutboxSessionKeys?: number;
  legacyAccountResidue?: number;
};

// Status/diagnostics-side wiring catalog.
//
// Order is intentional:
// 1) gateway-adjacent diagnostics host surfaces
// 2) persistence/status read-model slices
// 3) diagnostics assembly slices

export function buildBncrBridgeSurfaceHandlersRuntime(deps: {
  bridgeId: string;
  gatewayPid: number;
  pushEvent: string;
  bridgeVersion: number;
  getApi: Parameters<typeof createBncrBridgeDiagnosticsHandlersComponent>[0]['getApi'];
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
    args?: Record<string, unknown>,
  ) => BncrExtendedDiagnostics;
  buildRuntimeFlags: (accountId: string) => BncrRuntimeFlags;
  buildRuntimeStatusInput: (
    accountId: string,
    overrides: DiagnosticsRuntimeStatusOverrides,
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
      | 'activity'
      | 'ack'
      | 'file.init'
      | 'file.chunk'
      | 'file.complete'
      | 'file.abort'
      | 'inbound';
    payload: LeaseEventPayload;
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
  }) => PreparedAckHandling | null;
  handleAckOutcome: (
    args: {
      params: GatewayRequestHandlerOptions['params'];
      respond: GatewayRequestHandlerOptions['respond'];
    } & PreparedAckHandling,
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
    payload: LeaseEventPayload,
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
    payload: FileAckPayload;
    ok: boolean;
  }) => void;
  countInvalidOutboxSessionKeys: (accountId: string) => number;
  countLegacyAccountResidue: (accountId: string) => number;
  activeConnectionCount: (accountId: string) => number;
  getMessageAckWaiterCount: () => number;
  getFileAckWaiterCount: () => number;
  filterDeadLetterEntries: (args: {
    accountId: string;
    reason?: string | null;
    olderThan?: number | null;
  }) => OutboxEntry[];
  listDeadLetterEntries: () => OutboxEntry[];
  buildDeadLetterDiagnostics: (accountId: string) => BncrDeadLetterDiagnosticsSummary;
  replaceDeadLetterEntries: (nextEntries: OutboxEntry[]) => void;
  scheduleSave: () => void;
  logDeadLetterSummary: (accountId: string, args: { force: boolean; source: string }) => void;
}) {
  return { ...deps };
}
