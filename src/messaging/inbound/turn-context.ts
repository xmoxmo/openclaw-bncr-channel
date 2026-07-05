import { readBncrSessionUpdatedAt } from '../../openclaw/inbound-session-runtime.ts';
import { resolveOpenClawEnvelopeFormatOptions } from '../../openclaw/reply-runtime.ts';
import {
  buildBncrPromptVisibleContextFacts,
  buildBncrStructuredContextFactsFromInboundParts,
} from './context-facts.ts';
import type { BncrInboundApi, BncrInboundConfig, BncrInboundContextPayload } from './contracts.ts';
import type {
  BncrInboundConversationResolution,
  BncrPreparedInboundSessionContext,
  ParsedInbound,
} from './dispatch-prep.ts';
import {
  type BncrGroupHistoryMap,
  buildBncrInboundHistory,
  buildBncrPendingGroupContext,
} from './group-history.ts';
import { resolveBncrChannelInboundRuntime } from './runtime-compat.ts';

function parseSlashCommandName(body: string): string | undefined {
  const raw = String(body || '').trim();
  if (!raw.startsWith('/')) return undefined;
  return raw.slice(1).split(/\s+/, 1)[0]?.split('@', 1)[0] || undefined;
}

function applyBncrLegacyCommandFields(args: {
  ctx: BncrInboundContextPayload;
  channelId: string;
  senderIdForContext: string;
  resolution: BncrInboundConversationResolution;
  rawBody: string;
  ownerAllowFrom?: string[];
  isAuthorizedTextCommand: boolean;
}) {
  const { ctx, channelId, senderIdForContext, resolution, rawBody, ownerAllowFrom } = args;
  ctx.From = senderIdForContext;
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
  groupHistories: BncrGroupHistoryMap;
  shouldDispatch: boolean;
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
    groupHistories,
    shouldDispatch,
  } = args;
  const senderIsOwner = parsed.isAdmin === true || Boolean(ownerAllowFrom?.length);
  const senderIsAuthorized = senderIsOwner;
  const structuredContextFacts = buildBncrStructuredContextFactsFromInboundParts({
    channelId,
    parsed,
    resolution,
    prepared: {
      rawBody: prepared.rawBody,
      body: prepared.body,
      mediaItems: prepared.mediaItems,
    },
    senderIdForContext,
    senderDisplayName,
    bridgeSenderId,
    bridgeSenderName,
    senderIsOwner,
    senderIsAuthorized,
  });
  const promptVisibleContextFacts = buildBncrPromptVisibleContextFacts(structuredContextFacts);
  const supplementalUntrustedContext = Object.keys(promptVisibleContextFacts).length
    ? [
        {
          label: 'Bncr inbound context',
          source: channelId,
          type: 'bncr.inbound_context',
          payload: promptVisibleContextFacts,
        },
      ]
    : [];
  const platformWantsReply = parsed.shouldRespond === true;
  const wasMentioned = parsed.isBotMentioned === true || platformWantsReply;
  const isAuthorizedTextCommand = Boolean(ownerAllowFrom?.length);
  const bodyForAgent =
    shouldDispatch && parsed.peer.kind === 'group'
      ? buildBncrPendingGroupContext({
          api,
          historyMap: groupHistories,
          parsed,
          channelLabel: resolution.canonicalTo,
          currentTimestamp: Date.now(),
          previousTimestamp: readBncrSessionUpdatedAt(api, {
            storePath: prepared.storePath,
            sessionKey: resolution.dispatchSessionKey,
          }),
          envelope: resolveOpenClawEnvelopeFormatOptions(api, cfg),
          currentMessage: prepared.body,
        })
      : prepared.body;
  const inboundHistory =
    shouldDispatch && parsed.peer.kind === 'group'
      ? buildBncrInboundHistory({ historyMap: groupHistories, parsed })
      : undefined;

  return Promise.resolve(
    resolveBncrChannelInboundRuntime(api).buildContext({
      channel: channelId,
      provider: channelId,
      surface: channelId,
      accountId: resolution.accountId,
      messageId: msgId,
      timestamp: Date.now(),
      from: senderIdForContext,
      sender: {
        id: senderIdForContext,
        name: senderDisplayName,
        username: parsed.userName || senderDisplayName,
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
      },
      message: {
        inboundEventKind: 'user_request',
        body: prepared.body,
        rawBody: prepared.rawBody,
        bodyForAgent,
        inboundHistory,
        commandBody: prepared.rawBody,
        envelopeFrom: resolution.originatingTo,
        senderLabel: senderDisplayName,
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
      media:
        prepared.mediaItems.length > 0
          ? prepared.mediaItems.map((item) => ({
              path: item.path,
              contentType: item.contentType,
              kind: item.kind,
              messageId: msgId ?? undefined,
            }))
          : [],
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
        ...(ownerAllowFrom?.length ? { OwnerAllowFrom: ownerAllowFrom } : {}),
        BncrStructuredContextFacts: structuredContextFacts,
        StructuredContextFacts: structuredContextFacts,
      },
    }),
  ).then((ctx) =>
    applyBncrLegacyCommandFields({
      ctx,
      channelId,
      senderIdForContext,
      resolution,
      rawBody: prepared.rawBody,
      ownerAllowFrom,
      isAuthorizedTextCommand,
    }),
  );
}
