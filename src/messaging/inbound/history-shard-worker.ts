import { emitBncrLogLine } from '../../core/logging.ts';
import type { BncrHistoryShardQueue, BncrHistoryShardRow } from '../../plugin/sqlite-state.ts';
import type { BncrInboundContextPayload } from './contracts.ts';
import type { BncrConversationHistoryMap } from './conversation-history.ts';
import { removeBncrConversationHistoryMessageIds } from './conversation-history.ts';
import {
  getConversationHistorySerialOwner,
  runConversationHistorySerial,
} from './conversation-history-serial.ts';
import type {
  BncrInboundConversationResolution,
  BncrInboundReplyRouteFact,
  ParsedInbound,
} from './dispatch-prep.ts';
import type { BncrOutboundReplayCache } from './outbound-replay-cache.ts';
import { removeBncrOutboundReplayMessageIds } from './outbound-replay-cache.ts';

export type BncrHistoryShardDispatchPayload = {
  parsed: ParsedInbound;
  msgId?: string | null;
  peer: ParsedInbound['peer'];
  rawBody: string;
  storePath: string;
  ctxPayload: BncrInboundContextPayload;
  resolution: BncrInboundConversationResolution;
  replyRouteFact: BncrInboundReplyRouteFact;
  senderIdForContext: string;
  senderDisplayName: string;
  shouldDispatch: boolean;
  silentHistoryFlush?: boolean;
  deliveryId?: string;
};

export type BncrHistoryShardPayloadEnvelope = {
  version: 2;
  historyKey: string;
  accountId?: string;
  messageIds: string[];
  bufferKeys: string[];
  dispatch: BncrHistoryShardDispatchPayload;
};

export const HISTORY_SHARD_LEASE_RENEW_INTERVAL_MS = 60_000;

export async function runBncrHistoryShardWithLeaseRenewal<T>(args: {
  shardId: number | null;
  historyShardQueue?: BncrHistoryShardQueue;
  task: () => Promise<T>;
  intervalMs?: number;
  owner?: string;
}): Promise<T> {
  if (args.shardId === null || !args.historyShardQueue?.renewHistoryShardLease) {
    return args.task();
  }
  const renew = () => {
    try {
      args.historyShardQueue?.renewHistoryShardLease?.(args.shardId!, args.owner);
    } catch {
      // Lease renewal is best-effort; the claim itself protects against a stale lease.
    }
  };
  const timer = setInterval(renew, args.intervalMs ?? HISTORY_SHARD_LEASE_RENEW_INTERVAL_MS);
  timer.unref?.();
  try {
    return await args.task();
  } finally {
    clearInterval(timer);
  }
}

export function parseBncrHistoryShardPayload(value: string): BncrHistoryShardPayloadEnvelope {
  const parsed = JSON.parse(value) as Partial<BncrHistoryShardPayloadEnvelope>;
  if (parsed?.version !== 2) {
    throw new Error(`unsupported history shard payload version=${String(parsed?.version)}`);
  }
  if (!parsed.dispatch || !parsed.historyKey) {
    throw new Error('invalid history shard payload: missing dispatch payload');
  }
  return parsed as BncrHistoryShardPayloadEnvelope;
}

export async function processBncrHistoryShardSlot(args: {
  shard: BncrHistoryShardRow;
  historyShardQueue: BncrHistoryShardQueue;
  conversationHistories?: BncrConversationHistoryMap;
  outboundReplayCache?: BncrOutboundReplayCache;
  runDispatch: (payload: BncrHistoryShardDispatchPayload) => Promise<void>;
  leaseRenewIntervalMs?: number;
}) {
  const shardOwner = args.shard.owner ?? getConversationHistorySerialOwner();
  let payload: BncrHistoryShardPayloadEnvelope;
  try {
    payload = parseBncrHistoryShardPayload(args.shard.payloadJson);
  } catch (error) {
    try {
      args.historyShardQueue.markHistoryShardFailed(args.shard.id, error, shardOwner);
    } catch (markError) {
      emitBncrLogLine(
        'warn',
        `[bncr] history shard failed mark failed|key=${args.shard.historyKey}|shard=${args.shard.id}|reason=${String(markError)}`,
      );
    }
    throw error;
  }
  await runBncrHistoryShardWithLeaseRenewal({
    shardId: args.shard.id,
    historyShardQueue: args.historyShardQueue,
    intervalMs: args.leaseRenewIntervalMs,
    owner: shardOwner,
    task: () =>
      runConversationHistorySerial(
        args.shard.historyKey,
        async (handle) => {
          handle.phase('snapshot');
          if (
            args.historyShardQueue.markHistoryShardProcessing(args.shard.id, shardOwner) === false
          ) {
            throw new Error(
              `history shard activation lost|key=${args.shard.historyKey}|shard=${args.shard.id}`,
            );
          }
          try {
            await args.runDispatch({
              ...payload.dispatch,
              deliveryId: `bncr-history-shard:${args.shard.id}`,
            });
          } catch (error) {
            try {
              args.historyShardQueue.markHistoryShardFailed(args.shard.id, error, shardOwner);
            } catch (markError) {
              emitBncrLogLine(
                'warn',
                `[bncr] history shard failed mark failed|key=${args.shard.historyKey}|shard=${args.shard.id}|reason=${String(markError)}`,
              );
            }
            throw error;
          }
          handle.phase('upload_end');
          try {
            args.historyShardQueue.markHistoryShardCompleted(args.shard.id, shardOwner);
          } catch (error) {
            // Completion marking is observability only; cleanup still deletes the
            // shard-owned rows after the upload has settled.
            emitBncrLogLine(
              'warn',
              `[bncr] history shard complete mark failed|key=${args.shard.historyKey}|shard=${args.shard.id}|reason=${String(error)}`,
            );
          }
          handle.phase('cache_delete_start');
          if (args.conversationHistories) {
            removeBncrConversationHistoryMessageIds({
              historyMap: args.conversationHistories,
              historyKey: args.shard.historyKey,
              messageIds: payload.messageIds,
            });
          }
          if (args.outboundReplayCache && payload.bufferKeys.length > 0) {
            removeBncrOutboundReplayMessageIds({
              cache: args.outboundReplayCache,
              parsed: payload.dispatch.parsed,
              accountId: payload.dispatch.resolution.accountId,
              messageIds: payload.messageIds,
            });
          }
          handle.phase('cache_delete_done');
          try {
            args.historyShardQueue.completeHistoryShard(args.shard.id, shardOwner);
          } catch (error) {
            // A failed cleanup is recovered from the DB on restart. Do not retry
            // the same shard here because the upload itself already succeeded.
            emitBncrLogLine(
              'warn',
              `[bncr] history shard complete failed|key=${args.shard.historyKey}|shard=${args.shard.id}|reason=${String(error)}`,
            );
          }
        },
        { owner: shardOwner },
      ),
  });
}
