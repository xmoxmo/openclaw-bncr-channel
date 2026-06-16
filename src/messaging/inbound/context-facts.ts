export type BncrStructuredContextFactsInput = {
  channelId: string;
  accountId: string;
  route: {
    agentId?: string;
    routeSessionKey?: string;
    dispatchSessionKey?: string;
    mainSessionKey?: string;
  };
  conversation: {
    kind: string;
    id: string;
    label: string;
  };
  reply: {
    to: string;
    originatingTo: string;
  };
  sender: {
    id: string;
    displayName?: string;
  };
  message: {
    id?: string | null;
    rawBody: string;
    bodyForAgent?: string;
    commandBody?: string;
    envelopeBody?: string;
  };
  media?: Array<{
    path: string;
    contentType?: string;
    kind?: string;
    messageId?: string;
  }>;
};

export function buildBncrStructuredContextFacts(input: BncrStructuredContextFactsInput) {
  const rawBody = input.message.rawBody;
  return {
    channel: {
      id: input.channelId,
      accountId: input.accountId,
    },
    route: {
      agentId: input.route.agentId,
      routeSessionKey: input.route.routeSessionKey,
      dispatchSessionKey: input.route.dispatchSessionKey,
      mainSessionKey: input.route.mainSessionKey,
    },
    conversation: {
      kind: input.conversation.kind,
      id: input.conversation.id,
      label: input.conversation.label,
    },
    reply: {
      to: input.reply.to,
      originatingTo: input.reply.originatingTo,
    },
    sender: {
      id: input.sender.id,
      displayName: input.sender.displayName || input.sender.id,
    },
    message: {
      id: input.message.id || undefined,
      rawBody,
      bodyForAgent: input.message.bodyForAgent ?? rawBody,
      commandBody: input.message.commandBody ?? rawBody,
      envelopeBody: input.message.envelopeBody,
    },
    media: (input.media || []).map((item) => ({
      path: item.path,
      contentType: item.contentType,
      kind: item.kind,
      messageId: item.messageId,
    })),
  };
}

// Keep this payload intentionally small: OpenClaw already renders standard
// conversation/sender/message metadata as untrusted context. Only include
// bncr-specific facts that are not otherwise visible to the model, so normal
// text turns do not get a duplicate "Bncr inbound context" JSON block.
export function buildBncrPromptVisibleContextFacts(
  facts: ReturnType<typeof buildBncrStructuredContextFacts>,
) {
  const result: {
    reply?: {
      to: string;
      originatingTo: string;
    };
    media?: Array<{
      contentType?: string;
      kind?: string;
      messageId?: string;
    }>;
  } = {};

  if (facts.reply.originatingTo !== facts.reply.to) {
    result.reply = {
      to: facts.reply.to,
      originatingTo: facts.reply.originatingTo,
    };
  }

  if (facts.media.length > 0) {
    result.media = facts.media.map((item) => ({
      contentType: item.contentType,
      kind: item.kind,
      messageId: item.messageId,
    }));
  }

  return result;
}

function inferBncrStructuredMediaKind(contentType: string | undefined) {
  if (contentType?.startsWith('image/')) return 'image';
  if (contentType?.startsWith('video/')) return 'video';
  if (contentType?.startsWith('audio/')) return 'audio';
  return 'document';
}

export type BncrStructuredContextFactsFromInboundPartsInput = {
  channelId: string;
  parsed: {
    accountId: string;
    peer: {
      kind: string;
      id: string;
    };
    clientId?: string;
    msgId?: string;
    mimeType?: string;
  };
  resolution: {
    chatType: string;
    canonicalTo: string;
    originatingTo: string;
    resolvedRoute: {
      agentId?: string;
      sessionKey?: string;
      mainSessionKey?: string;
    };
    dispatchSessionKey?: string;
  };
  prepared: {
    rawBody: string;
    body?: string;
    mediaPath?: string | null;
    mediaContentType?: string;
  };
  senderIdForContext: string;
  senderDisplayName?: string;
};

export function buildBncrStructuredContextFactsFromInboundParts(
  input: BncrStructuredContextFactsFromInboundPartsInput,
) {
  const mediaPath = input.prepared.mediaPath || undefined;
  const mediaContentType = input.prepared.mediaContentType || input.parsed.mimeType;
  return buildBncrStructuredContextFacts({
    channelId: input.channelId,
    accountId: input.parsed.accountId,
    route: {
      agentId: input.resolution.resolvedRoute.agentId,
      routeSessionKey: input.resolution.resolvedRoute.sessionKey,
      dispatchSessionKey: input.resolution.dispatchSessionKey,
      mainSessionKey: input.resolution.resolvedRoute.mainSessionKey,
    },
    conversation: {
      kind: input.resolution.chatType,
      id: input.parsed.peer.id,
      label: input.resolution.canonicalTo,
    },
    reply: {
      to: input.resolution.canonicalTo,
      originatingTo: input.resolution.originatingTo,
    },
    sender: {
      id: input.senderIdForContext,
      displayName: input.senderDisplayName,
    },
    message: {
      id: input.parsed.msgId,
      rawBody: input.prepared.rawBody,
      bodyForAgent: input.prepared.rawBody,
      commandBody: input.prepared.rawBody,
      envelopeBody: input.prepared.body,
    },
    media: mediaPath
      ? [
          {
            path: mediaPath,
            contentType: mediaContentType,
            kind: inferBncrStructuredMediaKind(mediaContentType),
            messageId: input.parsed.msgId,
          },
        ]
      : [],
  });
}
