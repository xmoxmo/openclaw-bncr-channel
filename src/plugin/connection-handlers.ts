import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import { CHANNEL_ID } from '../core/accounts.ts';
import { matchesTransferOwner } from '../core/lease-state.ts';
import type { FileSendTransferState } from '../core/types.ts';
import {
  applyFileAckState,
  buildConnectionHandlerActivityResponse,
  buildConnectionHandlerConnectResponse,
  buildFileAckPayload,
  buildGatewayDebugFields,
  buildHandledFileAckResponse,
  buildTerminalFileAckResponse,
  type ConnectionDiagnostics,
  type ConnectionQueueCounters,
  type ConnectionRuntimeFlags,
  type FileAckPayload,
  hasTerminalFileAckState,
  isBncrFileAckStage,
  type LeaseEventPayload,
  type PreparedAckHandling,
  resolveFileAckLeaseEventKind,
} from './connection-handlers-helpers.ts';
import { buildBncrGatewayEventContext } from './gateway-event-context.ts';

export type {
  ConnectionDiagnostics,
  ConnectionQueueCounters,
  ConnectionRuntimeFlags,
  FileAckPayload,
  LeaseEventPayload,
  PreparedAckHandling,
} from './connection-handlers-helpers.ts';

type LeaseEventKind =
  | 'connect'
  | 'inbound'
  | 'activity'
  | 'ack'
  | 'file.init'
  | 'file.chunk'
  | 'file.complete'
  | 'file.abort';

// Runtime contract ----------------------------------------------------------

export type BncrConnectionHandlersRuntime = {
  bridgeId: string;
  gatewayPid: number;
  pushEvent: string;
  bridgeVersion: number;
  asString: (value: unknown, fallback?: string) => string;
  now: () => number;
  finiteNonNegativeNumberOrNull: (value: unknown) => number | null;
  syncDebugFlag: () => Promise<void>;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  normalizeAccountId: (value: string) => string;
  buildAccountQueueCounters: (accountId: string) => ConnectionQueueCounters;
  buildExtendedDiagnostics: (accountId: string) => ConnectionDiagnostics;
  buildRuntimeFlags: (accountId: string) => ConnectionRuntimeFlags;
  isPrimaryConnection: (accountId: string, clientId?: string) => boolean;
  activeConnectionCount?: (accountId: string) => number;
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
    kind: Exclude<LeaseEventKind, 'connect'>;
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
  observeLease: (kind: LeaseEventKind, payload: LeaseEventPayload) => { stale: boolean };
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
};

export function createBncrConnectionHandlers(runtime: BncrConnectionHandlersRuntime) {
  // Handler order mirrors the host lifecycle:
  // connect bootstrap -> steady-state activity -> message ack -> file ack.
  // Keep that order stable so gateway event review follows the same path the
  // host takes at runtime.

  // Shared gateway event context -------------------------------------------

  const buildGatewayContext = (args: {
    params: GatewayRequestHandlerOptions['params'];
    client: GatewayRequestHandlerOptions['client'];
    context: GatewayRequestHandlerOptions['context'];
  }) => {
    return buildBncrGatewayEventContext({
      params: args.params,
      client: args.client,
      context: args.context,
      asString: runtime.asString,
      normalizeAccountId: runtime.normalizeAccountId,
      now: runtime.now,
    });
  };

  return {
    // Connect / activity handler surface -----------------------------------

    // Connection bootstrap establishes live routing state and returns the
    // current bridge/runtime snapshot that the client needs immediately.
    handleConnect: async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
      await runtime.syncDebugFlag();
      const gatewayContext = buildGatewayContext({ params, client, context });
      const { accountId, connId, clientId, outboundReady, preferredForOutbound, inboundOnly } =
        gatewayContext;

      runtime.logInfo(
        'connection',
        `connect ${JSON.stringify(
          buildGatewayDebugFields({
            bridgeId: runtime.bridgeId,
            accountId,
            connId,
            clientId,
            outboundReady,
            preferredForOutbound,
            inboundOnly,
            hasContext: Boolean(context),
          }),
        )}`,
        { debugOnly: true },
      );

      runtime.refreshLiveConnectionState({
        accountId,
        connId,
        clientId,
        outboundReady,
        preferredForOutbound,
        inboundOnly,
        context: gatewayContext.context,
      });
      runtime.incrementConnectEvents(accountId);
      const lease = runtime.acceptConnection();

      respond(
        true,
        buildConnectionHandlerConnectResponse({
          channelId: CHANNEL_ID,
          accountId,
          bridgeVersion: runtime.bridgeVersion,
          pushEvent: runtime.pushEvent,
          online: true,
          isPrimary: runtime.isPrimaryConnection(accountId, clientId),
          queueCounters: runtime.buildAccountQueueCounters(accountId),
          diagnostics: runtime.buildExtendedDiagnostics(accountId),
          runtimeFlags: runtime.buildRuntimeFlags(accountId),
          messageAckWaiters: runtime.messageAckWaiterCount(),
          fileAckWaiters: runtime.fileAckWaiterCount(),
          leaseId: lease.leaseId,
          connectionEpoch: lease.connectionEpoch,
          acceptedAt: lease.acceptedAt,
          serverPid: runtime.gatewayPid,
          bridgeId: runtime.bridgeId,
          now: runtime.now(),
        }),
      );

      runtime.flushOnConnect(accountId);
    },

    // Activity is the steady-state heartbeat. It refreshes routing/capability
    // state and nudges queued outbound work for the same account.
    handleActivity: async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
      await runtime.syncDebugFlag();
      const gatewayContext = buildGatewayContext({ params, client, context });
      const { accountId, connId, clientId, outboundReady, preferredForOutbound, inboundOnly } =
        gatewayContext;
      if (
        runtime.shouldIgnoreStaleEvent({
          kind: 'activity',
          payload: params ?? {},
          accountId,
          connId,
          clientId,
        })
      ) {
        respond(true, { accountId, ok: true, event: 'activity', stale: true, ignored: true });
        return;
      }
      runtime.markLastActivityAt();
      runtime.logInfo(
        'activity',
        `event ${JSON.stringify(
          buildGatewayDebugFields({
            bridgeId: runtime.bridgeId,
            accountId,
            connId,
            clientId,
            outboundReady,
            preferredForOutbound,
            inboundOnly,
            hasContext: Boolean(context),
          }),
        )}`,
        { debugOnly: true },
      );
      runtime.refreshLiveConnectionState({
        accountId,
        connId,
        clientId,
        outboundReady,
        preferredForOutbound,
        inboundOnly,
        context: gatewayContext.context,
      });
      runtime.incrementActivityEvents(accountId);

      respond(
        true,
        buildConnectionHandlerActivityResponse({
          accountId,
          queueCounters: runtime.buildAccountQueueCounters(accountId),
          now: runtime.now(),
        }),
      );
      runtime.flushOnActivity(accountId);
    },

    // Message ACK handler surface -------------------------------------------

    // Message ACK is intentionally thin here: parsing and outcome transitions
    // stay in the bridge-owned ACK runtime so all queue semantics share one path.
    handleAck: async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
      await runtime.syncDebugFlag();
      const prepared = runtime.prepareAckHandling({ params, respond, client, context });
      if (!prepared) return;

      runtime.markLastAckAt();
      runtime.incrementAckEvents(prepared.accountId);
      runtime.handleAckOutcome({ params, respond, ...prepared });
    },

    // File-transfer ACK handler surface ------------------------------------

    // File ACK handling is slightly different from message ACK handling: the
    // handler must validate stage ownership and mutate transfer state before it
    // wakes any waiter bound to the file-transfer lifecycle.
    handleFileAck: async ({ params, respond, client, context }: GatewayRequestHandlerOptions) => {
      const gatewayContext = buildGatewayContext({ params, client, context });
      const { accountId, connId, clientId } = gatewayContext;

      const transferId = runtime.asString(params?.transferId || '').trim();
      const stage = runtime.asString(params?.stage || '').trim();
      const ok = params?.ok !== false;
      const chunkIndex = runtime.finiteNonNegativeNumberOrNull(params?.chunkIndex);

      runtime.logInfo(
        'file-ack-inbound',
        JSON.stringify({
          ...buildGatewayDebugFields({
            bridgeId: runtime.bridgeId,
            accountId,
            connId,
            clientId,
          }),
          transferId,
          stage,
          ackStage: stage,
          ackOutcome: ok ? 'acked' : 'failed',
          ok,
          chunkIndex: chunkIndex != null ? chunkIndex : undefined,
          errorCode: runtime.asString(params?.errorCode || ''),
          errorMessage: runtime.asString(params?.errorMessage || ''),
          path: runtime.asString(params?.path || '').trim(),
        }),
        { debugOnly: true },
      );

      if (!transferId || !stage) {
        respond(false, { error: 'transferId/stage required' });
        return;
      }

      if (!isBncrFileAckStage(stage)) {
        respond(false, { error: 'invalid file ack stage' });
        return;
      }

      const transferState = runtime.fileSendTransfers.get(transferId);
      const fileAckWaiterKey = runtime.fileAckKey(
        transferId,
        stage,
        chunkIndex != null ? chunkIndex : undefined,
      );
      if (!transferState && !runtime.hasFileAckWaiter(fileAckWaiterKey)) {
        respond(false, { error: 'unknown transferId' });
        return;
      }

      const staleKind = resolveFileAckLeaseEventKind(stage);
      const staleObserved = runtime.observeLease(staleKind, params ?? {});
      const terminalTransfer = hasTerminalFileAckState(transferState) ? transferState : null;
      if (terminalTransfer) {
        respond(
          true,
          buildTerminalFileAckResponse({
            transferId,
            stage,
            state: terminalTransfer.status,
            stale: staleObserved.stale,
          }),
        );
        return;
      }

      const activeTransfer = transferState;
      const transferOwnerConnId = activeTransfer?.ownerConnId;
      const transferOwnerClientId = activeTransfer?.ownerClientId;
      let resolvedState = activeTransfer?.status ?? 'late';

      if (staleObserved.stale) {
        const sameOwner = matchesTransferOwner({
          ownerConnId: transferOwnerConnId,
          ownerClientId: transferOwnerClientId,
          connId,
          clientId,
        });
        const adopted =
          !sameOwner &&
          runtime.tryAdoptTransferOwner({
            accountId,
            transfer: activeTransfer,
            connId,
            clientId,
          });
        if (!sameOwner && !adopted) {
          runtime.logWarn(
            'stale',
            `ignore kind=file.ack accountId=${accountId} connId=${connId} clientId=${clientId || '-'} transferId=${transferId} stage=${stage} reason=owner-mismatch ownerConnId=${transferOwnerConnId || '-'} ownerClientId=${transferOwnerClientId || '-'}`,
            { debugOnly: true },
          );
          respond(true, { ok: true, stale: true, ignored: true });
          return;
        }
      } else {
        runtime.refreshAcceptedFileTransferLiveState({
          accountId,
          connId,
          clientId,
          context: gatewayContext.context,
        });
      }

      const fileAckPayload = buildFileAckPayload({
        ok,
        transferId,
        stage,
        path: runtime.asString(params?.path || '').trim(),
        errorCode: runtime.asString(params?.errorCode || ''),
        errorMessage: runtime.asString(params?.errorMessage || ''),
      });

      if (activeTransfer) {
        applyFileAckState({
          transfer: activeTransfer,
          stage,
          ok,
          chunkIndex,
          now: runtime.now(),
          path: fileAckPayload.path,
          errorCode: fileAckPayload.errorCode,
          errorMessage: fileAckPayload.errorMessage,
        });
        runtime.fileSendTransfers.set(transferId, activeTransfer);
        resolvedState = activeTransfer.status;
      }

      runtime.resolveFileAck({
        transferId,
        stage,
        chunkIndex: chunkIndex != null ? chunkIndex : undefined,
        payload: fileAckPayload,
        ok,
      });

      respond(
        true,
        buildHandledFileAckResponse({
          transferId,
          stage,
          state: resolvedState,
          stale: staleObserved.stale,
        }),
      );
    },
  };
}
