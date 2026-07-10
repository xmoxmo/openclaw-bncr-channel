import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBncrPromptVisibleContextFacts,
  buildBncrStructuredContextFacts,
  buildBncrStructuredContextFactsFromInboundParts,
} from '../../src/messaging/inbound/context-facts.ts';

test('buildBncrStructuredContextFacts preserves structured message, route, reply, and media facts', () => {
  const facts = buildBncrStructuredContextFacts({
    channelId: 'bncr',
    accountId: 'Primary',
    route: {
      agentId: 'orion',
      routeSessionKey: 'agent:orion:bncr:direct:demo',
      dispatchSessionKey: 'agent:orion:bncr:direct:demo',
      mainSessionKey: 'agent:orion:bncr:direct:demo',
    },
    conversation: {
      kind: 'direct',
      id: '-1001',
      label: 'Bncr:tgBot:-1001:10001',
    },
    reply: {
      to: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'BncrRaw:tgBot:-1001:10001',
    },
    sender: {
      id: 'client-1',
      displayName: 'bncr-client',
      userId: '10001',
      userName: 'xmo',
      bridgeId: 'bncr-client-1',
      bridgeName: 'Bncr',
      isAdmin: false,
    },
    platform: 'tgBot',
    group: {
      id: '-1001',
      name: 'wind_system',
      isGroup: true,
    },
    trigger: {
      shouldRespond: true,
      triggerKind: 'mention',
      botName: 'AixmoClaw_bot',
      isBotMentioned: true,
      isReplyToBot: false,
    },
    message: {
      id: 'msg-1',
      rawBody: 'hello inbound',
      bodyForAgent: 'hello inbound',
      commandBody: 'hello inbound',
      envelopeBody: 'ENV:hello inbound',
    },
    media: [
      {
        path: '/home/test/.openclaw/media/inbound/bncr-inbound-media.bin',
        contentType: 'image/png',
        kind: 'image',
        messageId: 'msg-1',
      },
    ],
  });

  assert.deepEqual(facts, {
    channel: {
      id: 'bncr',
      accountId: 'Primary',
    },
    route: {
      agentId: 'orion',
      routeSessionKey: 'agent:orion:bncr:direct:demo',
      dispatchSessionKey: 'agent:orion:bncr:direct:demo',
      mainSessionKey: 'agent:orion:bncr:direct:demo',
    },
    conversation: {
      kind: 'direct',
      id: '-1001',
      label: 'Bncr:tgBot:-1001:10001',
    },
    reply: {
      to: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'BncrRaw:tgBot:-1001:10001',
    },
    sender: {
      id: 'client-1',
      displayName: 'bncr-client',
      userId: '10001',
      userName: 'xmo',
      bridgeId: 'bncr-client-1',
      bridgeName: 'Bncr',
      isAdmin: false,
    },
    platform: 'tgBot',
    group: {
      id: '-1001',
      name: 'wind_system',
      isGroup: true,
    },
    trigger: {
      shouldRespond: true,
      triggerKind: 'mention',
      botName: 'AixmoClaw_bot',
      isBotMentioned: true,
      isReplyToBot: false,
    },
    message: {
      id: 'msg-1',
      rawBody: 'hello inbound',
      bodyForAgent: 'hello inbound',
      commandBody: 'hello inbound',
      envelopeBody: 'ENV:hello inbound',
    },
    media: [
      {
        path: '/home/test/.openclaw/media/inbound/bncr-inbound-media.bin',
        contentType: 'image/png',
        kind: 'image',
        messageId: 'msg-1',
      },
    ],
    pendingMediaContext: [],
  });
});

test('buildBncrPromptVisibleContextFacts only preserves facts not covered by official metadata', () => {
  const facts = buildBncrStructuredContextFacts({
    channelId: 'bncr',
    accountId: 'Primary',
    route: {
      agentId: 'orion',
      routeSessionKey: 'agent:orion:bncr:direct:demo',
      dispatchSessionKey: 'agent:orion:bncr:direct:demo',
      mainSessionKey: 'agent:orion:bncr:direct:demo',
    },
    conversation: {
      kind: 'direct',
      id: '-1001',
      label: 'Bncr:tgBot:-1001:10001',
    },
    reply: {
      to: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'BncrRaw:tgBot:-1001:10001',
    },
    sender: {
      id: 'client-1',
      displayName: 'bncr-client',
    },
    platform: 'tgBot',
    trigger: {
      botName: 'BncrBot',
    },
    message: {
      id: 'msg-1',
      rawBody: 'hello inbound',
      bodyForAgent: 'hello inbound',
      commandBody: 'hello inbound',
      envelopeBody: 'ENV:hello inbound',
    },
    media: [
      {
        path: '/home/test/.openclaw/media/inbound/bncr-inbound-media.bin',
        contentType: 'image/png',
        kind: 'image',
        messageId: 'msg-1',
      },
    ],
  });

  assert.deepEqual(buildBncrPromptVisibleContextFacts(facts), {
    platform: 'bncr/tgBot',
    trigger: {
      botName: 'BncrBot',
    },
    reply: {
      to: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'BncrRaw:tgBot:-1001:10001',
    },
    media: [
      {
        path: 'media://inbound/bncr-inbound-media.bin',
        contentType: 'image/png',
        kind: 'image',
        messageId: 'msg-1',
      },
    ],
  });
});

test('buildBncrPromptVisibleContextFacts exposes botName when the adapter provides an alias', () => {
  const facts = buildBncrStructuredContextFacts({
    channelId: 'bncr',
    accountId: 'Primary',
    route: {},
    conversation: {
      kind: 'group',
      id: '-1001',
      label: 'Bncr:tgBot:-1001:0',
    },
    reply: {
      to: 'Bncr:tgBot:-1001:0',
      originatingTo: 'Bncr:tgBot:-1001:10001',
    },
    sender: {
      id: '10001',
      displayName: 'xmo',
    },
    platform: 'tgBot',
    trigger: {
      botName: 'AiChatXMO_bot',
    },
    message: {
      id: 'msg-1',
      rawBody: 'hello inbound',
    },
  });

  assert.deepEqual(buildBncrPromptVisibleContextFacts(facts), {
    platform: 'bncr/tgBot',
    trigger: {
      botName: 'AiChatXMO_bot',
    },
    reply: {
      to: 'Bncr:tgBot:-1001:0',
      originatingTo: 'Bncr:tgBot:-1001:10001',
    },
  });
});

test('buildBncrPromptVisibleContextFacts preserves reply-only facts when originating target differs', () => {
  const facts = buildBncrStructuredContextFacts({
    channelId: 'bncr',
    accountId: 'Primary',
    route: {},
    conversation: {
      kind: 'direct',
      id: '-1001',
      label: 'Bncr:tgBot:-1001:10001',
    },
    reply: {
      to: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'BncrRaw:tgBot:-1001:10001',
    },
    sender: {
      id: 'client-1',
      displayName: 'bncr-client',
    },
    message: {
      id: 'msg-1',
      rawBody: 'hello inbound',
    },
  });

  assert.deepEqual(buildBncrPromptVisibleContextFacts(facts), {
    reply: {
      to: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'BncrRaw:tgBot:-1001:10001',
    },
  });
});

test('buildBncrPromptVisibleContextFacts preserves media-only facts without leaking local path', () => {
  const facts = buildBncrStructuredContextFacts({
    channelId: 'bncr',
    accountId: 'Primary',
    route: {},
    conversation: {
      kind: 'direct',
      id: '-1001',
      label: 'Bncr:tgBot:-1001:10001',
    },
    reply: {
      to: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'Bncr:tgBot:-1001:10001',
    },
    sender: {
      id: 'client-1',
      displayName: 'bncr-client',
    },
    message: {
      id: 'msg-1',
      rawBody: 'image inbound',
    },
    media: [
      {
        path: '/home/test/.openclaw/media/inbound/bncr-inbound-media.bin',
        contentType: 'image/png',
        kind: 'image',
        messageId: 'msg-1',
      },
    ],
  });

  assert.deepEqual(buildBncrPromptVisibleContextFacts(facts), {
    media: [
      {
        path: 'media://inbound/bncr-inbound-media.bin',
        contentType: 'image/png',
        kind: 'image',
        messageId: 'msg-1',
      },
    ],
  });
});

test('buildBncrPromptVisibleContextFacts drops prompt-visible path for non-inbound local media', () => {
  const facts = buildBncrStructuredContextFacts({
    channelId: 'bncr',
    accountId: 'Primary',
    route: {},
    conversation: {
      kind: 'direct',
      id: '-1001',
      label: 'Bncr:tgBot:-1001:10001',
    },
    reply: {
      to: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'Bncr:tgBot:-1001:10001',
    },
    sender: {
      id: 'client-1',
      displayName: 'bncr-client',
    },
    message: {
      id: 'msg-1',
      rawBody: 'document inbound',
    },
    media: [
      {
        path: '/tmp/random-outside.bin',
        contentType: 'application/octet-stream',
        kind: 'document',
        messageId: 'msg-1',
      },
    ],
  });

  assert.deepEqual(buildBncrPromptVisibleContextFacts(facts), {
    media: [
      {
        contentType: 'application/octet-stream',
        kind: 'document',
        messageId: 'msg-1',
      },
    ],
  });
});

test('buildBncrPromptVisibleContextFacts preserves pending media context with sender, body, and multi-attachment refs', () => {
  const facts = buildBncrStructuredContextFacts({
    channelId: 'bncr',
    accountId: 'Primary',
    route: {},
    conversation: {
      kind: 'group',
      id: '-1001',
      label: 'Bncr:tgBot:-1001:0',
    },
    reply: {
      to: 'Bncr:tgBot:-1001:0',
      originatingTo: 'Bncr:tgBot:-1001:10001',
    },
    sender: {
      id: '10001',
      displayName: 'xmo',
    },
    message: {
      id: 'msg-1',
      rawBody: '@bot 看看上面的图',
    },
    pendingMediaContext: [
      {
        messageId: 'pending-1',
        sender: 'osxmo',
        senderId: '6278285192',
        body: '这个',
        media: [
          {
            path: '/home/test/.openclaw/media/inbound/a.jpg',
            contentType: 'image/jpeg',
            kind: 'image',
            messageId: 'pending-1',
          },
          {
            path: '/home/test/.openclaw/media/inbound/b.png',
            contentType: 'image/png',
            kind: 'image',
            messageId: 'pending-1',
          },
        ],
      },
    ],
  });

  assert.deepEqual(buildBncrPromptVisibleContextFacts(facts), {
    reply: {
      to: 'Bncr:tgBot:-1001:0',
      originatingTo: 'Bncr:tgBot:-1001:10001',
    },
    pendingMediaContext: [
      {
        messageId: 'pending-1',
        sender: 'osxmo',
        senderId: '6278285192',
        body: '这个',
        media: [
          {
            path: 'media://inbound/a.jpg',
            contentType: 'image/jpeg',
            kind: 'image',
            messageId: 'pending-1',
          },
          {
            path: 'media://inbound/b.png',
            contentType: 'image/png',
            kind: 'image',
            messageId: 'pending-1',
          },
        ],
      },
    ],
  });
});

test('buildBncrPromptVisibleContextFacts returns empty object when official metadata already covers the inbound', () => {
  const facts = buildBncrStructuredContextFacts({
    channelId: 'bncr',
    accountId: 'Primary',
    route: {},
    conversation: {
      kind: 'direct',
      id: '-1001',
      label: 'Bncr:tgBot:-1001:10001',
    },
    reply: {
      to: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'Bncr:tgBot:-1001:10001',
    },
    sender: {
      id: 'client-1',
      displayName: 'bncr-client',
    },
    message: {
      id: 'msg-1',
      rawBody: 'hello inbound',
    },
  });

  assert.deepEqual(buildBncrPromptVisibleContextFacts(facts), {});
});

test('buildBncrStructuredContextFacts defaults agent and command body to raw body without inventing an envelope', () => {
  const facts = buildBncrStructuredContextFacts({
    channelId: 'bncr',
    accountId: 'Primary',
    route: {},
    conversation: {
      kind: 'direct',
      id: '-1001',
      label: 'Bncr:tgBot:-1001:10001',
    },
    reply: {
      to: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'Bncr:tgBot:-1001:10001',
    },
    sender: {
      id: 'Bncr:tgBot:-1001:10001',
    },
    message: {
      rawBody: '/commands',
    },
  });

  assert.equal(facts.sender.displayName, 'Bncr:tgBot:-1001:10001');
  assert.equal(facts.message.rawBody, '/commands');
  assert.equal(facts.message.bodyForAgent, '/commands');
  assert.equal(facts.message.commandBody, '/commands');
  assert.equal(facts.message.envelopeBody, undefined);
  assert.deepEqual(facts.media, []);
});

test('buildBncrStructuredContextFactsFromInboundParts adapts dispatch-shaped inbound parts', () => {
  const facts = buildBncrStructuredContextFactsFromInboundParts({
    channelId: 'bncr',
    parsed: {
      accountId: 'Primary',
      peer: {
        kind: 'direct',
        id: '-1001',
      },
      clientId: 'client-1',
      shouldRespond: true,
      triggerKind: 'reply',
      isBotMentioned: false,
      isReplyToBot: true,
      msgId: 'msg-2',
      mimeType: 'audio/ogg',
    },
    resolution: {
      chatType: 'direct',
      canonicalTo: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'BncrRaw:tgBot:-1001:10001',
      resolvedRoute: {
        agentId: 'orion',
        sessionKey: 'agent:orion:bncr:direct:demo',
        mainSessionKey: 'agent:orion:bncr:direct:demo',
      },
      dispatchSessionKey: 'agent:orion:bncr:direct:demo',
    },
    prepared: {
      rawBody: 'voice inbound',
      body: 'ENV:voice inbound',
      mediaItems: [
        {
          path: '/tmp/voice.ogg',
          contentType: 'audio/ogg',
          kind: 'audio',
        },
      ],
    },
    senderIdForContext: 'client-1',
    senderDisplayName: 'bncr-client',
  });

  assert.equal(facts.channel.id, 'bncr');
  assert.equal(facts.channel.accountId, 'Primary');
  assert.equal(facts.route.agentId, 'orion');
  assert.equal(facts.route.routeSessionKey, 'agent:orion:bncr:direct:demo');
  assert.equal(facts.route.dispatchSessionKey, 'agent:orion:bncr:direct:demo');
  assert.equal(facts.conversation.kind, 'direct');
  assert.equal(facts.conversation.id, '-1001');
  assert.equal(facts.conversation.label, 'Bncr:tgBot:-1001:10001');
  assert.equal(facts.reply.to, 'Bncr:tgBot:-1001:10001');
  assert.equal(facts.reply.originatingTo, 'BncrRaw:tgBot:-1001:10001');
  assert.equal(facts.sender.id, 'client-1');
  assert.equal(facts.sender.displayName, 'bncr-client');
  assert.equal(facts.message.id, 'msg-2');
  assert.equal(facts.message.rawBody, 'voice inbound');
  assert.equal(facts.message.bodyForAgent, 'voice inbound');
  assert.equal(facts.message.commandBody, 'voice inbound');
  assert.equal(facts.message.envelopeBody, 'ENV:voice inbound');
  assert.equal(facts.trigger.shouldRespond, true);
  assert.equal(facts.trigger.triggerKind, 'reply');
  assert.equal(facts.trigger.isBotMentioned, false);
  assert.equal(facts.trigger.isReplyToBot, true);
  assert.deepEqual(facts.media, [
    {
      path: '/tmp/voice.ogg',
      contentType: 'audio/ogg',
      kind: 'audio',
      messageId: 'msg-2',
    },
  ]);
});

test('buildBncrStructuredContextFactsFromInboundParts exposes bncr owner authorization facts', () => {
  const facts = buildBncrStructuredContextFactsFromInboundParts({
    channelId: 'bncr',
    parsed: {
      accountId: 'Primary',
      peer: {
        kind: 'group',
        id: '-1001',
      },
      userId: '10001',
      userName: 'xmo',
      isAdmin: true,
    },
    resolution: {
      chatType: 'group',
      canonicalTo: 'Bncr:tgBot:-1001:0',
      originatingTo: 'Bncr:tgBot:-1001:0',
      resolvedRoute: {},
    },
    prepared: {
      rawBody: 'hello',
    },
    senderIdForContext: '10001',
    senderDisplayName: 'xmo',
    senderIsOwner: true,
    senderIsAuthorized: true,
  });

  assert.equal(facts.sender.isAdmin, true);
  assert.equal(facts.sender.isOwner, true);
  assert.equal(facts.sender.isAuthorizedSender, true);
  assert.equal(facts.sender.role, 'owner');
  assert.deepEqual(buildBncrPromptVisibleContextFacts(facts), {
    sender: {
      isAdmin: true,
      isOwner: true,
      isAuthorizedSender: true,
      role: 'owner',
    },
  });
});

test('buildBncrStructuredContextFactsFromInboundParts keeps media empty and falls back sender display name', () => {
  const facts = buildBncrStructuredContextFactsFromInboundParts({
    channelId: 'bncr',
    parsed: {
      accountId: 'Primary',
      peer: {
        kind: 'direct',
        id: '10001',
      },
    },
    resolution: {
      chatType: 'direct',
      canonicalTo: 'Bncr:tgBot:0:10001',
      originatingTo: 'Bncr:tgBot:0:10001',
      resolvedRoute: {},
    },
    prepared: {
      rawBody: 'hello',
    },
    senderIdForContext: 'Bncr:tgBot:0:10001',
  });

  assert.equal(facts.sender.id, 'Bncr:tgBot:0:10001');
  assert.equal(facts.sender.displayName, 'Bncr:tgBot:0:10001');
  assert.equal(facts.message.rawBody, 'hello');
  assert.equal(facts.message.bodyForAgent, 'hello');
  assert.equal(facts.message.commandBody, 'hello');
  assert.equal(facts.message.envelopeBody, undefined);
  assert.deepEqual(facts.media, []);
});
