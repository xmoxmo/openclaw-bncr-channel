import { emitBncrLogLine } from '../../core/logging.ts';
import type { BncrSceneRecord } from '../../plugin/channel-runtime-types.ts';
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
  clearBncrPendingGroupHistory,
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
    shouldDispatch = true,
    shouldAccumulate = shouldDispatch,
    resolvedAgentId,
    sceneRegistry,
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
    resolution,
    prepared,
    groupHistories,
    shouldDispatch,
  });

  if (!shouldDispatch && shouldAccumulate) {
    recordBncrPendingGroupText({
      historyMap: groupHistories,
      parsed,
      senderDisplayName,
      bodyText: rawBody,
    });
    await recordBncrPendingGroupMedia({
      historyMap: groupHistories,
      parsed,
      senderDisplayName,
      bodyText: rawBody,
      mediaItems,
      mediaContentType: mediaContentType || mimeType,
    });
  }

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
    setInboundActivity,
    scheduleSave,
    enqueueFromReply,
  });

  if (shouldDispatch) {
    clearBncrPendingGroupHistory({ historyMap: groupHistories, parsed });
  }

  return {
    accountId,
    sessionKey,
    taskKey: extracted.taskKey ?? null,
    msgId: msgId ?? null,
  };
}
