import { buildBncrDebugJsonMessage } from '../core/logging.ts';
import { buildOutboxEnqueueDebugInfo } from '../core/outbox-enqueue.ts';
import {
  appendDeadLetter,
  buildDeadLetterEntry,
  collectDueOutboxEntries,
} from '../core/outbox-queue.ts';
import { formatDisplayScope } from '../core/targets.ts';
import type { OutboxEntry } from '../core/types.ts';
import {
  buildBncrOutboxFailureEntryPatch,
  buildBncrOutboxPushSuccessEntryPatch,
} from '../runtime/outbox-transitions.ts';
import { getErrorMessage } from './error-message.ts';

function isPrePushGuardReason(reason: string) {
  return reason === 'no-gateway-context' || reason === 'no-active-connection';
}

export function createBncrBridgeOutboxFacade(runtime: {
  bridgeId: string;
  normalizeAccountId: (accountId: string) => string;
  asString: (value: unknown, fallback?: string) => string;
  now: () => number;
  backoffMs: (retryCount: number) => number;
  maxRetry: number;
  maxDeadLetterEntries: number;
  outbox: Map<string, OutboxEntry>;
  getDeadLetter: () => OutboxEntry[];
  setDeadLetter: (entries: OutboxEntry[]) => void;
  incrementCounter: (map: Map<string, number>, accountId: string) => void;
  outboundEnqueueCountByAccount: Map<string, number>;
  lastOutboundEnqueueAtByAccount: Map<string, number>;
  prePushGuardSkipCountByAccount: Map<string, number>;
  lastPrePushGuardSkipAtByAccount: Map<string, number>;
  lastPrePushGuardSkipReasonByAccount: Map<string, string>;
  deadLetterSinceStartByAccount: Map<string, number>;
  lastOutboundByAccount: Map<string, number>;
  scheduleSave: () => void;
  flushPushQueueBestEffort: (args?: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }) => void;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logOutboundSummary: (entry: OutboxEntry) => void;
  logDeadLetterSummary: (accountId: string, options?: { force?: boolean; source?: string }) => void;
  resolveMessageAck: (messageId: string, result?: 'acked' | 'timeout') => boolean;
  markActivity: (accountId: string, at?: number) => void;
}) {
  const recordOutboxPrePushFailure = (args: {
    entry: OutboxEntry;
    lastError: string;
    persist?: boolean;
  }) => {
    const nextEntry = buildBncrOutboxFailureEntryPatch({
      entry: args.entry,
      lastError: args.lastError,
    });
    Object.assign(args.entry, nextEntry);
    runtime.outbox.set(nextEntry.messageId, args.entry);
    if (args.persist) runtime.scheduleSave();
  };

  const recordPrePushGuardSkip = (args: { accountId: string; reason: string }) => {
    if (!isPrePushGuardReason(args.reason)) return;
    const acc = runtime.normalizeAccountId(args.accountId);
    runtime.incrementCounter(runtime.prePushGuardSkipCountByAccount, acc);
    runtime.lastPrePushGuardSkipAtByAccount.set(acc, runtime.now());
    runtime.lastPrePushGuardSkipReasonByAccount.set(acc, args.reason);
  };

  const isPrePushGuardDeferral = (entry: OutboxEntry) =>
    entry.lastError === 'gateway context unavailable' ||
    entry.lastError === 'no active bncr client';

  const recordOutboxPushFailure = (args: {
    entry: OutboxEntry;
    error: unknown;
    fallbackError: string;
    persist?: boolean;
  }) => {
    const nextEntry = buildBncrOutboxFailureEntryPatch({
      entry: args.entry,
      lastError: runtime.asString(getErrorMessage(args.error, args.fallbackError)),
    });
    Object.assign(args.entry, nextEntry);
    runtime.outbox.set(nextEntry.messageId, args.entry);
    if (args.persist) runtime.scheduleSave();
  };

  const recordOutboxPushSuccess = (args: {
    entry: OutboxEntry;
    connIds: Iterable<string>;
    ownerConnId?: string;
    ownerClientId?: string;
    clearLastError?: boolean;
  }) => {
    const pushedAt = runtime.now();
    const nextEntry = buildBncrOutboxPushSuccessEntryPatch({
      entry: args.entry,
      connIds: args.connIds,
      pushedAt,
      ownerConnId: args.ownerConnId,
      ownerClientId: args.ownerClientId,
      clearLastError: args.clearLastError,
    });
    Object.assign(args.entry, nextEntry);
    runtime.outbox.set(nextEntry.messageId, args.entry);
    runtime.lastOutboundByAccount.set(nextEntry.accountId, pushedAt);
    runtime.markActivity(nextEntry.accountId, pushedAt);
    runtime.scheduleSave();
  };

  const enqueueOutbound = (entry: OutboxEntry) => {
    runtime.logInfo(
      'outbound',
      buildBncrDebugJsonMessage(
        'enqueue',
        buildOutboxEnqueueDebugInfo({
          bridgeId: runtime.bridgeId,
          entry,
          asString: runtime.asString,
          formatDisplayScope,
        }),
      ),
      { debugOnly: true },
    );
    runtime.logOutboundSummary(entry);
    const accountId = runtime.normalizeAccountId(entry.accountId);
    runtime.incrementCounter(runtime.outboundEnqueueCountByAccount, accountId);
    runtime.lastOutboundEnqueueAtByAccount.set(accountId, runtime.now());
    runtime.outbox.set(entry.messageId, entry);
    runtime.scheduleSave();
    runtime.flushPushQueueBestEffort({ accountId: entry.accountId });
  };

  const moveToDeadLetter = (entry: OutboxEntry, reason: string) => {
    const dead = buildDeadLetterEntry(entry, reason);
    runtime.setDeadLetter(
      appendDeadLetter({
        deadLetter: runtime.getDeadLetter(),
        entry: dead,
        maxEntries: runtime.maxDeadLetterEntries,
      }),
    );
    runtime.incrementCounter(runtime.deadLetterSinceStartByAccount, dead.accountId);
    runtime.logDeadLetterSummary(dead.accountId, { source: 'move' });
    runtime.outbox.delete(entry.messageId);
    runtime.resolveMessageAck(entry.messageId, 'timeout');
    runtime.scheduleSave();
  };

  const collectDue = (args: { accountId: string; maxBatch: number }) => {
    const key = runtime.normalizeAccountId(args.accountId);
    const result = collectDueOutboxEntries({
      outbox: runtime.outbox.values(),
      accountId: key,
      now: runtime.now(),
      maxBatch: args.maxBatch,
      maxRetry: runtime.maxRetry,
      backoffMs: runtime.backoffMs,
    });

    for (const entry of result.updatedEntries) runtime.outbox.set(entry.messageId, entry);
    for (const entry of result.deadLetterEntries)
      moveToDeadLetter(entry, entry.lastError || 'retry-limit');
    if (result.duePayloads.length) runtime.scheduleSave();
    return result.duePayloads;
  };

  return {
    recordOutboxPrePushFailure,
    recordPrePushGuardSkip,
    isPrePushGuardDeferral,
    recordOutboxPushFailure,
    recordOutboxPushSuccess,
    enqueueOutbound,
    moveToDeadLetter,
    collectDue,
  };
}
