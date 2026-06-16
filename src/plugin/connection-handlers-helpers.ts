import type { FileSendTransferState, OutboxEntry } from '../core/types.ts';

export type LeaseEventPayload = { leaseId?: string; connectionEpoch?: number };

export type ConnectionRuntimeFlags = Record<string, unknown>;
export type ConnectionQueueCounters = Record<string, unknown>;
export type ConnectionDiagnostics = Record<string, unknown>;

export type PreparedAckHandling = {
  accountId: string;
  connId: string;
  clientId?: string;
  messageId: string;
  entry: OutboxEntry;
  staleObserved: { stale: boolean };
};

export type FileAckPayload = {
  ok: boolean;
  transferId: string;
  stage: string;
  path: string;
  errorCode: string;
  errorMessage: string;
};

type FileAckState = Pick<
  FileSendTransferState,
  | 'status'
  | 'ownerConnId'
  | 'ownerClientId'
  | 'error'
  | 'terminalAt'
  | 'completedPath'
  | 'ackedChunks'
  | 'failedChunks'
>;

const BNCR_FILE_ACK_STAGES = ['init', 'chunk', 'complete', 'abort'] as const;

export type BncrFileAckStage = (typeof BNCR_FILE_ACK_STAGES)[number];

export function buildConnectionHandlerConnectResponse(args: {
  channelId: string;
  accountId: string;
  bridgeVersion: number;
  pushEvent: string;
  online: boolean;
  isPrimary: boolean;
  queueCounters: ConnectionQueueCounters;
  diagnostics: ConnectionDiagnostics;
  runtimeFlags: ConnectionRuntimeFlags;
  messageAckWaiters: number;
  fileAckWaiters: number;
  leaseId: string;
  connectionEpoch: number;
  acceptedAt: number;
  serverPid: number;
  bridgeId: string;
  now: number;
}) {
  return {
    channel: args.channelId,
    accountId: args.accountId,
    bridgeVersion: args.bridgeVersion,
    pushEvent: args.pushEvent,
    online: args.online,
    isPrimary: args.isPrimary,
    ...args.queueCounters,
    diagnostics: args.diagnostics,
    runtimeFlags: args.runtimeFlags,
    waiters: {
      messageAck: args.messageAckWaiters,
      fileAck: args.fileAckWaiters,
    },
    leaseId: args.leaseId,
    connectionEpoch: args.connectionEpoch,
    protocolVersion: 2,
    acceptedAt: args.acceptedAt,
    serverPid: args.serverPid,
    bridgeId: args.bridgeId,
    now: args.now,
  };
}

export function buildConnectionHandlerActivityResponse(args: {
  accountId: string;
  queueCounters: ConnectionQueueCounters;
  now: number;
}) {
  return {
    accountId: args.accountId,
    ok: true,
    event: 'activity',
    ...args.queueCounters,
    now: args.now,
  };
}

export function buildGatewayDebugFields(args: {
  bridgeId: string;
  accountId: string;
  connId: string;
  clientId?: string;
  hasContext?: boolean;
  outboundReady?: boolean;
  preferredForOutbound?: boolean;
  inboundOnly?: boolean;
}) {
  return {
    bridge: args.bridgeId,
    accountId: args.accountId,
    connId: args.connId,
    clientId: args.clientId,
    ...(typeof args.outboundReady === 'boolean' ? { outboundReady: args.outboundReady } : {}),
    ...(typeof args.preferredForOutbound === 'boolean'
      ? { preferredForOutbound: args.preferredForOutbound }
      : {}),
    ...(typeof args.inboundOnly === 'boolean' ? { inboundOnly: args.inboundOnly } : {}),
    ...(typeof args.hasContext === 'boolean' ? { hasContext: args.hasContext } : {}),
  };
}

export function isBncrFileAckStage(stage: string): stage is BncrFileAckStage {
  return BNCR_FILE_ACK_STAGES.includes(stage as BncrFileAckStage);
}

export function resolveFileAckLeaseEventKind(stage: BncrFileAckStage) {
  if (stage === 'init') return 'file.init';
  if (stage === 'chunk') return 'file.chunk';
  if (stage === 'abort') return 'file.abort';
  return 'file.complete';
}

export function buildTerminalFileAckResponse(args: {
  transferId: string;
  stage: string;
  state: string;
  stale: boolean;
}) {
  return args.stale
    ? {
        ok: true,
        transferId: args.transferId,
        stage: args.stage,
        state: args.state,
        stale: true,
        ignored: true,
        terminal: true,
      }
    : {
        ok: true,
        transferId: args.transferId,
        stage: args.stage,
        state: args.state,
        ignored: true,
        terminal: true,
      };
}

export function buildHandledFileAckResponse(args: {
  transferId: string;
  stage: string;
  state: string;
  stale: boolean;
}) {
  return args.stale
    ? {
        ok: true,
        transferId: args.transferId,
        stage: args.stage,
        state: args.state,
        stale: true,
        staleAccepted: true,
      }
    : {
        ok: true,
        transferId: args.transferId,
        stage: args.stage,
        state: args.state,
      };
}

export function buildFileAckPayload(args: {
  ok: boolean;
  transferId: string;
  stage: string;
  path: string;
  errorCode: string;
  errorMessage: string;
}): FileAckPayload {
  return {
    ok: args.ok,
    transferId: args.transferId,
    stage: args.stage,
    path: args.path,
    errorCode: args.errorCode,
    errorMessage: args.errorMessage,
  };
}

export function hasTerminalFileAckState(state: FileAckState | undefined): state is FileAckState {
  return state?.status === 'completed' || state?.status === 'aborted';
}

export function matchesTransferOwner(args: {
  transfer: FileAckState | undefined;
  connId: string;
  clientId?: string;
}) {
  const { transfer, connId, clientId } = args;
  const sameConn = !!transfer?.ownerConnId && transfer.ownerConnId === connId;
  const sameClient =
    !transfer?.ownerConnId &&
    !!transfer?.ownerClientId &&
    !!clientId &&
    transfer.ownerClientId === clientId;
  return { sameConn, sameClient };
}

export function applyFileAckState(args: {
  transfer: FileSendTransferState;
  stage: BncrFileAckStage;
  ok: boolean;
  chunkIndex: number | null;
  now: number;
  path: string;
  errorCode: string;
  errorMessage: string;
}) {
  const { transfer, stage, ok, chunkIndex, now, path, errorCode, errorMessage } = args;
  if (!ok) {
    transfer.error = `${errorCode || 'ACK_FAILED'}:${errorMessage || 'ack failed'}`;
    if (stage === 'chunk' && chunkIndex != null) {
      transfer.failedChunks.set(chunkIndex, transfer.error);
    }
    if (stage === 'complete') {
      transfer.status = 'aborted';
      transfer.terminalAt = now;
    }
    return;
  }

  if (stage === 'chunk' && chunkIndex != null) {
    transfer.ackedChunks.add(chunkIndex);
    transfer.status = 'transferring';
  }

  if (stage === 'complete') {
    transfer.status = 'completed';
    transfer.terminalAt = now;
    transfer.completedPath = path || transfer.completedPath;
  }
}
