import type { HistoryMediaEntry } from 'openclaw/plugin-sdk/reply-history';
import { readBncrSessionUpdatedAt } from '../../openclaw/inbound-session-runtime.ts';
import {
  formatOpenClawAgentEnvelope,
  resolveOpenClawEnvelopeFormatOptions,
} from '../../openclaw/reply-runtime.ts';
import {
  buildBncrPromptVisibleContextFacts,
  buildBncrStructuredContextFactsFromInboundParts,
} from './context-facts.ts';
import type { BncrInboundApi, BncrInboundConfig, BncrInboundContextPayload } from './contracts.ts';
import type { BncrConversationHistoryMap, BncrHistoryEntry } from './conversation-history.ts';
import type {
  BncrInboundConversationResolution,
  BncrPreparedInboundSessionContext,
  ParsedInbound,
} from './dispatch-prep.ts';
import { resolveBncrChannelInboundRuntime } from './runtime-compat.ts';

function dedupeBncrTurnMedia(entries: readonly HistoryMediaEntry[]): HistoryMediaEntry[] {
  const seen = new Set<string>();
  const result: HistoryMediaEntry[] = [];
  for (const item of entries) {
    const key = `${item.path ?? ''}:${item.messageId ?? ''}`;
    if (key && seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function buildBncrParticipantsMap(args: {
  entries: readonly BncrHistoryEntry[];
  parsed: ParsedInbound;
  currentSenderId: string;
  currentSenderName: string;
  currentSenderUsername?: string;
  currentSenderIsAdmin: boolean;
  currentSenderIsOwner: boolean;
  currentSenderIsAuthorized: boolean;
}): Record<
  string,
  {
    name: string;
    username?: string;
    isBot?: boolean;
    isAdmin?: boolean;
    isOwner?: boolean;
    isAuthorizedSender?: boolean;
    role?: 'owner' | 'admin' | 'user';
    displayName?: string;
  }
> {
  const map: Record<
    string,
    {
      name: string;
      username?: string;
      isBot?: boolean;
      isAdmin?: boolean;
      isOwner?: boolean;
      isAuthorizedSender?: boolean;
      role?: 'owner' | 'admin' | 'user';
      displayName?: string;
    }
  > = {};
  map[args.currentSenderId] = {
    name: args.currentSenderName,
    ...(args.currentSenderUsername ? { username: args.currentSenderUsername } : {}),
    isBot: false,
    ...(args.currentSenderIsAdmin ? { isAdmin: true } : {}),
    ...(args.currentSenderIsOwner ? { isOwner: true } : {}),
    ...(args.currentSenderIsAuthorized ? { isAuthorizedSender: true } : {}),
    role: args.currentSenderIsOwner ? 'owner' : args.currentSenderIsAdmin ? 'admin' : 'user',
    displayName: args.currentSenderName,
  };
  for (const entry of args.entries) {
    if (!entry.senderId || map[entry.senderId]) continue;
    const isBot = entry.role === 'assistant';
    map[entry.senderId] = {
      name: entry.sender || entry.senderId,
      ...(isBot ? { isBot: true } : {}),
      role: isBot ? 'admin' : 'user',
      displayName: entry.sender || entry.senderId,
    };
  }
  return map;
}

function parseSlashCommandName(body: string): string | undefined {
  const raw = String(body || '').trim();
  if (!raw.startsWith('/')) return undefined;
  return raw.slice(1).split(/\s+/, 1)[0]?.split('@', 1)[0] || undefined;
}

function applyBncrLegacyCommandFields(args: {
  ctx: BncrInboundContextPayload;
  channelId: string;
  senderIdForContext: string;
  fromOverride?: string;
  resolution: BncrInboundConversationResolution;
  rawBody: string;
  ownerAllowFrom?: string[];
  isAuthorizedTextCommand: boolean;
}) {
  const { ctx, channelId, senderIdForContext, fromOverride, resolution, rawBody, ownerAllowFrom } =
    args;
  ctx.From = fromOverride || senderIdForContext;
  ctx.To = resolution.canonicalTo;
  ctx.SenderId = senderIdForContext;
  ctx.OriginatingChannel = channelId;
  if (ownerAllowFrom?.length) ctx.OwnerAllowFrom = ownerAllowFrom;
  if (args.isAuthorizedTextCommand) {
    ctx.CommandAuthorized = true;
    ctx.CommandSource = 'text';
    ctx.CommandTurn = {
      kind: 'text-slash',
      source: 'text',
      authorized: true,
      commandName: parseSlashCommandName(rawBody),
      body: rawBody,
    };
  }
  return ctx;
}

export function buildBncrInboundTurnContext(args: {
  api: BncrInboundApi;
  cfg: BncrInboundConfig;
  channelId: string;
  parsed: ParsedInbound;
  msgId?: string | null;
  peer: ParsedInbound['peer'];
  senderIdForContext: string;
  senderDisplayName: string;
  ownerAllowFrom?: string[];
  bridgeSenderId?: string;
  bridgeSenderName?: string;
  resolution: BncrInboundConversationResolution;
  prepared: BncrPreparedInboundSessionContext;
  conversationHistories: BncrConversationHistoryMap;
  shouldDispatch: boolean;
  historyLimit?: number;
  silentHistoryFlush?: boolean;
  pendingHistoryEntries?: readonly BncrHistoryEntry[];
}): BncrInboundContextPayload | Promise<BncrInboundContextPayload> {
  const {
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
    shouldDispatch,
  } = args;
  const pendingHistoryEntries = Array.isArray(args.pendingHistoryEntries)
    ? args.pendingHistoryEntries
    : [];
  const silentHistoryFlush = args.silentHistoryFlush === true;
  const contextEntries = pendingHistoryEntries;
  const flushSenderId = 'bncr-history-system';
  const flushSenderName = 'Bncr History System';
  const flushRawBody =
    'This message was automatically generated by the system for conversation context accumulation. Do not reply to the user. Output exactly NO_REPLY.';
  const effectiveSenderId = silentHistoryFlush ? flushSenderId : senderIdForContext;
  const effectiveSenderDisplayName = silentHistoryFlush ? flushSenderName : senderDisplayName;
  const effectiveRawBody = silentHistoryFlush ? flushRawBody : prepared.rawBody;
  const envelopeOptions = resolveOpenClawEnvelopeFormatOptions(api, cfg);
  const effectiveBody = silentHistoryFlush
    ? formatOpenClawAgentEnvelope(api, {
        channel: 'Bncr',
        from: resolution.canonicalTo,
        timestamp: Date.now(),
        previousTimestamp: readBncrSessionUpdatedAt(api, {
          storePath: prepared.storePath,
          sessionKey: resolution.dispatchSessionKey,
        }),
        envelope: envelopeOptions,
        body: effectiveRawBody,
      })
    : prepared.body;
  const senderIsOwner = parsed.isAdmin === true || Boolean(ownerAllowFrom?.length);
  const senderIsAuthorized = senderIsOwner;
  const inboundHistory = undefined;
  const structuredContextEntries = shouldDispatch
    ? contextEntries.map((entry) => ({
        messageId: entry.messageId,
        timestamp: entry.timestamp,
        role: entry.role || 'user',
        sender: entry.sender,
        senderId: entry.senderId,
        content: entry.body,
        media: (entry.media || []).map((item: HistoryMediaEntry) => ({
          type: item.kind || 'document',
          path: item.path,
          contentType: item.contentType,
          messageId: item.messageId,
        })),
      }))
    : [];
  const isGroupChat = parsed.isGroup === true;
  const participants = isGroupChat
    ? buildBncrParticipantsMap({
        entries: contextEntries,
        parsed,
        currentSenderId: effectiveSenderId,
        currentSenderName: effectiveSenderDisplayName,
        currentSenderUsername: parsed.userName,
        currentSenderIsAdmin: parsed.isAdmin === true,
        currentSenderIsOwner: senderIsOwner,
        currentSenderIsAuthorized: senderIsAuthorized,
      })
    : null;
  const structuredContextFacts = buildBncrStructuredContextFactsFromInboundParts({
    channelId,
    parsed,
    resolution,
    prepared: {
      rawBody: effectiveRawBody,
      body: typeof effectiveBody === 'string' ? effectiveBody : prepared.body,
      mediaItems: silentHistoryFlush ? [] : prepared.mediaItems,
    },
    senderIdForContext: effectiveSenderId,
    senderDisplayName: effectiveSenderDisplayName,
    bridgeSenderId,
    bridgeSenderName,
    senderIsOwner,
    senderIsAuthorized,
    conversationHistoryContext: structuredContextEntries,
    participants,
    isGroupChat,
    groupSubject: parsed.groupName,
  });
  const promptVisibleContextFacts = buildBncrPromptVisibleContextFacts(structuredContextFacts);
  const supplementalUntrustedContext = [
    ...(Object.keys(promptVisibleContextFacts).length
      ? [
          {
            label: 'Bncr inbound context',
            source: channelId,
            type: 'bncr.inbound_context',
            payload: {
              ...promptVisibleContextFacts,
              ...(silentHistoryFlush ? { historyFlush: true } : {}),
            },
          },
        ]
      : []),
  ];
  const platformWantsReply = parsed.shouldRespond === true;
  const wasMentioned = parsed.isBotMentioned === true || platformWantsReply;
  const isAuthorizedTextCommand = Boolean(ownerAllowFrom?.length);
  const bodyForAgent = typeof effectiveBody === 'string' ? effectiveBody : prepared.body;
  const currentTurnMedia = (silentHistoryFlush ? [] : prepared.mediaItems).map((item) => ({
    path: item.path,
    contentType: item.contentType,
    kind: item.kind,
    messageId: msgId ?? undefined,
  }));
  const media = dedupeBncrTurnMedia(currentTurnMedia);

  return Promise.resolve(
    resolveBncrChannelInboundRuntime(api).buildContext({
      channel: channelId,
      provider: channelId,
      surface: channelId,
      accountId: resolution.accountId,
      messageId: msgId,
      timestamp: Date.now(),
      from: effectiveSenderId,
      sender: {
        id: effectiveSenderId,
        name: effectiveSenderDisplayName,
        username: silentHistoryFlush
          ? effectiveSenderDisplayName
          : parsed.userName || effectiveSenderDisplayName,
      },
      conversation: {
        kind: resolution.chatType,
        id: peer.id,
        label: resolution.canonicalTo,
        routePeer: {
          kind: peer.kind,
          id: peer.id,
        },
      },
      route: {
        agentId: resolution.resolvedRoute.agentId,
        accountId: resolution.accountId,
        routeSessionKey: resolution.resolvedRoute.sessionKey,
        dispatchSessionKey: resolution.dispatchSessionKey,
        mainSessionKey: resolution.resolvedRoute.mainSessionKey,
      },
      reply: {
        to: resolution.canonicalTo,
        originatingTo: resolution.originatingTo,
        rawTo: resolution.rawTo,
      },
      message: {
        inboundEventKind: 'user_request',
        body: typeof effectiveBody === 'string' ? effectiveBody : prepared.body,
        rawBody: effectiveRawBody,
        bodyForAgent,
        inboundHistory,
        commandBody: effectiveRawBody,
        envelopeFrom: resolution.originatingTo,
        senderLabel: effectiveSenderDisplayName,
      },
      ...(isAuthorizedTextCommand
        ? {
            commandTurn: {
              kind: 'text-slash' as const,
              source: 'text' as const,
              authorized: true,
              commandName: parseSlashCommandName(prepared.rawBody),
              body: prepared.rawBody,
            },
          }
        : {}),
      media,
      access: {
        mentions: {
          canDetectMention: true,
          wasMentioned,
          effectiveWasMentioned: wasMentioned,
        },
        ...(isAuthorizedTextCommand
          ? {
              commands: {
                authorized: true,
                allowTextCommands: true,
                useAccessGroups: false,
                authorizers: [],
              },
            }
          : {}),
      },
      supplemental: {
        untrustedContext: supplementalUntrustedContext,
      },
      extra: {
        OriginatingChannel: channelId,
        ...(parsed.isGroup === true && parsed.groupName ? { GroupSubject: parsed.groupName } : {}),
        ...(ownerAllowFrom?.length ? { OwnerAllowFrom: ownerAllowFrom } : {}),
        BncrStructuredContextFacts: structuredContextFacts,
        StructuredContextFacts: structuredContextFacts,
      },
    }),
  ).then((ctx) =>
    applyBncrLegacyCommandFields({
      ctx,
      channelId,
      senderIdForContext: effectiveSenderId,
      fromOverride: effectiveSenderId,
      resolution,
      rawBody: effectiveRawBody,
      ownerAllowFrom,
      isAuthorizedTextCommand,
    }),
  );
}
