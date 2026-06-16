import {
  buildBncrPromptVisibleContextFacts,
  buildBncrStructuredContextFactsFromInboundParts,
} from './context-facts.ts';
import type { BncrInboundApi, BncrInboundContextPayload } from './contracts.ts';
import type {
  BncrInboundConversationResolution,
  BncrPreparedInboundSessionContext,
  ParsedInbound,
} from './dispatch-prep.ts';
import { resolveBncrChannelInboundRuntime } from './runtime-compat.ts';

export function buildBncrInboundTurnContext(args: {
  api: BncrInboundApi;
  channelId: string;
  parsed: ParsedInbound;
  msgId?: string | null;
  mimeType?: string;
  mediaPath?: string;
  peer: ParsedInbound['peer'];
  senderIdForContext: string;
  senderDisplayName: string;
  resolution: BncrInboundConversationResolution;
  prepared: BncrPreparedInboundSessionContext;
}): BncrInboundContextPayload | Promise<BncrInboundContextPayload> {
  const {
    api,
    channelId,
    parsed,
    msgId,
    mimeType,
    mediaPath,
    peer,
    senderIdForContext,
    senderDisplayName,
    resolution,
    prepared,
  } = args;
  const structuredContextFacts = buildBncrStructuredContextFactsFromInboundParts({
    channelId,
    parsed,
    resolution,
    prepared: {
      rawBody: prepared.rawBody,
      body: prepared.body,
      mediaPath,
      mediaContentType: mimeType,
    },
    senderIdForContext,
    senderDisplayName,
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

  return resolveBncrChannelInboundRuntime(api).buildContext({
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
      username: senderDisplayName,
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
      bodyForAgent: prepared.rawBody,
      commandBody: prepared.rawBody,
      envelopeFrom: resolution.originatingTo,
      senderLabel: senderDisplayName,
    },
    media: mediaPath
      ? [
          {
            path: mediaPath,
            contentType: mimeType,
            kind: mimeType?.startsWith('image/')
              ? 'image'
              : mimeType?.startsWith('video/')
                ? 'video'
                : mimeType?.startsWith('audio/')
                  ? 'audio'
                  : 'document',
            messageId: msgId ?? undefined,
          },
        ]
      : [],
    supplemental: {
      untrustedContext: supplementalUntrustedContext,
    },
    extra: {
      OriginatingChannel: channelId,
      BncrStructuredContextFacts: structuredContextFacts,
      StructuredContextFacts: structuredContextFacts,
    },
  });
}
