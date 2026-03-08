import fs from 'node:fs';
import { formatDisplayScope, normalizeInboundSessionKey, parseStrictBncrSessionKey, routeScopeToHex, withTaskSessionKey } from '../../core/targets.js';
import { handleBncrNativeCommand } from './commands.js';

type ParsedInbound = ReturnType<typeof import('./parse.js')['parseBncrInboundParams']>;

export async function dispatchBncrInbound(params: {
  api: any;
  channelId: string;
  cfg: any;
  parsed: ParsedInbound;
  rememberSessionRoute: (sessionKey: string, accountId: string, route: any) => void;
  enqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: any;
    payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
    mediaLocalRoots?: readonly string[];
  }) => Promise<void>;
  setInboundActivity: (accountId: string, at: number) => void;
  scheduleSave: () => void;
  logger?: { warn?: (msg: string) => void; error?: (msg: string) => void };
}) {
  const { api, channelId, cfg, parsed, rememberSessionRoute, enqueueFromReply, setInboundActivity, scheduleSave, logger } = params;
  const { accountId, route, peer, sessionKeyfromroute, text, msgType, mediaBase64, mediaPathFromTransfer, mimeType, fileName, msgId, extracted, platform, groupId, userId } = parsed;

  const nativeCommand = await handleBncrNativeCommand({
    api,
    channelId,
    cfg,
    parsed,
    rememberSessionRoute,
    enqueueFromReply,
  });
  if (nativeCommand.handled) {
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

  const resolvedRoute = api.runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: channelId,
    accountId,
    peer,
  });

  const baseSessionKey = normalizeInboundSessionKey(sessionKeyfromroute, route) || resolvedRoute.sessionKey;
  const agentText = extracted.text;
  const taskSessionKey = withTaskSessionKey(baseSessionKey, extracted.taskKey);
  const sessionKey = taskSessionKey || baseSessionKey;

  rememberSessionRoute(baseSessionKey, accountId, route);
  if (taskSessionKey && taskSessionKey !== baseSessionKey) {
    rememberSessionRoute(taskSessionKey, accountId, route);
  }

  const storePath = api.runtime.channel.session.resolveStorePath(cfg?.session?.store, {
    agentId: resolvedRoute.agentId,
  });

  let mediaPath: string | undefined;
  if (mediaBase64) {
    const mediaBuf = Buffer.from(mediaBase64, 'base64');
    const saved = await api.runtime.channel.media.saveMediaBuffer(
      mediaBuf,
      mimeType,
      'inbound',
      30 * 1024 * 1024,
      fileName,
    );
    mediaPath = saved.path;
  } else if (mediaPathFromTransfer && fs.existsSync(mediaPathFromTransfer)) {
    mediaPath = mediaPathFromTransfer;
  }

  const rawBody = agentText || (msgType === 'text' ? '' : `[${msgType}]`);
  const body = api.runtime.channel.reply.formatAgentEnvelope({
    channel: 'Bncr',
    from: `${platform}:${groupId}:${userId}`,
    timestamp: Date.now(),
    previousTimestamp: api.runtime.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey,
    }),
    envelope: api.runtime.channel.reply.resolveEnvelopeFormatOptions(cfg),
    body: rawBody,
  });

  const displayTo = formatDisplayScope(route);
  const senderIdForContext = parseStrictBncrSessionKey(baseSessionKey)?.scopeHex || routeScopeToHex(route);
  const ctxPayload = api.runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    MediaPath: mediaPath,
    MediaType: mimeType,
    From: `${channelId}:${platform}:${groupId}:${userId}`,
    To: displayTo,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: peer.kind,
    ConversationLabel: displayTo,
    SenderId: senderIdForContext,
    Provider: channelId,
    Surface: channelId,
    MessageSid: msgId,
    Timestamp: Date.now(),
    OriginatingChannel: channelId,
    OriginatingTo: displayTo,
  });

  await api.runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey,
    ctx: ctxPayload,
    onRecordError: (err: unknown) => {
      logger?.warn?.(`bncr: record session failed: ${String(err)}`);
    },
  });

  const inboundAt = Date.now();
  setInboundActivity(accountId, inboundAt);
  scheduleSave();

  await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    replyOptions: {
      disableBlockStreaming: true,
    },
    dispatcherOptions: {
      deliver: async (
        payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
        info?: { kind?: 'tool' | 'block' | 'final' },
      ) => {
        if (info?.kind && info.kind !== 'final') return;

        await enqueueFromReply({
          accountId,
          sessionKey,
          route,
          payload,
        });
      },
      onError: (err: unknown) => {
        logger?.error?.(`bncr reply failed: ${String(err)}`);
      },
    },
  });

  return {
    accountId,
    sessionKey,
    taskKey: extracted.taskKey ?? null,
    msgId: msgId ?? null,
  };
}
