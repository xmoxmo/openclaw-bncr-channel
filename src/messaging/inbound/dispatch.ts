import { DEFAULT_GROUP_HISTORY_LIMIT } from 'openclaw/plugin-sdk/reply-history';
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
  assertInboundMediaBase64Size,
  decodeInboundMediaBase64,
  estimateBase64DecodedBytes,
  type ParsedInbound,
  prepareBncrInboundDispatch,
  resolveBncrInboundConversation,
} from './dispatch-prep.ts';
import {
  type BncrGroupHistoryMap,
  type BncrHistoryEntry,
  buildBncrGroupHistoryKey,
  clearBncrPendingGroupHistory,
  readBncrPendingGroupHistorySnapshot,
  recordBncrPendingGroupMedia,
  recordBncrPendingGroupText,
} from './group-history.ts';
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
  groupHistories: BncrGroupHistoryMap;
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
    groupHistories = new Map(),
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
    parsed.peer.kind === 'group'
      ? (sceneRegistry.get(buildSceneKey(parsed))?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT)
      : DEFAULT_GROUP_HISTORY_LIMIT;
  const resolvedHistoryLimit =
    typeof sceneHistoryLimit === 'number' &&
    Number.isFinite(sceneHistoryLimit) &&
    sceneHistoryLimit >= 0
      ? Math.floor(sceneHistoryLimit)
      : DEFAULT_GROUP_HISTORY_LIMIT;

  let silentHistoryFlush = false;
  let pendingHistoryEntries: BncrHistoryEntry[] = [];
  if (!shouldDispatch && shouldAccumulate) {
    const historyKey = buildBncrGroupHistoryKey(parsed);
    // Record the message first so overflow context includes it
    recordBncrPendingGroupText({
      historyMap: groupHistories,
      parsed,
      senderDisplayName,
      senderId: senderIdForContext,
      bodyText: rawBody,
      historyLimit: resolvedHistoryLimit,
    });
    await recordBncrPendingGroupMedia({
      historyMap: groupHistories,
      parsed,
      senderDisplayName,
      senderId: senderIdForContext,
      bodyText: rawBody,
      mediaItems,
      mediaContentType: mediaContentType || mimeType,
      historyLimit: resolvedHistoryLimit,
    });
    if (historyKey && parsed.peer.kind === 'group') {
      const entries = groupHistories.get(historyKey);
      if (entries && resolvedHistoryLimit > 0 && entries.length >= resolvedHistoryLimit) {
        const sceneForHistory = sceneRegistry.get(buildSceneKey(parsed));
        const historyForce = sceneForHistory?.historyForce !== false;
        if (historyForce) {
          pendingHistoryEntries = readBncrPendingGroupHistorySnapshot({
            historyMap: groupHistories,
            parsed,
            historyLimit: resolvedHistoryLimit,
          });
          clearBncrPendingGroupHistory({
            historyMap: groupHistories,
            parsed,
            historyLimit: resolvedHistoryLimit,
          });
          shouldDispatch = true;
          silentHistoryFlush = true;
        }
      }
    }
  }

  if (shouldDispatch && !silentHistoryFlush && parsed.peer.kind === 'group') {
    pendingHistoryEntries = readBncrPendingGroupHistorySnapshot({
      historyMap: groupHistories,
      parsed,
      historyLimit: resolvedHistoryLimit,
    });
    if (pendingHistoryEntries.length > 0) {
      clearBncrPendingGroupHistory({
        historyMap: groupHistories,
        parsed,
        historyLimit: resolvedHistoryLimit,
      });
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
    groupHistories,
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

  if (shouldDispatch && pendingHistoryEntries.length === 0) {
    clearBncrPendingGroupHistory({
      historyMap: groupHistories,
      parsed,
      historyLimit: resolvedHistoryLimit,
    });
  }

  return {
    accountId,
    sessionKey,
    taskKey: extracted.taskKey ?? null,
    msgId: msgId ?? null,
  };
}
