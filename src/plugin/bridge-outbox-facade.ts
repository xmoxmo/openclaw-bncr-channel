import { buildBncrDebugJsonMessage } from '../core/logging.ts';
import { buildOutboxEnqueueDebugInfo } from '../core/outbox-enqueue.ts';
import {
  appendDeadLetter,
  buildDeadLetterEntry,
  collectDueOutboxEntries,
} from '../core/outbox-queue.ts';
import { formatDisplayScope } from '../core/targets.ts';
import type { BncrRecentOutboundEntry, OutboxEntry } from '../core/types.ts';
import type { BncrConversationHistoryMap } from '../messaging/inbound/conversation-history.ts';
import {
  type BncrOutboundReplayCache,
  type BncrOutboundReplayEntry,
  recordBncrOutboundReplay,
} from '../messaging/inbound/outbound-replay-cache.ts';
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
  outboundReplayCache?: BncrOutboundReplayCache;
  conversationHistories?: BncrConversationHistoryMap;
  resolveOutboundHistoryLimit?: (entry: OutboxEntry) => number;
  resolveOutboundSender?: (entry: OutboxEntry) => { sender: string; senderId?: string };
  isOutboundAckRequired?: (accountId: string) => boolean;
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
  const recordOutboundMessage = (entry: OutboxEntry, status: 'pushed' | 'acked') => {
    if (!runtime.outboundReplayCache) return;
    const senderInfo = runtime.resolveOutboundSender?.(entry) ?? {
      sender: entry.accountId,
      senderId: entry.accountId,
    };
    recordBncrOutboundReplay({
      cache: runtime.outboundReplayCache,
      ...(runtime.conversationHistories
        ? { conversationHistories: runtime.conversationHistories }
        : {}),
      ...(runtime.resolveOutboundHistoryLimit
        ? { historyLimit: runtime.resolveOutboundHistoryLimit(entry) }
        : {}),
      entry,
      sender: senderInfo.sender,
      senderId: senderInfo.senderId,
      status,
    });
  };

  const markRecentOutboundAcked = (entry: OutboxEntry) => {
    recordOutboundMessage(entry, 'acked');
  };

  const recordOutboxPrePushFailure = (args: {
    entry: OutboxEntry;
    lastError: string;
    persist?: boolean;
  }) => {
    const nowMs = runtime.now();
    const nextRetry = (args.entry.retryCount || 0) + 1;
    if (nextRetry > runtime.maxRetry) {
      // Budget exhausted — dead-letter the entry
      Object.assign(args.entry, {
        lastError: args.lastError,
        retryCount: nextRetry,
        lastAttemptAt: nowMs,
      });
      moveToDeadLetter(args.entry, args.lastError);
      return;
    }
    const nextAttemptAt = nowMs + runtime.backoffMs(nextRetry);
    const nextEntry = buildBncrOutboxFailureEntryPatch({
      entry: { ...args.entry, retryCount: nextRetry, lastAttemptAt: nowMs, nextAttemptAt },
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
    if (runtime.isOutboundAckRequired?.(args.entry.accountId) === false) {
      recordOutboundMessage(args.entry, 'pushed');
    }
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

  const buildRecentOutboundEntry = (
    cacheKey: string,
    replay: BncrOutboundReplayEntry,
  ): BncrRecentOutboundEntry => {
    const keyParts = cacheKey.split(':');
    const accountId = replay.accountId || keyParts[0] || '';
    const route = replay.route
      ? replay.route
      : keyParts[1] && keyParts[2]
        ? keyParts[2].startsWith('-')
          ? { platform: keyParts[1], groupId: keyParts[2], userId: '0' }
          : { platform: keyParts[1], groupId: '0', userId: keyParts[2] }
        : { platform: '', groupId: '0', userId: '0' };
    return {
      messageId: replay.messageId || '',
      accountId,
      sessionKey: replay.sessionKey || '',
      route,
      ...(replay.type ? { type: replay.type } : {}),
      ...(replay.type ? { kind: replay.type } : {}),
      text: replay.body,
      ...(replay.mediaUrl ? { mediaUrl: replay.mediaUrl } : {}),
      createdAt: replay.createdAt ?? replay.timestamp ?? runtime.now(),
      ...(replay.timestamp ? { lastPushAt: replay.timestamp } : {}),
      status: replay.status === 'acked' ? 'acked' : 'pushed',
    };
  };

  const listReplayEntries = () => {
    if (!runtime.outboundReplayCache) return [];
    return Array.from(runtime.outboundReplayCache.entries()).flatMap(([cacheKey, entries]) =>
      entries.map((entry) => buildRecentOutboundEntry(cacheKey, entry)),
    );
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
    listRecentOutbound: (sessionKey: string) => {
      const normalized = runtime.asString(sessionKey || '').trim();
      return listReplayEntries()
        .filter((entry) => entry.sessionKey === normalized)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    listRecentOutboundByAccount: (accountId: string) => {
      const normalized = runtime.normalizeAccountId(accountId);
      return listReplayEntries()
        .filter((entry) => entry.accountId === normalized)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    markRecentOutboundAcked,
  };
}
