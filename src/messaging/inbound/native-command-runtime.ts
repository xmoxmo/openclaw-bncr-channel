import { emitBncrLogLine } from '../../core/logging.ts';
import {
  formatDisplayScope,
  normalizeInboundSessionKey,
  withTaskSessionKey,
} from '../../core/targets.ts';
import type {
  BncrEnqueueFromReply,
  BncrInboundApi,
  BncrInboundConfig,
  BncrInboundContextPayload,
} from './contracts.ts';
import type { ParsedInbound } from './dispatch-prep.ts';
import { buildBncrNativeReplyDeliveryPayload } from './native-reply-delivery.ts';
import { resolveBncrChannelInboundRuntime } from './runtime-compat.ts';

export function logBncrNativeCommandEvent(
  event: string,
  fields: Record<string, unknown>,
  options?: { debugOnly?: boolean; debugEnabled?: boolean },
) {
  if (options?.debugOnly && !options?.debugEnabled) return;
  emitBncrLogLine('info', `[bncr] native-command ${JSON.stringify({ event, ...fields })}`);
}

export function logBncrNativeCommandSummary(message: string) {
  emitBncrLogLine('info', `[bncr] native-command ${String(message || '').trim()}`);
}

export function buildBncrNativeCommandSummary(args: {
  kind: string;
  command: string;
  accountId: string;
  to: string;
  msgId?: string | null;
  result: string;
}) {
  return `${args.kind} command=${args.command}|accountId=${args.accountId}|to=${args.to}|msgId=${args.msgId || '-'}|result=${args.result}`;
}

export function buildNativeCommandHandledResult(args: {
  command: string;
  sessionKey: string;
  fallbackToAgent?: boolean;
}) {
  return {
    handled: true as const,
    command: args.command,
    sessionKey: args.sessionKey,
    ...(args.fallbackToAgent ? { fallbackToAgent: true } : {}),
  };
}

export function buildBncrNativeCommandSessionState(args: {
  parsed: ParsedInbound;
  canonicalAgentId: string;
  resolvedRoute: { sessionKey: string };
}) {
  const { parsed, canonicalAgentId, resolvedRoute } = args;
  const baseSessionKey =
    normalizeInboundSessionKey(parsed.sessionKeyfromroute, parsed.route, canonicalAgentId) ||
    resolvedRoute.sessionKey;
  const taskSessionKey = withTaskSessionKey(baseSessionKey, parsed.extracted.taskKey);
  const sessionKey = taskSessionKey || baseSessionKey;
  const displayTo = formatDisplayScope(parsed.route);
  const originatingTo = parsed.providedOriginatingTo || displayTo;
  return {
    baseSessionKey,
    taskSessionKey,
    sessionKey,
    displayTo,
    originatingTo,
  };
}

export function createNativeCommandTurnContext(args: {
  api: BncrInboundApi;
  channelId: string;
  accountId: string;
  msgId?: string;
  peer: ParsedInbound['peer'];
  resolvedRoute: { sessionKey: string; agentId: string; mainSessionKey?: string };
  sessionKey: string;
  displayTo: string;
  originatingTo: string;
  senderIdForContext: string;
  senderDisplayName: string;
  body: string;
}): BncrInboundContextPayload | Promise<BncrInboundContextPayload> {
  return resolveBncrChannelInboundRuntime(args.api).buildContext({
    channel: args.channelId,
    provider: args.channelId,
    surface: args.channelId,
    accountId: args.accountId,
    messageId: args.msgId,
    timestamp: Date.now(),
    from: args.senderIdForContext,
    sender: {
      id: args.senderIdForContext,
      name: args.senderDisplayName,
      username: args.senderDisplayName,
    },
    conversation: {
      kind: args.peer.kind,
      id: args.peer.id,
      label: args.displayTo,
      routePeer: {
        kind: args.peer.kind,
        id: args.peer.id,
      },
    },
    route: {
      agentId: args.resolvedRoute.agentId,
      accountId: args.accountId,
      routeSessionKey: args.resolvedRoute.sessionKey,
      dispatchSessionKey: args.sessionKey,
      mainSessionKey: args.resolvedRoute.mainSessionKey,
    },
    reply: {
      to: args.displayTo,
      originatingTo: args.originatingTo,
      replyToId: args.msgId,
    },
    message: {
      inboundEventKind: 'user_request',
      body: args.body,
      rawBody: args.body,
      bodyForAgent: args.body,
      commandBody: args.body,
      envelopeFrom: args.originatingTo,
      senderLabel: args.senderDisplayName,
    },
    commandTurn: {
      kind: 'native',
      source: 'native',
      authorized: true,
      body: args.body,
    },
    access: {
      mentions: {
        canDetectMention: true,
        wasMentioned: true,
        effectiveWasMentioned: true,
      },
      commands: {
        authorized: true,
        allowTextCommands: true,
        useAccessGroups: false,
        authorizers: [],
      },
    },
    extra: {
      OriginatingChannel: args.channelId,
    },
  });
}

export function createNativeCommandReplyDeliverer(args: {
  command: string;
  accountId: string;
  sessionKey: string;
  to: string;
  msgId?: string;
  effectiveReply: { blockStreaming: boolean; allowTool: boolean };
  route: ParsedInbound['route'];
  enqueueFromReply: BncrEnqueueFromReply;
  nativeCommandDebugEnabled: boolean;
  onResponded: () => boolean;
  markResponded: () => void;
}) {
  return async (
    payload: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      audioAsVoice?: boolean;
    },
    info?: { kind?: 'tool' | 'block' | 'final' },
  ) => {
    const kind = info?.kind;
    const deliveryPayload = buildBncrNativeReplyDeliveryPayload({
      payload,
      kind,
      effectiveReply: args.effectiveReply,
      msgId: args.msgId,
    });
    if (!deliveryPayload) return;

    if (!args.onResponded()) {
      logBncrNativeCommandEvent(
        'payload-produced',
        {
          command: args.command,
          accountId: args.accountId,
          sessionKey: args.sessionKey,
          to: args.to,
          msgId: args.msgId || null,
          kind: kind || null,
          fallbackToAgent: false,
        },
        { debugOnly: true, debugEnabled: args.nativeCommandDebugEnabled },
      );
    }

    args.markResponded();
    await args.enqueueFromReply({
      accountId: args.accountId,
      sessionKey: args.sessionKey,
      route: args.route,
      payload: deliveryPayload,
      replyTargetPolicy: 'preserve',
    });
  };
}

export function buildNativeCommandRecordErrorLogger(err: unknown) {
  emitBncrLogLine('warn', `[bncr] inbound record native command session failed: ${String(err)}`);
}

export function resolveNativeCommandDebugEnabled(args: {
  cfg: BncrInboundConfig;
  channelId: string;
}) {
  return args.cfg?.channels?.[args.channelId]?.debug?.verbose === true;
}
