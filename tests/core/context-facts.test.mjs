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
        path: '/tmp/bncr-inbound-media.bin',
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
        path: '/tmp/bncr-inbound-media.bin',
        contentType: 'image/png',
        kind: 'image',
        messageId: 'msg-1',
      },
    ],
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
    message: {
      id: 'msg-1',
      rawBody: 'hello inbound',
      bodyForAgent: 'hello inbound',
      commandBody: 'hello inbound',
      envelopeBody: 'ENV:hello inbound',
    },
    media: [
      {
        path: '/tmp/bncr-inbound-media.bin',
        contentType: 'image/png',
        kind: 'image',
        messageId: 'msg-1',
      },
    ],
  });

  assert.deepEqual(buildBncrPromptVisibleContextFacts(facts), {
    reply: {
      to: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'BncrRaw:tgBot:-1001:10001',
    },
    media: [
      {
        contentType: 'image/png',
        kind: 'image',
        messageId: 'msg-1',
      },
    ],
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
        path: '/tmp/bncr-inbound-media.bin',
        contentType: 'image/png',
        kind: 'image',
        messageId: 'msg-1',
      },
    ],
  });

  assert.deepEqual(buildBncrPromptVisibleContextFacts(facts), {
    media: [
      {
        contentType: 'image/png',
        kind: 'image',
        messageId: 'msg-1',
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
      mediaPath: '/tmp/voice.ogg',
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
  assert.deepEqual(facts.media, [
    {
      path: '/tmp/voice.ogg',
      contentType: 'audio/ogg',
      kind: 'audio',
      messageId: 'msg-2',
    },
  ]);
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
