import { emitBncrLogLine } from '../../core/logging.ts';
import { parseStrictBncrSessionKey } from '../../core/targets.ts';
import type { OutboxEntry } from '../../core/types.ts';
import type { BncrSceneRecord } from '../../plugin/channel-runtime-types.ts';
import { buildSceneKey } from '../../plugin/scene-registry.ts';
import type { BncrHistoryShardQueue } from '../../plugin/sqlite-state.ts';
import { getBncrHistoryShardQueue } from '../../plugin/state-store.ts';
import { handleBncrNativeCommand } from './commands.ts';
import type {
  BncrEnqueueFromReply,
  BncrInboundApi,
  BncrInboundConfig,
  BncrInboundLogger,
  BncrRememberSessionRoute,
} from './contracts.ts';
import {
  type BncrConversationHistoryMap,
  type BncrHistoryEntry,
  buildBncrConversationHistoryKey,
  readBncrPendingConversationHistorySnapshot,
  readConversationHistoryVersion,
  recordBncrPendingConversationMedia,
  recordBncrPendingConversationText,
  removeBncrConversationHistoryMessageIds,
  resolveBncrConversationHistoryMessageId,
  resolveBncrHistoryLimit,
} from './conversation-history.ts';
import {
  type ConversationHistorySerialHandle,
  runConversationHistorySerial,
} from './conversation-history-serial.ts';
import {
  assertInboundMediaBase64Size,
  decodeInboundMediaBase64,
  estimateBase64DecodedBytes,
  type ParsedInbound,
  prepareBncrInboundDispatch,
  resolveBncrInboundConversation,
} from './dispatch-prep.ts';
import { runBncrHistoryShardWithLeaseRenewal } from './history-shard-worker.ts';
import { isBncrStopCommandText } from './native-command.ts';
import {
  type BncrOutboundReplayCache,
  type BncrOutboundReplayEntry,
  buildBncrOutboundReplayKey,
  readBncrOutboundReplaySnapshot,
  removeBncrOutboundReplayMessageIds,
} from './outbound-replay-cache.ts';
import { parseBncrInboundParams } from './parse.ts';
import { runBncrInboundReplyDispatch } from './reply-dispatch.ts';
import { buildBncrInboundTurnContext } from './turn-context.ts';

export {
  assertInboundMediaBase64Size,
  decodeInboundMediaBase64,
  estimateBase64DecodedBytes,
  resolveBncrInboundConversation,
};

export async function dispatchBncrInbound(params: {
  api: BncrInboundApi;
  channelId: string;
  cfg: BncrInboundConfig;
  parsed: ParsedInbound;
  canonicalAgentId: string;
  shouldDispatch?: boolean;
  shouldAccumulate?: boolean;
  forceSilentHistoryFlush?: boolean;
  forceSilentHistoryFlushVersion?: number;
  forceSilentHistoryFlushMessageId?: string;
  resolvedAgentId?: string;
  sceneRegistry: Map<string, BncrSceneRecord>;
  conversationHistories: BncrConversationHistoryMap;
  outboundReplayCache?: BncrOutboundReplayCache;
  historyShardQueue?: BncrHistoryShardQueue;
  defaultAdminAgentId: string;
  defaultPublicAgentId: string;
  now: () => number;
  rememberSessionRoute: BncrRememberSessionRoute;
  enqueueFromReply: BncrEnqueueFromReply;
  setInboundActivity: (accountId: string, at: number) => void;
  scheduleSave: () => void;
  logger?: BncrInboundLogger;
}) {
  const {
    api,
    channelId,
    cfg,
    parsed,
    canonicalAgentId,
    shouldDispatch: initialShouldDispatch = true,
    shouldAccumulate = initialShouldDispatch,
    forceSilentHistoryFlush = false,
    forceSilentHistoryFlushVersion,
    forceSilentHistoryFlushMessageId,
    resolvedAgentId,
    sceneRegistry = new Map(),
    conversationHistories = new Map(),
    outboundReplayCache = new Map(),
    defaultAdminAgentId,
    defaultPublicAgentId,
    now,
    rememberSessionRoute,
    enqueueFromReply,
    setInboundActivity,
    scheduleSave,
    logger,
  } = params;
  const historyShardQueue =
    params.historyShardQueue ?? getBncrHistoryShardQueue(conversationHistories) ?? undefined;
  const { accountId, clientId, msgId, extracted, mimeType, peer } = parsed;
  let shouldDispatch = initialShouldDispatch || forceSilentHistoryFlush;

  const nativeCommand = await handleBncrNativeCommand({
    api,
    channelId,
    cfg,
    parsed,
    canonicalAgentId,
    resolvedAgentId,
    sceneRegistry,
    defaultAdminAgentId,
    defaultPublicAgentId,
    now,
    rememberSessionRoute,
    enqueueFromReply,
    logger,
  });
  if (nativeCommand.handled && !nativeCommand.fallbackToAgent) {
    const inboundAt = Date.now();
    setInboundActivity(accountId, inboundAt);
    scheduleSave();
    return {
      accountId,
      sessionKey: nativeCommand.sessionKey,
      taskKey: extracted.taskKey ?? null,
      msgId: msgId ?? null,
    };
  }

  const preparedDispatch = await prepareBncrInboundDispatch({
    api,
    channelId,
    cfg,
    parsed,
    canonicalAgentId,
    resolvedAgentId,
    rememberSessionRoute,
  });
  const {
    resolution,
    prepared,
    replyRouteFact,
    senderIdForContext,
    senderDisplayName,
    ownerAllowFrom,
    bridgeSenderId,
    bridgeSenderName,
  } = preparedDispatch;
  const { dispatchSessionKey: sessionKey } = resolution;
  const { storePath, mediaItems, rawBody } = prepared;
  const primaryMedia = mediaItems[0];
  const mediaContentType = primaryMedia?.contentType;
  if (!clientId) {
    emitBncrLogLine(
      'warn',
      '[bncr] inbound missing clientId for chat identity; using route identity fallback',
    );
  }
  const historyKey = buildBncrConversationHistoryKey(parsed);
  const resolvedHistoryLimit = resolveBncrHistoryLimit(
    sceneRegistry.get(buildSceneKey(parsed))?.historyLimit,
  );
  const isStopCommand = isBncrStopCommandText(rawBody);
  if (isStopCommand && shouldDispatch) {
    // A stop command must not wait behind the history serial chain or mutate
    // the accumulated conversation window. Deliver it immediately so the host
    // can abort the active run instead of queuing behind it.
    const stopOwnerAllowFrom =
      parsed.peer.kind === 'direct' && senderIdForContext ? [senderIdForContext] : ownerAllowFrom;
    const ctxPayload = await buildBncrInboundTurnContext({
      api,
      cfg,
      channelId,
      parsed,
      msgId,
      peer,
      senderIdForContext,
      senderDisplayName,
      ownerAllowFrom: stopOwnerAllowFrom,
      bridgeSenderId,
      bridgeSenderName,
      historyLimit: resolvedHistoryLimit,
      resolution,
      prepared,
      conversationHistories: new Map(),
      shouldDispatch: true,
      silentHistoryFlush: false,
      pendingHistoryEntries: [],
    });
    await runBncrInboundReplyDispatch({
      api,
      channelId,
      cfg,
      parsed,
      msgId,
      peer,
      rawBody,
      storePath,
      ctxPayload,
      resolution,
      replyRouteFact,
      senderIdForContext,
      senderDisplayName,
      shouldDispatch: true,
      silentHistoryFlush: false,
      setInboundActivity,
      scheduleSave,
      enqueueFromReply,
    });
    scheduleSave();
    return {
      accountId,
      sessionKey,
      taskKey: extracted.taskKey ?? null,
      msgId: msgId ?? null,
    };
  }
  const processTurn = async (handle: ConversationHistorySerialHandle) => {
    handle.phase('snapshot');
    const serialOwner = handle.owner();
    let silentHistoryFlush = forceSilentHistoryFlush;
    let pendingHistoryEntries: BncrHistoryEntry[] = [];
    let snapshotMessageIds: string[] = [];
    let cacheKey: string | undefined;
    let historyShardId: number | null = null;
    let historyShardDeliveryId: string | undefined;
    let uploadSettled = false;
    if (historyKey && forceSilentHistoryFlushVersion !== undefined) {
      const currentHistoryVersion = readConversationHistoryVersion(
        conversationHistories,
        historyKey,
      );
      if (currentHistoryVersion !== forceSilentHistoryFlushVersion) {
        scheduleSave();
        return {
          accountId,
          sessionKey,
          taskKey: extracted.taskKey ?? null,
          msgId: msgId ?? null,
        };
      }
    }
    if (shouldAccumulate) {
      // Record the message first so overflow context includes it
      recordBncrPendingConversationText({
        historyMap: conversationHistories,
        parsed,
        senderDisplayName,
        senderId: senderIdForContext,
        bodyText: rawBody,
        historyLimit: resolvedHistoryLimit,
      });
      recordBncrPendingConversationMedia({
        historyMap: conversationHistories,
        parsed,
        senderDisplayName,
        senderId: senderIdForContext,
        bodyText: rawBody,
        mediaItems,
        mediaContentType: mediaContentType || mimeType,
        historyLimit: resolvedHistoryLimit,
      });
      if (historyKey) {
        const entries = conversationHistories.get(historyKey);
        if (entries && resolvedHistoryLimit > 0 && entries.length >= resolvedHistoryLimit) {
          const sceneForHistory = sceneRegistry.get(buildSceneKey(parsed));
          const historyForce = sceneForHistory?.historyForce !== false;
          if (historyForce) {
            silentHistoryFlush = true;
            shouldDispatch = true;
          }
        }
      }
    }

    if (historyKey && historyShardQueue?.reconcileHistoryMemory) {
      await historyShardQueue.reconcileHistoryMemory(historyKey);
    }

    if (shouldDispatch) {
      pendingHistoryEntries = readBncrPendingConversationHistorySnapshot({
        historyMap: conversationHistories,
        parsed,
        historyLimit: resolvedHistoryLimit,
      });
      const legacyOutboundEntries = readBncrOutboundReplaySnapshot({
        cache: outboundReplayCache,
        parsed,
        accountId,
        excludeMessageId: msgId,
      });
      if (
        forceSilentHistoryFlush &&
        pendingHistoryEntries.length === 0 &&
        legacyOutboundEntries.length === 0
      ) {
        scheduleSave();
        return {
          accountId,
          sessionKey,
          taskKey: extracted.taskKey ?? null,
          msgId: msgId ?? null,
        };
      }
      const knownMessageIds = new Set(
        pendingHistoryEntries
          .map((entry) => entry.messageId)
          .filter((messageId): messageId is string => Boolean(messageId)),
      );
      for (const entry of legacyOutboundEntries) {
        if (entry.messageId && knownMessageIds.has(entry.messageId)) continue;
        if (entry.messageId) knownMessageIds.add(entry.messageId);
        pendingHistoryEntries.push({
          sender: entry.sender,
          ...(entry.senderId ? { senderId: entry.senderId } : {}),
          body: entry.body,
          ...(typeof entry.timestamp === 'number' ? { timestamp: entry.timestamp } : {}),
          ...(entry.messageId ? { messageId: entry.messageId } : {}),
          role: 'assistant',
          ...(Array.isArray(entry.media)
            ? {
                media: entry.media.map((item) => ({
                  path: item.path,
                  contentType: item.contentType,
                  kind: item.kind,
                  messageId: item.messageId,
                })),
              }
            : {}),
        });
      }
      pendingHistoryEntries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      if (pendingHistoryEntries.length > resolvedHistoryLimit) {
        let currentMessageId = String(
          (forceSilentHistoryFlush && forceSilentHistoryFlushMessageId) || '',
        ).trim();
        if (!currentMessageId) {
          // A platform may omit message ids. The latest recorded in-memory entry
          // is the current message and must survive the window trim even when
          // other entries carry later timestamps.
          currentMessageId = String(
            resolveBncrConversationHistoryMessageId(parsed) ||
              (shouldAccumulate
                ? historyKey
                  ? conversationHistories.get(historyKey)?.at(-1)?.messageId
                  : undefined
                : undefined) ||
              '',
          ).trim();
        }
        const currentEntry = currentMessageId
          ? pendingHistoryEntries.find((entry) => entry.messageId === currentMessageId)
          : undefined;
        pendingHistoryEntries = pendingHistoryEntries.slice(-resolvedHistoryLimit);
        if (currentEntry && !pendingHistoryEntries.includes(currentEntry)) {
          const withoutCurrent = pendingHistoryEntries.filter((entry) => entry !== currentEntry);
          pendingHistoryEntries = [
            ...withoutCurrent.slice(-(resolvedHistoryLimit - 1)),
            currentEntry,
          ];
          pendingHistoryEntries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        }
      }
      cacheKey = buildBncrOutboundReplayKey(parsed, accountId) ?? undefined;
      const historyEntriesBeforeUpload: readonly BncrHistoryEntry[] = historyKey
        ? conversationHistories.get(historyKey) || []
        : [];
      const cacheEntriesBeforeUpload: readonly BncrOutboundReplayEntry[] = cacheKey
        ? outboundReplayCache.get(cacheKey) || []
        : [];
      snapshotMessageIds = Array.from(
        new Set(
          [
            ...historyEntriesBeforeUpload.map((entry) => entry.messageId),
            ...cacheEntriesBeforeUpload.map((entry) => entry.messageId),
          ].filter((messageId): messageId is string => Boolean(messageId)),
        ),
      );
      handle.setCleanup(() => {
        const shouldClearLocalCache = historyShardId === null || uploadSettled;
        if (historyKey && shouldClearLocalCache) {
          removeBncrConversationHistoryMessageIds({
            historyMap: conversationHistories,
            historyKey,
            messageIds: snapshotMessageIds,
          });
        }
        if (shouldClearLocalCache) {
          removeBncrOutboundReplayMessageIds({
            cache: outboundReplayCache,
            parsed,
            accountId,
            messageIds: snapshotMessageIds,
          });
        }
        if (uploadSettled && historyShardId !== null && historyShardQueue) {
          try {
            historyShardQueue.completeHistoryShard(historyShardId, serialOwner);
          } catch (error) {
            emitBncrLogLine(
              'warn',
              `[bncr] history shard cleanup failed|key=${historyKey}|shard=${historyShardId}|reason=${String(error)}`,
            );
          }
        }
      });
      handle.phase('snapshot', {
        snapshotMessageIds,
        cacheKey,
      });
    }
    const ctxPayload = await buildBncrInboundTurnContext({
      api,
      cfg,
      channelId,
      parsed,
      msgId,
      peer,
      senderIdForContext,
      senderDisplayName,
      ownerAllowFrom,
      bridgeSenderId,
      bridgeSenderName,
      historyLimit: resolvedHistoryLimit,
      resolution,
      prepared,
      conversationHistories,
      shouldDispatch,
      silentHistoryFlush,
      pendingHistoryEntries,
    });
    if (handle.isAbandoned()) {
      return {
        accountId,
        sessionKey,
        taskKey: extracted.taskKey ?? null,
        msgId: msgId ?? null,
      };
    }
    if (!shouldDispatch) {
      await runBncrInboundReplyDispatch({
        api,
        channelId,
        cfg,
        parsed,
        msgId,
        peer,
        rawBody,
        storePath,
        ctxPayload,
        resolution,
        replyRouteFact,
        senderIdForContext,
        senderDisplayName,
        shouldDispatch,
        silentHistoryFlush,
        setInboundActivity,
        scheduleSave,
        enqueueFromReply,
      });
      scheduleSave();
      return {
        accountId,
        sessionKey,
        taskKey: extracted.taskKey ?? null,
        msgId: msgId ?? null,
      };
    }

    if (historyKey && historyShardQueue) {
      let createdShardId: number | null = null;
      try {
        const shard = historyShardQueue.createHistoryShard({
          historyKey,
          accountId,
          payloadJson: JSON.stringify({
            version: 2,
            historyKey,
            accountId,
            messageIds: snapshotMessageIds,
            bufferKeys: cacheKey ? [cacheKey] : [],
            dispatch: {
              parsed,
              msgId,
              peer,
              rawBody,
              storePath,
              ctxPayload,
              resolution,
              replyRouteFact,
              senderIdForContext,
              senderDisplayName,
              shouldDispatch,
              silentHistoryFlush,
            },
          }),
          messageIds: snapshotMessageIds,
          bufferKeys: cacheKey ? [cacheKey] : [],
        });
        if (shard !== null) {
          createdShardId = shard.shardId;
          // An existing shard already owns the shared snapshot. Keep stable
          // delivery identity so this direct attempt and the worker retry
          // carry the same ingest id instead of producing duplicates.
          historyShardDeliveryId = `bncr-history-shard:${shard.shardId}`;
          // The database shard owns the snapshot from this point. Removing it
          // from the in-memory window immediately prevents a new trigger from
          // double-sending the same messages while the shard is retried.
          handle.phase('shard_created', {
            snapshotMessageIds,
            cacheKey,
          });
          removeBncrConversationHistoryMessageIds({
            historyMap: conversationHistories,
            historyKey,
            messageIds: snapshotMessageIds,
          });
          removeBncrOutboundReplayMessageIds({
            cache: outboundReplayCache,
            parsed,
            accountId,
            messageIds: snapshotMessageIds,
          });
          if (historyShardQueue.markHistoryShardProcessing(shard.shardId, serialOwner) === false) {
            throw new Error(
              `history shard activation lost|key=${historyKey}|shard=${shard.shardId}`,
            );
          }
          // The direct attempt now owns the claim and must finish cleanup even
          // when it reused an existing row; otherwise the worker will retry the
          // same snapshot after this upload has settled.
          historyShardId = shard.shardId;
        }
      } catch (error) {
        historyShardId = null;
        emitBncrLogLine(
          'warn',
          `[bncr] history shard create failed|key=${historyKey}|reason=${String(error)}`,
        );
        if (createdShardId !== null) {
          // The shard row already exists and will be retried by the worker.
          // Falling back to a direct upload here would duplicate the snapshot.
          throw error;
        }
      }
    }

    handle.phase('upload_start', {
      snapshotMessageIds,
      cacheKey,
    });
    try {
      await runBncrHistoryShardWithLeaseRenewal({
        shardId: historyShardId,
        historyShardQueue,
        owner: serialOwner,
        task: () =>
          runBncrInboundReplyDispatch({
            api,
            channelId,
            cfg,
            parsed,
            msgId,
            peer,
            rawBody,
            storePath,
            ctxPayload,
            resolution,
            replyRouteFact,
            senderIdForContext,
            senderDisplayName,
            shouldDispatch,
            silentHistoryFlush,
            deliveryId:
              historyShardDeliveryId ??
              (historyShardId !== null ? `bncr-history-shard:${historyShardId}` : undefined),
            setInboundActivity,
            scheduleSave,
            enqueueFromReply,
          }),
      });
    } catch (error) {
      if (historyShardId !== null && historyShardQueue) {
        try {
          historyShardQueue.markHistoryShardFailed(historyShardId, error, serialOwner);
        } catch (markError) {
          emitBncrLogLine(
            'warn',
            `[bncr] history shard failed mark failed|key=${historyKey}|shard=${historyShardId}|reason=${String(markError)}`,
          );
        }
      }
      throw error;
    }
    uploadSettled = true;
    handle.phase('upload_end');
    if (historyShardId !== null && historyShardQueue) {
      try {
        historyShardQueue.markHistoryShardCompleted(historyShardId, serialOwner);
      } catch (error) {
        emitBncrLogLine(
          'warn',
          `[bncr] history shard complete mark failed|key=${historyKey}|shard=${historyShardId}|reason=${String(error)}`,
        );
      }
    }
    handle.phase('cache_delete_start');
    const shouldClearLocalCache = historyShardId === null || uploadSettled;
    if (historyKey && shouldClearLocalCache) {
      removeBncrConversationHistoryMessageIds({
        historyMap: conversationHistories,
        historyKey,
        messageIds: snapshotMessageIds,
      });
    }
    if (shouldClearLocalCache) {
      removeBncrOutboundReplayMessageIds({
        cache: outboundReplayCache,
        parsed,
        accountId,
        messageIds: snapshotMessageIds,
      });
    }
    handle.phase('cache_delete_done');
    if (uploadSettled && historyShardId !== null && historyShardQueue) {
      try {
        historyShardQueue.completeHistoryShard(historyShardId, serialOwner);
      } catch (error) {
        emitBncrLogLine(
          'warn',
          `[bncr] history shard complete failed|key=${historyKey}|shard=${historyShardId}|reason=${String(error)}`,
        );
      }
    }
    scheduleSave();

    return {
      accountId,
      sessionKey,
      taskKey: extracted.taskKey ?? null,
      msgId: msgId ?? null,
    };
  };

  return runConversationHistorySerial(historyKey || '', processTurn, {
    to: resolution.canonicalTo,
  });
}

export async function dispatchBncrOutboundHistoryFlush(params: {
  api: BncrInboundApi;
  channelId: string;
  cfg: BncrInboundConfig;
  entry: OutboxEntry;
  historyVersion?: number;
  canonicalAgentId: string;
  sceneRegistry: Map<string, BncrSceneRecord>;
  conversationHistories: BncrConversationHistoryMap;
  outboundReplayCache?: BncrOutboundReplayCache;
  historyShardQueue?: BncrHistoryShardQueue;
  defaultAdminAgentId: string;
  defaultPublicAgentId: string;
  now: () => number;
  rememberSessionRoute: BncrRememberSessionRoute;
  enqueueFromReply: BncrEnqueueFromReply;
  setInboundActivity: (accountId: string, at: number) => void;
  scheduleSave: () => void;
  logger?: BncrInboundLogger;
}) {
  const { entry, api, channelId, cfg, canonicalAgentId } = params;
  const route = entry.route;
  const parsed = parseBncrInboundParams({
    accountId: entry.accountId,
    platform: route.platform,
    groupId: route.groupId || '0',
    userId: route.userId || '0',
    isGroup: (route.groupId || '0') !== '0',
    sessionKey: entry.sessionKey,
    type: 'text',
    msg: 'bncr outbound conversation history flush',
    ...(entry.messageId ? { msgId: `bncr-outbound-flush:${entry.messageId}` } : {}),
    clientId: 'bncr-history-system',
  });
  const historyKey = buildBncrConversationHistoryKey(parsed);
  if (!historyKey) return;
  const entries = params.conversationHistories.get(historyKey);
  if (!entries || entries.length === 0) return;
  const sceneForHistory = params.sceneRegistry.get(buildSceneKey(parsed));
  if (sceneForHistory?.historyForce === false) return;
  const sessionAgentId = parseStrictBncrSessionKey(entry.sessionKey)?.inputAgentId;

  await dispatchBncrInbound({
    api,
    channelId,
    cfg,
    parsed,
    canonicalAgentId,
    resolvedAgentId: sceneForHistory?.agentId || sessionAgentId,
    shouldDispatch: true,
    shouldAccumulate: false,
    forceSilentHistoryFlush: true,
    ...(params.historyVersion !== undefined
      ? { forceSilentHistoryFlushVersion: params.historyVersion }
      : {}),
    ...(params.entry.messageId
      ? { forceSilentHistoryFlushMessageId: String(params.entry.messageId).trim() }
      : {}),
    sceneRegistry: params.sceneRegistry,
    conversationHistories: params.conversationHistories,
    outboundReplayCache: params.outboundReplayCache,
    historyShardQueue: params.historyShardQueue,
    defaultAdminAgentId: params.defaultAdminAgentId,
    defaultPublicAgentId: params.defaultPublicAgentId,
    now: params.now,
    rememberSessionRoute: params.rememberSessionRoute,
    enqueueFromReply: params.enqueueFromReply,
    setInboundActivity: params.setInboundActivity,
    scheduleSave: params.scheduleSave,
    logger: params.logger,
  });
}
