import { formatDisplayScope, normalizeInboundSessionKey, withTaskSessionKey } from '../../core/targets.js';

type ParsedInbound = ReturnType<typeof import('./parse.js')['parseBncrInboundParams']>;

type NativeCommand =
  | 'help'
  | 'commands'
  | 'status'
  | 'usage'
  | 'whoami'
  | 'session'
  | 'model'
  | 'models'
  | 'new'
  | 'reset'
  | 'clear'
  | 'compact'
  | 'stop'
  | 'reasoning'
  | 'verbose'
  | 'think'
  | 'elevated';

const SUPPORTED_NATIVE_COMMANDS = new Set<NativeCommand>([
  'help',
  'commands',
  'status',
  'usage',
  'whoami',
  'session',
  'model',
  'models',
  'new',
  'reset',
  'clear',
  'compact',
  'stop',
  'reasoning',
  'verbose',
  'think',
  'elevated',
]);

export function parseBncrNativeCommand(text: string): { command: NativeCommand; raw: string; body: string } | null {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const match = raw.match(/^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const command = String(match[1] || '').trim().toLowerCase() as NativeCommand;
  if (!SUPPORTED_NATIVE_COMMANDS.has(command)) return null;

  const rest = String(match[2] || '').trim();
  const body = command === 'clear' ? ['/new', rest].filter(Boolean).join(' ') : raw;
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
}): Promise<{ handled: false } | { handled: true; command: NativeCommand; sessionKey: string }> {
  const { api, channelId, cfg, parsed, rememberSessionRoute, enqueueFromReply } = params;
  const { accountId, route, peer, sessionKeyfromroute, extracted } = parsed;
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

  const ctxPayload = api.runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    BodyForCommands: body,
    From: `${channelId}:${route.platform}:${route.groupId}:${route.userId}`,
    To: displayTo,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: peer.kind,
    ConversationLabel: displayTo,
    Provider: channelId,
    Surface: channelId,
    Timestamp: Date.now(),
    OriginatingChannel: channelId,
    OriginatingTo: displayTo,
  });

  await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    replyOptions: {
      disableBlockStreaming: true,
    },
    dispatcherOptions: {
      deliver: async (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }, info?: { kind?: 'tool' | 'block' | 'final' }) => {
        if (info?.kind && info.kind !== 'final') return;
        await enqueueFromReply({
          accountId,
          sessionKey,
          route,
          payload,
        });
      },
    },
  });

  return { handled: true, command: command.command, sessionKey };
}
