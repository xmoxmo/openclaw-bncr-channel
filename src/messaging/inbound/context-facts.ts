import path from 'node:path';

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
    userId?: string;
    userName?: string;
    bridgeId?: string;
    bridgeName?: string;
    isAdmin?: boolean;
    isOwner?: boolean;
    isAuthorizedSender?: boolean;
    role?: 'owner' | 'admin' | 'user';
  };
  platform?: string;
  group?: {
    id?: string;
    name?: string;
    isGroup?: boolean;
  };
  trigger?: {
    shouldRespond?: boolean;
    triggerKind?: string;
    botName?: string;
    isBotMentioned?: boolean;
    isReplyToBot?: boolean;
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
  pendingMediaContext?: Array<{
    messageId?: string;
    sender?: string;
    senderId?: string;
    body?: string;
    media?: Array<{
      path?: string;
      contentType?: string;
      kind?: string;
      messageId?: string;
    }>;
  }>;
};

function toBncrPromptMediaPath(id: string): string | undefined {
  if (
    !id ||
    id === '.' ||
    id === '..' ||
    id.includes('/') ||
    id.includes('\\') ||
    id.includes('\0')
  ) {
    return undefined;
  }
  return `media://inbound/${encodeURIComponent(id)}`;
}

function resolveBncrPromptMediaPath(mediaPath: string | undefined): string | undefined {
  const normalized = String(mediaPath || '').trim();
  if (!normalized) return undefined;

  const canonicalMatch = /^media:\/\/inbound\/([^/\\]+)$/i.exec(normalized);
  if (canonicalMatch?.[1]) {
    try {
      return toBncrPromptMediaPath(decodeURIComponent(canonicalMatch[1]));
    } catch {
      return undefined;
    }
  }

  const slashNormalized = normalized.replace(/\\/g, '/');
  if (!slashNormalized.includes('/media/inbound/')) {
    return undefined;
  }
  return toBncrPromptMediaPath(path.posix.basename(slashNormalized));
}

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
      userId: input.sender.userId,
      userName: input.sender.userName,
      bridgeId: input.sender.bridgeId,
      bridgeName: input.sender.bridgeName,
      isAdmin: input.sender.isAdmin,
      ...(input.sender.isOwner === true ? { isOwner: true } : {}),
      ...(input.sender.isAuthorizedSender === true ? { isAuthorizedSender: true } : {}),
      ...(input.sender.role !== undefined ? { role: input.sender.role } : {}),
    },
    platform: input.platform,
    group: {
      id: input.group?.id,
      name: input.group?.name,
      isGroup: input.group?.isGroup,
    },
    trigger: {
      shouldRespond: input.trigger?.shouldRespond,
      triggerKind: input.trigger?.triggerKind,
      botName: input.trigger?.botName,
      isBotMentioned: input.trigger?.isBotMentioned,
      isReplyToBot: input.trigger?.isReplyToBot,
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
    pendingMediaContext: (input.pendingMediaContext || []).map((entry) => ({
      messageId: entry.messageId,
      sender: entry.sender,
      senderId: entry.senderId,
      body: entry.body,
      media: (entry.media || []).map((item) => ({
        path: item.path,
        contentType: item.contentType,
        kind: item.kind,
        messageId: item.messageId,
      })),
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
    trigger?: {
      botName?: string;
    };
    sender?: {
      isAdmin?: boolean;
      isOwner?: boolean;
      isAuthorizedSender?: boolean;
      role?: 'owner' | 'admin' | 'user';
    };
    reply?: {
      to: string;
      originatingTo: string;
    };
    media?: Array<{
      path?: string;
      contentType?: string;
      kind?: string;
      messageId?: string;
    }>;
    pendingMediaContext?: Array<{
      messageId?: string;
      sender?: string;
      senderId?: string;
      body?: string;
      media?: Array<{
        path?: string;
        contentType?: string;
        kind?: string;
        messageId?: string;
      }>;
    }>;
  } = {};

  if (
    facts.sender.isAdmin === true ||
    facts.sender.isOwner === true ||
    facts.sender.isAuthorizedSender === true ||
    facts.sender.role === 'owner' ||
    facts.sender.role === 'admin'
  ) {
    const sender = {
      ...(facts.sender.isAdmin === true ? { isAdmin: true } : {}),
      ...(facts.sender.isOwner === true ? { isOwner: true } : {}),
      ...(facts.sender.isAuthorizedSender === true ? { isAuthorizedSender: true } : {}),
      ...(facts.sender.role === 'owner' || facts.sender.role === 'admin'
        ? { role: facts.sender.role }
        : {}),
    };
    if (Object.keys(sender).length > 0) result.sender = sender;
  }

  if (facts.trigger.botName) {
    result.trigger = {
      botName: facts.trigger.botName,
    };
  }

  if (facts.reply.originatingTo !== facts.reply.to) {
    result.reply = {
      to: facts.reply.to,
      originatingTo: facts.reply.originatingTo,
    };
  }

  if (facts.media.length > 0) {
    result.media = facts.media.flatMap((item) => {
      const promptMediaPath = resolveBncrPromptMediaPath(item.path);
      const payload = {
        ...(promptMediaPath ? { path: promptMediaPath } : {}),
        contentType: item.contentType,
        kind: item.kind,
        messageId: item.messageId,
      };
      return Object.values(payload).some((field) => field !== undefined) ? [payload] : [];
    });
  }

  if (facts.pendingMediaContext?.length) {
    result.pendingMediaContext = facts.pendingMediaContext.flatMap((entry) => {
      const media = (entry.media || []).flatMap((item) => {
        const promptMediaPath = resolveBncrPromptMediaPath(item.path);
        const payload = {
          ...(promptMediaPath ? { path: promptMediaPath } : {}),
          contentType: item.contentType,
          kind: item.kind,
          messageId: item.messageId,
        };
        return Object.values(payload).some((field) => field !== undefined) ? [payload] : [];
      });
      const payload = {
        messageId: entry.messageId,
        sender: entry.sender,
        senderId: entry.senderId,
        body: entry.body,
        ...(media.length > 0 ? { media } : {}),
      };
      return Object.values(payload).some((field) => field !== undefined) ? [payload] : [];
    });
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
    platform?: string;
    peer: {
      kind: string;
      id: string;
    };
    clientId?: string;
    bridgeId?: string;
    bridgeName?: string;
    groupId?: string;
    groupName?: string;
    userId?: string;
    userName?: string;
    isGroup?: boolean;
    isAdmin?: boolean;
    shouldRespond?: boolean;
    triggerKind?: string;
    botName?: string;
    isBotMentioned?: boolean;
    isReplyToBot?: boolean;
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
    mediaItems?: Array<{
      path: string;
      contentType?: string;
      kind?: string;
    }>;
  };
  senderIdForContext: string;
  senderDisplayName?: string;
  bridgeSenderId?: string;
  bridgeSenderName?: string;
  senderIsOwner?: boolean;
  senderIsAuthorized?: boolean;
  pendingMediaContext?: Array<{
    messageId?: string;
    sender?: string;
    senderId?: string;
    body?: string;
    media?: Array<{
      path?: string;
      contentType?: string;
      kind?: string;
      messageId?: string;
    }>;
  }>;
};

export function buildBncrStructuredContextFactsFromInboundParts(
  input: BncrStructuredContextFactsFromInboundPartsInput,
) {
  const mediaItems = Array.isArray(input.prepared.mediaItems) ? input.prepared.mediaItems : [];
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
      userId: input.parsed.userId,
      userName: input.parsed.userName,
      bridgeId: input.bridgeSenderId || input.parsed.bridgeId || input.parsed.clientId,
      bridgeName: input.bridgeSenderName || input.parsed.bridgeName,
      isAdmin: input.parsed.isAdmin,
      isOwner: input.senderIsOwner === true ? true : undefined,
      isAuthorizedSender: input.senderIsAuthorized === true ? true : undefined,
      role: input.senderIsOwner ? 'owner' : input.parsed.isAdmin ? 'admin' : undefined,
    },
    platform: input.parsed.platform,
    group: {
      id: input.parsed.groupId,
      name: input.parsed.groupName,
      isGroup: input.parsed.isGroup,
    },
    trigger: {
      shouldRespond: input.parsed.shouldRespond,
      triggerKind: input.parsed.triggerKind,
      botName: input.parsed.botName,
      isBotMentioned: input.parsed.isBotMentioned,
      isReplyToBot: input.parsed.isReplyToBot,
    },
    message: {
      id: input.parsed.msgId,
      rawBody: input.prepared.rawBody,
      bodyForAgent: input.prepared.rawBody,
      commandBody: input.prepared.rawBody,
      envelopeBody: input.prepared.body,
    },
    media: mediaItems.map((item) => ({
      path: item.path,
      contentType: item.contentType,
      kind: item.kind || inferBncrStructuredMediaKind(item.contentType),
      messageId: input.parsed.msgId,
    })),
    pendingMediaContext: input.pendingMediaContext,
  });
}
