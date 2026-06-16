import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type {
  BncrConnection,
  FileRecvTransferState,
  FileSendTransferState,
  OutboxEntry,
} from '../core/types.ts';
import { getErrorMessage } from './error-message.ts';

export function createBncrBridgeConnectionFacade(runtime: {
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  normalizeAccountId: (accountId: string) => string;
  connectionState: {
    hasRecentInboundReachability: (accountId: string) => boolean;
    resolveRecentInboundConnIds: (accountId: string) => Set<string>;
    isRecentlyReachableConn: (accountId: string, connId?: string, clientId?: string) => boolean;
    isRevalidatedAttemptedConn: (entry: OutboxEntry, connId: string) => boolean;
    tryAdoptTransferOwner: (args: {
      accountId: string;
      transfer: FileSendTransferState | FileRecvTransferState | undefined;
      connId: string;
      clientId?: string;
    }) => boolean;
    refreshLiveConnectionState: (args: {
      accountId: string;
      connId: string;
      clientId?: string;
      outboundReady: boolean;
      preferredForOutbound: boolean;
      inboundOnly: boolean;
      context: GatewayRequestHandlerOptions['context'];
    }) => void;
    refreshAcceptedFileTransferLiveState: (args: {
      accountId: string;
      connId: string;
      clientId?: string;
      context: GatewayRequestHandlerOptions['context'];
    }) => void;
  };
  outboxRoute: {
    resolveOutboxPushOwner: (accountId: string) => BncrConnection | null;
    resolvePushConnIds: (accountId: string) => Set<string>;
  };
  rememberGatewayContext: (context: GatewayRequestHandlerOptions['context']) => void;
  markActivity: (accountId: string, at?: number) => void;
}) {
  const rememberGatewayContext = (context: GatewayRequestHandlerOptions['context']) => {
    if (!context) return;
    runtime.rememberGatewayContext(context);
  };

  const isRetryableFileTransferError = (error: unknown) => {
    const msg = runtime.asString(getErrorMessage(error, '')).trim().toLowerCase();
    if (!msg) return true;

    const retryableMarkers = [
      'gateway context unavailable',
      'no active bncr client for file chunk transfer',
      'chunk ack timeout',
      'complete ack timeout',
      'transfer state missing',
      'transfer aborted',
      'temporarily unavailable',
      'timeout',
      'econn',
      'socket',
      'network',
    ];

    return retryableMarkers.some((marker) => msg.includes(marker));
  };

  return {
    rememberGatewayContext,
    resolveOutboxPushOwner: (accountId: string) =>
      runtime.outboxRoute.resolveOutboxPushOwner(accountId),
    resolvePushConnIds: (accountId: string) => runtime.outboxRoute.resolvePushConnIds(accountId),
    hasRecentInboundReachability: (accountId: string) =>
      runtime.connectionState.hasRecentInboundReachability(accountId),
    resolveRecentInboundConnIds: (accountId: string) =>
      runtime.connectionState.resolveRecentInboundConnIds(accountId),
    isRecentlyReachableConn: (accountId: string, connId?: string, clientId?: string) =>
      runtime.connectionState.isRecentlyReachableConn(accountId, connId, clientId),
    isRevalidatedAttemptedConn: (entry: OutboxEntry, connId: string) =>
      runtime.connectionState.isRevalidatedAttemptedConn(entry, connId),
    tryAdoptTransferOwner: (args: {
      accountId: string;
      transfer: FileSendTransferState | FileRecvTransferState | undefined;
      connId: string;
      clientId?: string;
    }) => runtime.connectionState.tryAdoptTransferOwner(args),
    refreshLiveConnectionState: (args: {
      accountId: string;
      connId: string;
      clientId?: string;
      outboundReady: boolean;
      preferredForOutbound: boolean;
      inboundOnly: boolean;
      context: GatewayRequestHandlerOptions['context'];
    }) => runtime.connectionState.refreshLiveConnectionState(args),
    refreshAcceptedFileTransferLiveState: (args: {
      accountId: string;
      connId: string;
      clientId?: string;
      context: GatewayRequestHandlerOptions['context'];
    }) => runtime.connectionState.refreshAcceptedFileTransferLiveState(args),
    markActivity: (accountId: string, at = runtime.now()) => runtime.markActivity(accountId, at),
    isRetryableFileTransferError,
  };
}
