import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBncrInboundTurnContext } from '../../src/messaging/inbound/turn-context.ts';

function createTurnContextApiStub(calls) {
  return {
    runtime: {
      channel: {
        reply: {
          resolveEnvelopeFormatOptions() {
            return { style: 'test' };
          },
          formatAgentEnvelope({ body, previousTimestamp, envelope }) {
            return `ENV:${body}:${String(previousTimestamp)}:${envelope.style}`;
          },
        },
        session: {
          readSessionUpdatedAt() {
            return 42;
          },
        },
        inbound: {
          buildContext(args) {
            calls.push(args);
            return { built: true, args };
          },
          run() {},
        },
      },
    },
  };
}

test('buildBncrInboundTurnContext replays pending group text and image history into dispatched turn', async () => {
  const calls = [];
  const api = createTurnContextApiStub(calls);

  await buildBncrInboundTurnContext({
    api,
    cfg: {},
    channelId: 'bncr',
    parsed: {
      accountId: 'Primary',
      platform: 'tgBot',
      peer: { kind: 'group', id: '-1001' },
      groupId: '-1001',
      userId: '10001',
      userName: 'xmo',
      isGroup: true,
      isAdmin: true,
      shouldRespond: true,
      triggerKind: 'mention',
      botName: 'AiChatXMO_bot',
      isBotMentioned: true,
      msgId: 'msg-history-3',
      msgType: 'text',
      mimeType: 'text/plain',
    },
    msgId: 'msg-history-3',
    mimeType: 'text/plain',
    peer: { kind: 'group', id: '-1001' },
    senderIdForContext: '10001',
    senderDisplayName: 'xmo',
    resolution: {
      accountId: 'Primary',
      chatType: 'group',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      resolvedRoute: {
        sessionKey: 'agent:public:bncr:group:route',
        agentId: 'public',
      },
      canonicalTo: 'Bncr:tgBot:-1001:0',
      rawTo: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'Bncr:tgBot:-1001:10001',
      baseSessionKey: 'agent:public:bncr:group:route',
      dispatchSessionKey: 'agent:public:bncr:group:route',
    },
    prepared: {
      storePath: '/tmp/store.json',
      rawBody: '@bot summarize',
      body: 'ENV:@bot summarize',
      mediaItems: [],
    },
    groupHistories: new Map([
      [
        'tgBot:-1001',
        [
          {
            sender: 'alice',
            body: 'first text',
            timestamp: 1,
            messageId: 'msg-history-1',
          },
          {
            sender: 'bob',
            body: '<media:image>',
            timestamp: 2,
            messageId: 'msg-history-2',
            media: [
              {
                path: '/tmp/history-image.png',
                contentType: 'image/png',
                kind: 'image',
                messageId: 'msg-history-2',
              },
            ],
          },
        ],
      ],
    ]),
    shouldDispatch: true,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].message.bodyForAgent, /ENV:first text/);
  assert.match(calls[0].message.bodyForAgent, /ENV:<media:image>/);
  assert.match(
    calls[0].message.bodyForAgent,
    /\[Current message - respond to this\]\nENV:@bot summarize/,
  );
  assert.deepEqual(calls[0].message.inboundHistory, [
    {
      sender: 'alice',
      body: 'first text',
      timestamp: 1,
      messageId: 'msg-history-1',
    },
    {
      sender: 'bob',
      body: '<media:image>',
      timestamp: 2,
      messageId: 'msg-history-2',
      media: [
        {
          path: '/tmp/history-image.png',
          contentType: 'image/png',
          kind: 'image',
          messageId: 'msg-history-2',
        },
      ],
    },
  ]);
});

test('buildBncrInboundTurnContext replays pending non-image media markers without synthetic attachments', async () => {
  const calls = [];
  const api = createTurnContextApiStub(calls);

  await buildBncrInboundTurnContext({
    api,
    cfg: {},
    channelId: 'bncr',
    parsed: {
      accountId: 'Primary',
      platform: 'tgBot',
      peer: { kind: 'group', id: '-1001' },
      groupId: '-1001',
      userId: '10001',
      userName: 'xmo',
      isGroup: true,
      isAdmin: true,
      shouldRespond: true,
      triggerKind: 'mention',
      botName: 'AiChatXMO_bot',
      isBotMentioned: true,
      msgId: 'msg-history-6',
      msgType: 'text',
      mimeType: 'text/plain',
    },
    msgId: 'msg-history-6',
    mimeType: 'text/plain',
    peer: { kind: 'group', id: '-1001' },
    senderIdForContext: '10001',
    senderDisplayName: 'xmo',
    resolution: {
      accountId: 'Primary',
      chatType: 'group',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      resolvedRoute: {
        sessionKey: 'agent:public:bncr:group:route',
        agentId: 'public',
      },
      canonicalTo: 'Bncr:tgBot:-1001:0',
      rawTo: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'Bncr:tgBot:-1001:10001',
      baseSessionKey: 'agent:public:bncr:group:route',
      dispatchSessionKey: 'agent:public:bncr:group:route',
    },
    prepared: {
      storePath: '/tmp/store.json',
      rawBody: '@bot summarize media',
      body: 'ENV:@bot summarize media',
      mediaItems: [],
    },
    groupHistories: new Map([
      [
        'tgBot:-1001',
        [
          {
            sender: 'alice',
            body: '<media:video>',
            timestamp: 3,
            messageId: 'msg-history-4',
          },
          {
            sender: 'bob',
            body: '<media:audio>',
            timestamp: 4,
            messageId: 'msg-history-5',
          },
        ],
      ],
    ]),
    shouldDispatch: true,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].message.bodyForAgent, /ENV:<media:video>/);
  assert.match(calls[0].message.bodyForAgent, /ENV:<media:audio>/);
  assert.deepEqual(calls[0].message.inboundHistory, [
    {
      sender: 'alice',
      body: '<media:video>',
      timestamp: 3,
      messageId: 'msg-history-4',
    },
    {
      sender: 'bob',
      body: '<media:audio>',
      timestamp: 4,
      messageId: 'msg-history-5',
    },
  ]);
});

test('buildBncrInboundTurnContext passes canonical route fields and visible untrusted context', async () => {
  const calls = [];
  const api = createTurnContextApiStub(calls);

  const result = await buildBncrInboundTurnContext({
    api,
    cfg: {},
    channelId: 'bncr',
    parsed: {
      accountId: 'Primary',
      platform: 'tgBot',
      peer: { kind: 'group', id: 'group-1' },
      clientId: 'client-1',
      bridgeId: 'bncr-client-1',
      bridgeName: 'Bncr',
      groupId: '-1001',
      groupName: 'wind_system',
      userId: '10001',
      userName: 'xmo',
      isGroup: true,
      isAdmin: false,
      shouldRespond: true,
      triggerKind: 'mention',
      botName: 'AixmoClaw_bot',
      isBotMentioned: true,
      msgId: 'msg-1',
      mimeType: 'image/png',
    },
    msgId: 'msg-1',
    mimeType: 'image/png',
    mediaPath: '/tmp/inbound.png',
    peer: { kind: 'group', id: 'group-1' },
    senderIdForContext: '10001',
    senderDisplayName: 'xmo',
    ownerAllowFrom: ['10001'],
    bridgeSenderId: 'bncr-client-1',
    bridgeSenderName: 'Bncr',
    resolution: {
      accountId: 'Primary',
      chatType: 'group',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      resolvedRoute: {
        sessionKey: 'agent:orion:bncr:group:route',
        agentId: 'orion',
        mainSessionKey: 'agent:orion:bncr:group:main',
      },
      canonicalTo: 'Bncr:tgBot:-1001:0',
      rawTo: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'Bncr:tgBot:-1001:10001?raw',
      baseSessionKey: 'agent:orion:bncr:group:route',
      dispatchSessionKey: 'agent:orion:bncr:group:route#task',
    },
    prepared: {
      storePath: '/tmp/store.json',
      rawBody: 'hello',
      body: 'ENV:hello',
      mediaItems: [
        {
          path: '/tmp/inbound.png',
          contentType: 'image/png',
          kind: 'image',
        },
      ],
    },
  });

  assert.equal(result.built, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].route, {
    agentId: 'orion',
    accountId: 'Primary',
    routeSessionKey: 'agent:orion:bncr:group:route',
    dispatchSessionKey: 'agent:orion:bncr:group:route#task',
    mainSessionKey: 'agent:orion:bncr:group:main',
  });
  assert.deepEqual(calls[0].supplemental.untrustedContext, [
    {
      label: 'Bncr inbound context',
      source: 'bncr',
      type: 'bncr.inbound_context',
      payload: {
        trigger: {
          botName: 'AixmoClaw_bot',
        },
        sender: {
          isOwner: true,
          isAuthorizedSender: true,
          role: 'owner',
        },
        reply: {
          to: 'Bncr:tgBot:-1001:0',
          originatingTo: 'Bncr:tgBot:-1001:10001?raw',
        },
        media: [{ contentType: 'image/png', kind: 'image', messageId: 'msg-1' }],
      },
    },
  ]);
  assert.equal(calls[0].extra.BncrStructuredContextFacts.route.agentId, 'orion');
  assert.equal(calls[0].sender.id, '10001');
  assert.equal(calls[0].sender.username, 'xmo');
  assert.deepEqual(calls[0].access, {
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
  });
  assert.equal(calls[0].extra.BncrStructuredContextFacts.sender.bridgeId, 'bncr-client-1');
  assert.equal(calls[0].extra.BncrStructuredContextFacts.trigger.triggerKind, 'mention');
  assert.equal(result.CommandAuthorized, true);
  assert.equal(result.CommandSource, 'text');
  assert.equal(result.CommandTurn?.kind, 'text-slash');
});

test('buildBncrInboundTurnContext treats platform shouldRespond as effective mention for groups', () => {
  const calls = [];
  const api = createTurnContextApiStub(calls);

  buildBncrInboundTurnContext({
    api,
    cfg: {},
    channelId: 'bncr',
    parsed: {
      accountId: 'Primary',
      platform: 'tgBot',
      peer: { kind: 'group', id: 'group-1' },
      groupId: '-1001',
      userId: '10001',
      userName: 'xmo',
      isGroup: true,
      isAdmin: false,
      shouldRespond: true,
      triggerKind: 'always',
      botName: 'AixmoClaw_bot',
      isBotMentioned: false,
      msgId: 'msg-2',
      mimeType: 'text/plain',
    },
    msgId: 'msg-2',
    mimeType: 'text/plain',
    mediaPath: undefined,
    peer: { kind: 'group', id: 'group-1' },
    senderIdForContext: '10001',
    senderDisplayName: 'xmo',
    bridgeSenderId: 'bncr-client-1',
    bridgeSenderName: 'Bncr',
    resolution: {
      accountId: 'Primary',
      chatType: 'group',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      resolvedRoute: {
        sessionKey: 'agent:public:bncr:group:route',
        agentId: 'public',
      },
      canonicalTo: 'Bncr:tgBot:-1001:0',
      rawTo: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'Bncr:tgBot:-1001:10001',
      baseSessionKey: 'agent:public:bncr:group:route',
      dispatchSessionKey: 'agent:public:bncr:group:route',
    },
    prepared: {
      storePath: '/tmp/store.json',
      rawBody: 'hello all',
      body: 'ENV:hello all',
      mediaItems: [],
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].access, {
    mentions: {
      canDetectMention: true,
      wasMentioned: true,
      effectiveWasMentioned: true,
    },
  });
});
