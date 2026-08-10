import { DEFAULT_GROUP_HISTORY_LIMIT as DEFAULT_HISTORY_LIMIT } from 'openclaw/plugin-sdk/reply-history';
import { emitBncrLogLine } from '../../core/logging.ts';
import type { BncrSceneRecord } from '../../plugin/channel-runtime-types.ts';
import { buildSceneKey } from '../../plugin/scene-registry.ts';
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
  clearBncrPendingConversationHistory,
  readBncrPendingConversationHistorySnapshot,
  recordBncrPendingConversationMedia,
  recordBncrPendingConversationText,
} from './conversation-history.ts';
import {
  assertInboundMediaBase64Size,
  decodeInboundMediaBase64,
  estimateBase64DecodedBytes,
  type ParsedInbound,
  prepareBncrInboundDispatch,
  resolveBncrInboundConversation,
} from './dispatch-prep.ts';
import {
  type BncrOutboundReplayCache,
  clearBncrOutboundReplay,
  readBncrOutboundReplaySnapshot,
} from './outbound-replay-cache.ts';
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
  resolvedAgentId?: string;
  sceneRegistry: Map<string, BncrSceneRecord>;
  conversationHistories: BncrConversationHistoryMap;
  outboundReplayCache?: BncrOutboundReplayCache;
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
  const { accountId, clientId, msgId, extracted, mimeType, peer } = parsed;
  let shouldDispatch = initialShouldDispatch;

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
  const sceneHistoryLimit =
    sceneRegistry.get(buildSceneKey(parsed))?.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const resolvedHistoryLimit =
    typeof sceneHistoryLimit === 'number' &&
    Number.isFinite(sceneHistoryLimit) &&
    sceneHistoryLimit >= 0
      ? Math.floor(sceneHistoryLimit)
      : DEFAULT_HISTORY_LIMIT;

  let silentHistoryFlush = false;
  let pendingHistoryEntries: BncrHistoryEntry[] = [];
  if (shouldAccumulate) {
    const historyKey = buildBncrConversationHistoryKey(parsed);
    // Record the message first so overflow context includes it
    recordBncrPendingConversationText({
      historyMap: conversationHistories,
      parsed,
      senderDisplayName,
      senderId: senderIdForContext,
      bodyText: rawBody,
      historyLimit: resolvedHistoryLimit,
    });
    await recordBncrPendingConversationMedia({
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

  if (shouldDispatch) {
    pendingHistoryEntries = readBncrPendingConversationHistorySnapshot({
      historyMap: conversationHistories,
      parsed,
      historyLimit: resolvedHistoryLimit,
    });
    if (pendingHistoryEntries.length > 0) {
      clearBncrPendingConversationHistory({
        historyMap: conversationHistories,
        parsed,
        historyLimit: resolvedHistoryLimit,
      });
    }
    const legacyOutboundEntries = readBncrOutboundReplaySnapshot({
      cache: outboundReplayCache,
      conversationHistories,
      parsed,
      accountId,
      excludeMessageId: msgId,
    });
    clearBncrOutboundReplay({
      cache: outboundReplayCache,
      parsed,
      accountId,
    });
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
    if (resolvedHistoryLimit > 0 && pendingHistoryEntries.length > resolvedHistoryLimit) {
      const currentMessageId = String(msgId || '').trim();
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
      }
    }
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
