import {
  buildFileTransferPushFailureArgs,
  resolveFileTransferFailureState,
} from '../core/outbox-file-transfer-failure.ts';
import { buildTextPushFailureArgs } from '../core/outbox-text-push-failure.ts';

import type { BncrConnection, OutboxEntry } from '../core/types.ts';
import {
  buildOutboxPushOkDebugInfo,
  buildOutboxPushSkipDebugInfo,
  buildOutboxRouteSelectDebugInfo,
  buildPushFailureDebugInfo,
} from '../messaging/outbound/diagnostics.ts';

export type BncrOutboxPushRuntime = {
  pushEvent: string;
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
  connectionsValues: () => Iterable<BncrConnection>;
  isRetryableFileTransferError: (value: unknown) => boolean;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
};

export function createBncrOutboxPush(runtime: BncrOutboxPushRuntime) {
  const logOutboxPushOk = (args: {
    messageId: string;
    accountId: string;
    kind?: 'file-transfer';
    connIds: Iterable<string>;
    ownerConnId: string;
    ownerClientId: string;
    recentInboundReachable: boolean;
    event: string;
  }) => {
    runtime.logInfo('outbox', `push ${JSON.stringify(buildOutboxPushOkDebugInfo(args))}`, {
      debugOnly: true,
    });
  };

  const logOutboxPushSkip = (args: {
    messageId: string;
    accountId: string;
    kind?: 'file-transfer';
    reason: string;
    recentInboundReachable?: boolean;
    routeReason?: string;
    connIds?: Iterable<string>;
    ownerConnId?: string;
    ownerClientId?: string;
  }) => {
    runtime.recordPrePushGuardSkip({ accountId: args.accountId, reason: args.reason });
    runtime.logInfo(
      'outbox push skip',
      `mid=${args.messageId}|q=${runtime.outboxSize()}|reason=${args.reason}${args.kind ? `|kind=${args.kind}` : ''}`,
    );
    runtime.logInfo(
      'outbox',
      `push-skip ${JSON.stringify(
        buildOutboxPushSkipDebugInfo({
          ...args,
          activeConnectionCount: runtime.activeConnectionCount(args.accountId),
          connections: runtime.connectionsValues(),
        }),
      )}`,
      { debugOnly: true },
    );
  };

  const logOutboxRouteSelect = (args: {
    messageId: string;
    accountId: string;
    kind?: 'file-transfer';
    routeReason: string;
    connIds: Iterable<string>;
    ownerConnId: string;
    ownerClientId: string;
    recentInboundReachable: boolean;
    event: string;
  }) => {
    runtime.logInfo(
      'outbox',
      `route-select ${JSON.stringify(buildOutboxRouteSelectDebugInfo(args))}`,
      { debugOnly: true },
    );
  };

  const logOutboxPushFailure = (args: {
    messageId: string;
    accountId: string;
    retryCount: number;
    kind?: 'file-transfer';
    retryable?: boolean;
    lastError?: string;
  }) => {
    runtime.logInfo('outbox', `push-fail ${JSON.stringify(buildPushFailureDebugInfo(args))}`, {
      debugOnly: true,
    });
  };

  const logOutboxPushOkSummary = (messageId: string) => {
    runtime.logInfo('outbox push', `mid=${messageId}|q=${runtime.outboxSize()}`);
  };

  const logOutboxPushFailureSummary = (messageId: string, lastError?: string) => {
    runtime.logInfo(
      'outbox push fail',
      `mid=${messageId}|q=${runtime.outboxSize()}|err=${lastError}`,
    );
  };

  const handleTextPushFailure = (args: { entry: OutboxEntry; error: unknown }) => {
    runtime.recordOutboxPushFailure({
      entry: args.entry,
      error: args.error,
      fallbackError: 'push-error',
    });
    logOutboxPushFailureSummary(args.entry.messageId, args.entry.lastError);
    logOutboxPushFailure(buildTextPushFailureArgs({ entry: args.entry }));
  };

  const handleFileTransferPushFailure = (args: { entry: OutboxEntry; error: unknown }) => {
    runtime.recordOutboxPushFailure({
      entry: args.entry,
      error: args.error,
      fallbackError: 'file-transfer-error',
      persist: true,
    });
    const failure = resolveFileTransferFailureState({
      entry: args.entry,
      error: args.error,
      isRetryableFileTransferError: (value) => runtime.isRetryableFileTransferError(value),
    });
    logOutboxPushFailureSummary(args.entry.messageId, args.entry.lastError);
    logOutboxPushFailure(
      buildFileTransferPushFailureArgs({
        entry: args.entry,
        retryable: failure.retryable,
      }),
    );
    if (!failure.retryable) {
      runtime.moveToDeadLetter(args.entry, failure.deadLetterReason);
    }
  };

  const handleFileTransferPushGuardFailure = (args: {
    entry: OutboxEntry;
    guard: {
      reason: 'media-url-missing' | 'no-gateway-context' | 'no-active-connection';
      lastError: string;
      recentInboundReachable?: boolean;
    };
  }) => {
    runtime.recordOutboxPrePushFailure({
      entry: args.entry,
      lastError: args.guard.lastError,
      persist: true,
    });
    if (args.guard.reason === 'media-url-missing') {
      logOutboxPushFailure({
        messageId: args.entry.messageId,
        accountId: args.entry.accountId,
        retryCount: args.entry.retryCount,
        kind: 'file-transfer',
        lastError: args.entry.lastError,
      });
      return;
    }
    logOutboxPushSkip({
      messageId: args.entry.messageId,
      accountId: args.entry.accountId,
      kind: 'file-transfer',
      reason:
        args.guard.reason === 'no-gateway-context' ? 'no-gateway-context' : 'no-active-connection',
      recentInboundReachable:
        args.guard.reason === 'no-active-connection'
          ? args.guard.recentInboundReachable
          : undefined,
    });
  };

  return {
    handleTextPushFailure,
    handleFileTransferPushFailure,
    handleFileTransferPushGuardFailure,
    logOutboxPushSkip,
    logOutboxRouteSelect,
    logOutboxPushFailure,
    logOutboxPushOk,
    logOutboxPushOkSummary,
    logOutboxPushFailureSummary,
  };
}
