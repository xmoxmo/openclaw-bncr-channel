import { emitBncrLogLine } from '../../core/logging.ts';
import {
  formatDisplayScope,
  normalizeInboundSessionKey,
  withTaskSessionKey,
} from '../../core/targets.ts';
import { buildBncrReplyConfig } from './reply-config.ts';

type ParsedInbound = ReturnType<typeof import('./parse.ts')['parseBncrInboundParams']>;

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

  const command = String(match[1] || '')
    .trim()
    .toLowerCase();
  if (!command) return null;

  const rest = String(match[2] || '').trim();
  const body = command === 'help' ? ['/commands', rest].filter(Boolean).join(' ') : raw;
  return { command, raw, body };
}

export async function handleBncrNativeCommand(params: {
  api: any;
  channelId: string;
  cfg: any;
  parsed: ParsedInbound;
  canonicalAgentId: string;
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
  const {
    api,
    channelId,
    cfg,
    parsed,
    canonicalAgentId,
    rememberSessionRoute,
    enqueueFromReply,
    logger,
  } = params;
  const { accountId, route, peer, sessionKeyfromroute, clientId, extracted, msgId } = parsed;
  const command = parseBncrNativeCommand(extracted.text);
  if (!command) return { handled: false };

  const resolvedRoute = api.runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: channelId,
    accountId,
    peer,
  });

  const baseSessionKey =
    normalizeInboundSessionKey(sessionKeyfromroute, route, canonicalAgentId) ||
    resolvedRoute.sessionKey;
  const taskSessionKey = withTaskSessionKey(baseSessionKey, extracted.taskKey);
  const sessionKey = taskSessionKey || baseSessionKey;
  rememberSessionRoute(baseSessionKey, accountId, route);
  if (taskSessionKey && taskSessionKey !== baseSessionKey)
    rememberSessionRoute(taskSessionKey, accountId, route);

  const displayTo = formatDisplayScope(route);
  const body = command.body;
  if (!clientId) {
    emitBncrLogLine('warn', '[bncr] inbound missing clientId for native command identity');
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
      emitBncrLogLine(
        'warn',
        `[bncr] inbound record native command session failed: ${String(err)}`,
      );
    },
  });

  const effectiveReply = buildBncrReplyConfig(cfg);

  let responded = false;
  await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: effectiveReply.replyCfg,
    dispatcherOptions: {
      deliver: async (
        payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; audioAsVoice?: boolean },
        info?: { kind?: 'tool' | 'block' | 'final' },
      ) => {
        const kind = info?.kind;
        const shouldForwardTool = effectiveReply.blockStreaming && effectiveReply.allowTool;

        if (kind === 'tool' && !shouldForwardTool) {
          return;
        }

        const hasPayload = Boolean(
          payload?.text ||
            payload?.mediaUrl ||
            (Array.isArray(payload?.mediaUrls) && payload.mediaUrls.length > 0),
        );
        if (!hasPayload) return;
        responded = true;
        await enqueueFromReply({
          accountId,
          sessionKey,
          route,
          payload: {
            ...payload,
            kind: kind as 'tool' | 'block' | 'final' | undefined,
            replyToId: msgId || undefined,
          },
        });
      },
    },
    replyOptions: {
      disableBlockStreaming: !effectiveReply.blockStreaming,
      shouldEmitToolResult: effectiveReply.allowTool ? () => true : undefined,
    },
  });

  if (!responded) {
    return { handled: false };
  }

  return { handled: true, command: command.command, sessionKey };
}
