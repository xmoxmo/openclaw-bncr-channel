import { formatDisplayScope, normalizeInboundSessionKey, parseStrictBncrSessionKey, routeScopeToHex, withTaskSessionKey } from '../../core/targets.js';

type ParsedInbound = ReturnType<typeof import('./parse.js')['parseBncrInboundParams']>;

type NativeCommand = {
  command: string;
  raw: string;
  body: string;
};

export function parseBncrNativeCommand(text: string): NativeCommand | null {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const match = raw.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const command = String(match[1] || '').trim().toLowerCase();
  if (!command) return null;

  const body = raw;
  return { command, raw, body };
}

export async function handleBncrNativeCommand(params: {
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
  logger?: { warn?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ handled: false } | { handled: true; command: string; sessionKey: string }> {
  const { api, channelId, cfg, parsed, rememberSessionRoute, enqueueFromReply, logger } = params;
  const { accountId, route, peer, sessionKeyfromroute, clientId, extracted, msgId } = parsed;
  const command = parseBncrNativeCommand(extracted.text);
  if (!command) return { handled: false };

  const resolvedRoute = api.runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: channelId,
    accountId,
    peer,
  });

  const baseSessionKey = normalizeInboundSessionKey(sessionKeyfromroute, route) || resolvedRoute.sessionKey;
  const taskSessionKey = withTaskSessionKey(baseSessionKey, extracted.taskKey);
  const sessionKey = taskSessionKey || baseSessionKey;
  rememberSessionRoute(baseSessionKey, accountId, route);
  if (taskSessionKey && taskSessionKey !== baseSessionKey) rememberSessionRoute(taskSessionKey, accountId, route);

  const displayTo = formatDisplayScope(route);
  const body = command.body;
  if (!clientId) {
    logger?.warn?.('bncr: missing clientId for inbound command identity');
    return { handled: false };
  }
  const senderIdForContext = clientId;
  const senderDisplayName = 'bncr-client';
  const storePath = api.runtime.channel.session.resolveStorePath(cfg?.session?.store, {
    agentId: resolvedRoute.agentId,
  });

  const ctxPayload = api.runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    BodyForCommands: body,
    From: senderIdForContext,
    To: displayTo,
    SessionKey: sessionKey,
    CommandTargetSessionKey: sessionKey,
    CommandSource: 'native',
    CommandAuthorized: true,
    AccountId: accountId,
    ChatType: peer.kind,
    ConversationLabel: displayTo,
    SenderId: senderIdForContext,
    SenderName: senderDisplayName,
    SenderUsername: senderDisplayName,
    Provider: channelId,
    Surface: channelId,
    WasMentioned: true,
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
      logger?.warn?.(`bncr: record native command session failed: ${String(err)}`);
    },
  });

  let responded = false;
  await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    replyOptions: {
      disableBlockStreaming: true,
    },
    dispatcherOptions: {
      deliver: async (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }, info?: { kind?: 'tool' | 'block' | 'final' }) => {
        if (info?.kind && info.kind !== 'final') return;
        const hasPayload = Boolean(payload?.text || payload?.mediaUrl || (Array.isArray(payload?.mediaUrls) && payload.mediaUrls.length > 0));
        if (!hasPayload) return;
        responded = true;
        await enqueueFromReply({
          accountId,
          sessionKey,
          route,
          payload,
        });
      },
    },
  });

  if (!responded) {
    return { handled: false };
  }

  return { handled: true, command: command.command, sessionKey };
}
