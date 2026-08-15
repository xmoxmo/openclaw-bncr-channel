import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCommandAuthorization } from 'openclaw/plugin-sdk/command-auth-native';
import {
  clearConversationHistorySerialLocks,
  readConversationHistorySerialStates,
  resetConversationHistorySerialForTest,
  runConversationHistorySerial,
} from '../../src/messaging/inbound/conversation-history-serial.ts';
import {
  dispatchBncrInbound,
  dispatchBncrOutboundHistoryFlush,
  resolveBncrInboundConversation,
} from '../../src/messaging/inbound/dispatch.ts';
import { prepareBncrInboundSessionContext } from '../../src/messaging/inbound/dispatch-prep.ts';
import { recordBncrOutboundReplay } from '../../src/messaging/inbound/outbound-replay-cache.ts';
import { parseBncrInboundParams, resolveChatType } from '../../src/messaging/inbound/parse.ts';
import { resetBncrReplyDispatchSerialForTest } from '../../src/messaging/inbound/reply-dispatch-serial.ts';
import {
  createInboundApiStub,
  withInboundSessionRuntimeStub,
} from '../helpers/inbound-runtime.mjs';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeOutboundReplayEntry(messageId, route, overrides = {}) {
  const message = {
    type: overrides.type ?? 'text',
    msg: overrides.msg ?? 'bot reply',
    ...(overrides.mediaUrl ? { mediaUrl: overrides.mediaUrl } : {}),
  };
  return {
    messageId,
    accountId: 'Primary',
    sessionKey: `agent:public:bncr:${route.groupId === '0' ? 'direct' : 'group'}:demo`,
    route,
    payload: {
      type: 'message.outbound',
      messageId,
      message,
    },
    createdAt: 1,
    retryCount: 0,
    nextAttemptAt: 1,
    ...(overrides.lastPushAt ? { lastPushAt: overrides.lastPushAt } : {}),
  };
}

test('resolveChatType distinguishes direct and explicit group inbound scenes', () => {
  assert.equal(
    resolveChatType({ platform: 'tgBot', groupId: '0', userId: '10001' }, false),
    'direct',
  );
  assert.equal(
    resolveChatType({ platform: 'tgBot', groupId: '-1001', userId: '10001' }, true),
    'group',
  );

  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    isGroup: true,
    type: 'text',
    msg: 'group-looking inbound still direct',
    msgId: 'inbound-group-looking-direct',
  });

  assert.equal(parsed.peer.kind, 'group');
  assert.equal(parsed.peer.id, '-1001');
});

test('resolveBncrInboundConversation returns canonical target and dispatch session from one source', async () => {
  const { api } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    isGroup: true,
    type: 'text',
    msg: 'hello inbound',
    mimeType: 'text/plain',
    msgId: 'inbound-0',
  });

  const resolution = resolveBncrInboundConversation({
    api,
    cfg: {},
    channelId: 'bncr',
    parsed,
    canonicalAgentId: 'orion',
  });

  assert.equal(resolution.accountId, 'Primary');
  assert.equal(resolution.chatType, 'group');
  assert.equal(resolution.rawTo, 'Bncr:tgBot:-1001:10001');
  assert.equal(resolution.canonicalTo, 'Bncr:tgBot:-1001:0');
  assert.equal(resolution.originatingTo, resolution.canonicalTo);
  assert.equal(resolution.baseSessionKey, 'agent:orion:bncr:group:7467426f743a2d31303031');
  assert.equal(resolution.dispatchSessionKey, 'agent:orion:bncr:group:7467426f743a2d31303031');
});

test('dispatchBncrInbound carries parsed mimeType and peer kind into built inbound context', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    type: 'text',
    msg: 'hello inbound',
    mimeType: 'text/plain',
    msgId: 'inbound-1',
  });
  const enqueueCalls = [];

  const result = await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(result.accountId, 'Primary');
  assert.equal(calls.builtContexts.length, 1);
  assert.equal(calls.builtContextArgs.length, 1);
  assert.equal(calls.recorded.length, 1);
  assert.equal(calls.builtContexts[0].MediaType, undefined);
  assert.equal(calls.builtContexts[0].ChatType, 'group');
  assert.equal(calls.builtContexts[0].SenderId, '10001');
  assert.equal(calls.builtContexts[0].OwnerAllowFrom, undefined);
  assert.equal(calls.builtContexts[0].MessageSid, 'inbound-1');
  assert.equal(calls.builtContexts[0].Body, 'ENV:hello inbound');
  assert.equal(calls.builtContexts[0].BodyForAgent, 'ENV:hello inbound');
  assert.equal(calls.builtContexts[0].RawBody, 'hello inbound');
  assert.equal(calls.builtContexts[0].CommandBody, 'hello inbound');
  assert.equal(calls.builtContexts[0].BodyForCommands, 'hello inbound');
  assert.deepEqual(calls.builtContextArgs[0].sender, {
    id: '10001',
    name: 'xmo',
    username: 'xmo',
  });
  assert.deepEqual(calls.builtContextArgs[0].conversation, {
    kind: 'group',
    id: '-1001',
    label: 'Bncr:tgBot:-1001:0',
    routePeer: {
      kind: 'group',
      id: '-1001',
    },
  });
  assert.deepEqual(calls.builtContextArgs[0].route, {
    agentId: 'orion',
    accountId: 'Primary',
    routeSessionKey: 'agent:orion:bncr:group:7467426f743a2d31303031',
    dispatchSessionKey: 'agent:orion:bncr:group:7467426f743a2d31303031',
    mainSessionKey: undefined,
  });
  assert.deepEqual(calls.builtContextArgs[0].reply, {
    to: 'Bncr:tgBot:-1001:0',
    originatingTo: 'Bncr:tgBot:-1001:0',
    rawTo: 'Bncr:tgBot:-1001:10001',
  });
  assert.deepEqual(calls.builtContextArgs[0].message, {
    inboundEventKind: 'user_request',
    body: 'ENV:hello inbound',
    rawBody: 'hello inbound',
    bodyForAgent: 'ENV:hello inbound',
    inboundHistory: undefined,
    commandBody: 'hello inbound',
    envelopeFrom: 'Bncr:tgBot:-1001:0',
    senderLabel: 'xmo',
  });
  assert.equal(calls.builtContextArgs[0].supplemental.untrustedContext.length, 1);
  assert.deepEqual(
    calls.builtContexts[0].UntrustedStructuredContext,
    calls.builtContextArgs[0].supplemental.untrustedContext,
  );
  assert.deepEqual(
    calls.builtContexts[0].BncrStructuredContextFacts,
    calls.builtContexts[0].StructuredContextFacts,
  );
  assert.deepEqual(calls.builtContexts[0].StructuredContextFacts, {
    channel: {
      id: 'bncr',
      accountId: 'Primary',
    },
    route: {
      agentId: 'orion',
      routeSessionKey: 'agent:orion:bncr:group:7467426f743a2d31303031',
      dispatchSessionKey: 'agent:orion:bncr:group:7467426f743a2d31303031',
      mainSessionKey: undefined,
    },
    conversation: {
      kind: 'group',
      id: '-1001',
      label: 'Bncr:tgBot:-1001:0',
    },
    reply: {
      to: 'Bncr:tgBot:-1001:0',
      originatingTo: 'Bncr:tgBot:-1001:0',
      rawTo: 'Bncr:tgBot:-1001:10001',
    },
    sender: {
      id: '10001',
      displayName: 'xmo',
      userId: '10001',
      userName: 'xmo',
      bridgeId: 'client-1',
      bridgeName: 'Bncr',
      isAdmin: false,
    },
    platform: 'tgBot',
    group: {
      id: '-1001',
      name: '',
      isGroup: true,
    },
    trigger: {
      shouldRespond: false,
      triggerKind: 'none',
      botName: '',
      isBotMentioned: false,
      isReplyToBot: false,
    },
    message: {
      id: 'inbound-1',
      rawBody: 'hello inbound',
      bodyForAgent: 'hello inbound',
      commandBody: 'hello inbound',
      envelopeBody: 'ENV:hello inbound',
    },
    media: [],
    conversationContext: [
      {
        messageId: 'inbound-1',
        timestamp: calls.builtContexts[0].StructuredContextFacts.conversationContext[0].timestamp,
        role: 'user',
        sender: 'xmo',
        senderId: '10001',
        content: 'hello inbound',
        media: [],
      },
    ],
    participants: {
      10001: {
        name: 'xmo',
        username: 'xmo',
        isBot: false,
        role: 'user',
        displayName: 'xmo',
      },
    },
    isGroupChat: true,
    groupSubject: '',
    accountId: 'Primary',
  });
  assert.equal(calls.builtContexts[0].To, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.builtContexts[0].OriginatingTo, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.builtContexts[0].EnvelopeFrom, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.builtContexts[0].ConversationLabel, 'Bncr:tgBot:-1001:0');
  assert.equal(
    calls.recorded[0].ctx.DispatchSessionKey,
    'agent:orion:bncr:group:7467426f743a2d31303031',
  );
  assert.equal(calls.recorded[0].ctx.ConversationLabel, 'Bncr:tgBot:-1001:0');
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].accountId, 'Primary');
  assert.equal(enqueueCalls[0].sessionKey, 'agent:orion:bncr:group:7467426f743a2d31303031');
  assert.deepEqual(enqueueCalls[0].route, {
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
  });
  assert.equal(enqueueCalls[0].payload.text, 'reply from agent');
  assert.equal(enqueueCalls[0].payload.kind, 'final');
  assert.equal(calls.builtContexts[0].ChatType, 'group');
});

test('dispatchBncrInbound routes non-admin direct sessions to public when resolvedAgentId is public', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    isAdmin: false,
    type: 'text',
    msg: 'hello direct inbound',
    mimeType: 'text/plain',
    msgId: 'direct-1',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    resolvedAgentId: 'public',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.deepEqual(calls.builtContextArgs[0].route, {
    agentId: 'public',
    accountId: 'Primary',
    routeSessionKey: 'agent:public:bncr:direct:7467426f743a3130303031',
    dispatchSessionKey: 'agent:public:bncr:direct:7467426f743a3130303031',
    mainSessionKey: undefined,
  });
  assert.deepEqual(calls.builtContextArgs[0].conversation, {
    kind: 'direct',
    id: '10001',
    label: 'Bncr:tgBot:0:10001',
    routePeer: {
      kind: 'direct',
      id: '10001',
    },
  });
  assert.equal(calls.builtContexts[0].To, 'Bncr:tgBot:0:10001');
  assert.equal(calls.builtContexts[0].ConversationLabel, 'Bncr:tgBot:0:10001');
  assert.equal(
    calls.builtContexts[0].DispatchSessionKey,
    'agent:public:bncr:direct:7467426f743a3130303031',
  );
  assert.equal(enqueueCalls[0].sessionKey, 'agent:public:bncr:direct:7467426f743a3130303031');
});

test('dispatchBncrInbound replays acknowledged outbound messages into direct context', async () => {
  const { api, calls } = createInboundApiStub();
  const outboundReplayCache = new Map();
  const conversationHistories = new Map();
  const sessionKey = 'agent:public:bncr:direct:7467426f743a3130303031';
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    entry: {
      messageId: 'out-direct-history-1',
      accountId: 'Primary',
      sessionKey,
      route,
      payload: {
        type: 'message.outbound',
        messageId: 'out-direct-history-1',
        message: {
          type: 'text',
          msg: 'my previous outbound message',
          path: '',
          base64: '',
          fileName: '',
        },
      },
      createdAt: 1,
      retryCount: 0,
      nextAttemptAt: 1,
    },
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    type: 'text',
    msg: 'hello after my message',
    mimeType: 'text/plain',
    msgId: 'direct-after-outbound-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    resolvedAgentId: 'public',
    outboundReplayCache,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const ctx = calls.builtContextArgs.at(-1);
  assert.ok(ctx);
  assert.equal(ctx.message.bodyForAgent, 'ENV:hello after my message');
  const historyFacts = ctx.extra?.BncrStructuredContextFacts?.conversationContext;
  const assistant = historyFacts?.find((entry) => entry.messageId === 'out-direct-history-1');
  assert.equal(assistant?.sender, 'OpenClaw');
  assert.equal(assistant?.senderId, 'Primary');
  assert.equal(assistant?.role, 'assistant');
  assert.equal(assistant?.content, 'my previous outbound message');
  const current = historyFacts?.find((entry) => entry.messageId === 'direct-after-outbound-1');
  assert.equal(current?.role, 'user');
  assert.equal(current?.content, 'hello after my message');
  assert.equal(outboundReplayCache.has('Primary:tgBot:10001'), false);
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
});

test('dispatchBncrInbound replays acknowledged outbound messages into group context', async () => {
  const { api, calls } = createInboundApiStub();
  const outboundReplayCache = new Map();
  const conversationHistories = new Map();
  const route = { platform: 'tgBot', groupId: '-1001', userId: '0' };

  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    entry: {
      messageId: 'out-conversation-history-1',
      accountId: 'Primary',
      sessionKey: 'agent:public:bncr:group:7467426f743a2d31303031',
      route,
      payload: {
        type: 'message.outbound',
        messageId: 'out-conversation-history-1',
        message: {
          type: 'text',
          msg: 'my previous group outbound message',
          path: '',
          base64: '',
          fileName: '',
        },
      },
      createdAt: 1,
      retryCount: 0,
      nextAttemptAt: 1,
    },
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: '@bot hello after my message',
    mimeType: 'text/plain',
    msgId: 'group-after-outbound-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    resolvedAgentId: 'public',
    outboundReplayCache,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const ctx = calls.builtContextArgs.at(-1);
  assert.ok(ctx);
  assert.equal(ctx.message.bodyForAgent, 'ENV:@bot hello after my message');
  const historyFacts = ctx.extra?.BncrStructuredContextFacts?.conversationContext;
  const assistant = historyFacts?.find((entry) => entry.messageId === 'out-conversation-history-1');
  assert.equal(assistant?.sender, 'OpenClaw');
  assert.equal(assistant?.role, 'assistant');
  assert.equal(assistant?.content, 'my previous group outbound message');
  assert.equal(outboundReplayCache.has('Primary:tgBot:-1001'), false);
  assert.deepEqual(conversationHistories.get('tgBot:-1001'), []);
});

test('dispatchBncrInbound replays all cached outbound messages and clears cache', async () => {
  const { api, calls } = createInboundApiStub();
  const outboundReplayCache = new Map();
  const conversationHistories = new Map();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };
  for (let index = 0; index < 12; index += 1) {
    recordBncrOutboundReplay({
      cache: outboundReplayCache,
      conversationHistories,
      entry: {
        messageId: `out-full-${index}`,
        accountId: 'Primary',
        sessionKey: `agent:public:bncr:direct:${index}`,
        route,
        payload: {
          type: 'message.outbound',
          messageId: `out-full-${index}`,
          message: {
            type: 'text',
            msg: `outbound message ${index}`,
            path: '',
            base64: '',
            fileName: '',
          },
        },
        createdAt: index + 1,
        retryCount: 0,
        nextAttemptAt: index + 1,
      },
      sender: 'OpenClaw',
      senderId: 'Primary',
    });
  }

  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    type: 'text',
    msg: 'hello after many outbound messages',
    mimeType: 'text/plain',
    msgId: 'direct-after-many-outbound',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    resolvedAgentId: 'public',
    outboundReplayCache,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const ctx = calls.builtContextArgs.at(-1);
  assert.ok(ctx);
  const historyFacts = ctx.extra?.BncrStructuredContextFacts?.conversationContext;
  assert.equal(historyFacts?.length, 13);
  for (let index = 0; index < 12; index += 1) {
    const assistant = historyFacts?.find((entry) => entry.messageId === `out-full-${index}`);
    assert.equal(assistant?.role, 'assistant');
    assert.equal(assistant?.content, `outbound message ${index}`);
  }
  assert.equal(outboundReplayCache.size, 0);
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
});

test('dispatchBncrInbound interleaves private user history and bot replies in conversation_context', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  const firstPending = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    shouldRespond: false,
    type: 'text',
    msg: 'private first',
    mimeType: 'text/plain',
    msgId: 'private-pending-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: firstPending,
    canonicalAgentId: 'orion',
    resolvedAgentId: 'public',
    shouldDispatch: false,
    shouldAccumulate: true,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    entry: {
      messageId: 'private-bot-1',
      accountId: 'Primary',
      sessionKey: 'agent:public:bncr:direct:7467426f743a3130303031',
      route,
      payload: {
        type: 'message.outbound',
        messageId: 'private-bot-1',
        message: {
          type: 'text',
          msg: 'private bot reply',
          path: '',
          base64: '',
          fileName: '',
        },
      },
      createdAt: 1,
      retryCount: 0,
      nextAttemptAt: 1,
    },
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  const trigger = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    shouldRespond: true,
    type: 'text',
    msg: 'private trigger',
    mimeType: 'text/plain',
    msgId: 'private-trigger-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: trigger,
    canonicalAgentId: 'orion',
    resolvedAgentId: 'public',
    conversationHistories,
    outboundReplayCache,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const ctx = calls.builtContextArgs.at(-1);
  assert.ok(ctx);
  assert.equal(ctx.message.bodyForAgent, 'ENV:private trigger');
  const context = ctx.extra?.BncrStructuredContextFacts?.conversationContext;
  assert.deepEqual(
    context?.map((entry) => ({
      messageId: entry.messageId,
      role: entry.role,
      content: entry.content,
    })),
    [
      { messageId: 'private-pending-1', role: 'user', content: 'private first' },
      { messageId: 'private-bot-1', role: 'assistant', content: 'private bot reply' },
      { messageId: 'private-trigger-1', role: 'user', content: 'private trigger' },
    ],
  );
  assert.deepEqual(ctx.extra?.BncrStructuredContextFacts?.participants, null);
  assert.equal(ctx.extra?.BncrStructuredContextFacts?.isGroupChat, false);
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
  assert.equal(outboundReplayCache.has('Primary:tgBot:10001'), false);
});

test('dispatchBncrInbound preserves explicit custom agent for non-admin direct sessions', async () => {
  const { api, calls } = createInboundApiStub({
    onRequest({ method }) {
      if (method === 'channel.resolveAgentRoute') {
        return {
          ok: true,
          sessionKey: 'agent:custom-agent:bncr:direct:7467426f743a3130303031',
          agentId: 'custom-agent',
        };
      }
      return { ok: true };
    },
  });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    isAdmin: false,
    type: 'text',
    msg: 'hello direct inbound',
    mimeType: 'text/plain',
    msgId: 'direct-2',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    resolvedAgentId: 'custom-agent',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.deepEqual(calls.builtContextArgs[0].route, {
    agentId: 'custom-agent',
    accountId: 'Primary',
    routeSessionKey: 'agent:custom-agent:bncr:direct:7467426f743a3130303031',
    dispatchSessionKey: 'agent:custom-agent:bncr:direct:7467426f743a3130303031',
    mainSessionKey: undefined,
  });
  assert.equal(
    calls.builtContexts[0].DispatchSessionKey,
    'agent:custom-agent:bncr:direct:7467426f743a3130303031',
  );
  assert.equal(enqueueCalls[0].sessionKey, 'agent:custom-agent:bncr:direct:7467426f743a3130303031');
});

test('admin OpenClaw native command grants owner allowFrom to real sender id', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-client-long-id',
    bridgeId: 'bncr-client-long-id',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/status',
    mimeType: 'text/plain',
    msgId: 'admin-status-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.builtContexts.length, 1);
  assert.equal(calls.builtContexts[0].From, '10001');
  assert.equal(calls.builtContexts[0].To, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.builtContexts[0].SenderId, '10001');
  assert.equal(calls.builtContexts[0].OriginatingChannel, 'bncr');
  assert.deepEqual(calls.builtContexts[0].OwnerAllowFrom, ['10001']);
  assert.equal(calls.builtContexts[0].CommandAuthorized, true);
  assert.equal(calls.builtContexts[0].CommandSource, 'text');
  assert.deepEqual(calls.builtContexts[0].CommandTurn, {
    kind: 'text-slash',
    source: 'text',
    authorized: true,
    commandName: 'status',
    body: '/status',
  });
  assert.deepEqual(calls.builtContexts[0].AccessCommands, {
    authorized: true,
    allowTextCommands: true,
    useAccessGroups: false,
    authorizers: [],
  });
  assert.deepEqual(calls.builtContextArgs[0].sender, {
    id: '10001',
    name: 'xmo',
    username: 'xmo',
  });
  assert.equal(calls.builtContextArgs[0].extra.OwnerAllowFrom[0], '10001');
});

test('admin bncr builtin command does not inject OpenClaw owner allowFrom', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-client-long-id',
    bridgeId: 'bncr-client-long-id',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr help',
    mimeType: 'text/plain',
    msgId: 'admin-bncr-help-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.builtContexts.length, 1);
  assert.equal(calls.builtContexts[0].SenderId, '10001');
  assert.equal(calls.builtContexts[0].OwnerAllowFrom, undefined);
});

test('OpenClaw command auth still authorizes admin sender when static owner list exists and sender is appended dynamically', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-client-long-id',
    bridgeId: 'bncr-client-long-id',
    platform: 'qqBot',
    groupId: '0',
    userId: '58C799392B49460B9959504A0723A2FD',
    userName: 'admin-user',
    isGroup: false,
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/status',
    mimeType: 'text/plain',
    msgId: 'qq-admin-status-auth',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {
      commands: {
        ownerAllowFrom: [
          'bncr-client-e6bdee6df493e5fa2a19de74e7187bb0dbc8f560c5b20b6a6861355ae1d3cb26',
          '6278285192',
        ],
      },
    },
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.builtContexts.length, 1);
  const mergedOwnerAllowFrom = [
    'bncr-client-e6bdee6df493e5fa2a19de74e7187bb0dbc8f560c5b20b6a6861355ae1d3cb26',
    '6278285192',
    '58C799392B49460B9959504A0723A2FD',
  ];
  const auth = resolveCommandAuthorization({
    ctx: {
      ...calls.builtContexts[0],
      OwnerAllowFrom: mergedOwnerAllowFrom,
    },
    cfg: {
      commands: {
        ownerAllowFrom: mergedOwnerAllowFrom,
      },
    },
    commandAuthorized: true,
  });

  assert.deepEqual(auth.ownerList, mergedOwnerAllowFrom);
  assert.equal(auth.senderId, '58C799392B49460B9959504A0723A2FD');
  assert.equal(auth.senderIsOwner, true);
  assert.equal(auth.isAuthorizedSender, true);
});

test('dispatchBncrInbound ingests group context without replying when shouldDispatch is false', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    shouldRespond: false,
    type: 'text',
    msg: 'silent ingest',
    mimeType: 'text/plain',
    msgId: 'inbound-no-reply-1',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    shouldDispatch: false,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.builtContexts.length, 1);
  assert.equal(calls.recorded.length, 1);
  assert.equal(enqueueCalls.length, 0);
  assert.equal(calls.delivered.length, 0);
  assert.equal(calls.turnRuns.length, 0);
  assert.equal(calls.replyDispatchStarts.length, 0);
  assert.equal(calls.replyDispatchCompletions.length, 0);
});

test('dispatchBncrInbound drops non-accumulating group turns without writing pending history', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10002',
    userName: 'bob',
    isGroup: true,
    shouldRespond: false,
    type: 'text',
    msg: 'non-admin silent',
    mimeType: 'text/plain',
    msgId: 'inbound-drop-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'public',
    shouldDispatch: false,
    shouldAccumulate: false,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.builtContexts.length, 1);
  assert.equal(calls.recorded.length, 1);
  assert.equal(calls.delivered.length, 0);
  assert.equal(conversationHistories.size, 0);
});

test('admin mode drops non-admin inbound but still accumulates bot replies for outbound history flush', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        agentId: 'public',
        groupReplyMode: 'admin',
        historyLimit: 3,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: parseBncrInboundParams({
      accountId: 'Primary',
      clientId: 'client-1',
      platform: 'tgBot',
      groupId: '-1001',
      userId: '10002',
      userName: 'bob',
      isGroup: true,
      shouldRespond: false,
      type: 'text',
      msg: 'non-admin silent',
      mimeType: 'text/plain',
      msgId: 'admin-mode-non-admin-1',
    }),
    canonicalAgentId: 'public',
    shouldDispatch: false,
    shouldAccumulate: false,
    sceneRegistry,
    conversationHistories,
    outboundReplayCache,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });
  assert.equal(conversationHistories.size, 0);

  const route = { platform: 'tgBot', groupId: '-1001', userId: '0' };
  for (let index = 1; index <= 3; index += 1) {
    recordBncrOutboundReplay({
      cache: outboundReplayCache,
      conversationHistories,
      historyLimit: 3,
      entry: makeOutboundReplayEntry(`admin-mode-bot-${index}`, route, {
        lastPushAt: 1000 + index,
      }),
      sender: 'OpenClaw',
      senderId: 'Primary',
    });
  }

  await dispatchBncrOutboundHistoryFlush({
    api,
    channelId: 'bncr',
    cfg: {},
    entry: makeOutboundReplayEntry('admin-mode-bot-3', route),
    canonicalAgentId: 'public',
    sceneRegistry,
    conversationHistories,
    outboundReplayCache,
    defaultAdminAgentId: 'public',
    defaultPublicAgentId: 'public',
    now: () => Date.now(),
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 1);
  assert.equal(calls.turnRuns[0].ctxPayload.SenderId, 'bncr-history-system');
  assert.deepEqual(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext.map(
      (entry) => entry.messageId,
    ),
    ['admin-mode-bot-1', 'admin-mode-bot-2', 'admin-mode-bot-3'],
  );
  assert.deepEqual(conversationHistories.get('tgBot:-1001'), []);
  assert.equal(outboundReplayCache.has('Primary:tgBot:-1001'), false);
});

test('dispatchBncrInbound replays pending group text and image history on later dispatched turn and clears window', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();

  const pendingText = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'alice',
    isGroup: true,
    shouldRespond: false,
    type: 'text',
    msg: 'silent text',
    mimeType: 'text/plain',
    msgId: 'pending-text-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: pendingText,
    canonicalAgentId: 'public',
    shouldDispatch: false,
    shouldAccumulate: true,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const pendingImage = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10002',
    userName: 'bob',
    isGroup: true,
    shouldRespond: false,
    type: 'image',
    msg: '收到媒体文件',
    base64: Buffer.from('ok').toString('base64'),
    mimeType: 'image/png',
    fileName: 'pending.png',
    msgId: 'pending-image-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: pendingImage,
    canonicalAgentId: 'public',
    shouldDispatch: false,
    shouldAccumulate: true,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const trigger = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: '@bot summarize',
    mimeType: 'text/plain',
    msgId: 'trigger-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: trigger,
    canonicalAgentId: 'public',
    shouldDispatch: true,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const triggeredCtx = calls.builtContextArgs.at(-1);
  assert.ok(triggeredCtx);
  assert.equal(triggeredCtx.message.bodyForAgent, 'ENV:@bot summarize');
  const historyFacts = triggeredCtx.extra?.BncrStructuredContextFacts?.conversationContext;
  assert.equal(
    historyFacts?.find((entry) => entry.messageId === 'pending-text-1')?.content,
    'silent text',
  );
  assert.equal(
    historyFacts?.find((entry) => entry.messageId === 'pending-image-1')?.content,
    '<media:image>',
  );
  assert.equal(
    historyFacts?.find((entry) => entry.messageId === 'trigger-1')?.content,
    '@bot summarize',
  );
  assert.equal(historyFacts?.find((entry) => entry.messageId === 'pending-text-1')?.role, 'user');
  assert.equal(triggeredCtx.message.inboundHistory, undefined);
  assert.equal(
    calls.builtContexts.at(-1)?.UntrustedStructuredContext?.[0]?.type,
    'bncr.inbound_context',
  );
  assert.deepEqual(conversationHistories.get('tgBot:-1001'), []);
});

test('dispatchBncrInbound retains all pending group images from one mediaList turn for later replay', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();

  const pendingAlbum = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10002',
    userName: 'bob',
    isGroup: true,
    shouldRespond: false,
    type: 'image',
    msg: '收到媒体文件',
    mediaList: [
      {
        base64: Buffer.from('img-1').toString('base64'),
        mimeType: 'image/png',
        fileName: 'album-1.png',
        type: 'image',
      },
      {
        base64: Buffer.from('img-2').toString('base64'),
        mimeType: 'image/jpeg',
        fileName: 'album-2.jpg',
        type: 'image',
      },
    ],
    msgId: 'pending-album-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: pendingAlbum,
    canonicalAgentId: 'public',
    shouldDispatch: false,
    shouldAccumulate: true,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const trigger = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: '@bot summarize album',
    mimeType: 'text/plain',
    msgId: 'trigger-album-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: trigger,
    canonicalAgentId: 'public',
    shouldDispatch: true,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const triggeredCtx = calls.builtContextArgs.at(-1);
  assert.ok(triggeredCtx);
  assert.equal(triggeredCtx.message.bodyForAgent, 'ENV:@bot summarize album');
  const historyFacts = triggeredCtx.extra?.BncrStructuredContextFacts?.conversationContext;
  assert.equal(
    historyFacts?.find((entry) => entry.messageId === 'pending-album-1')?.content,
    '<media:image> (2 images)',
  );
  assert.equal(
    historyFacts?.find((entry) => entry.messageId === 'trigger-album-1')?.content,
    '@bot summarize album',
  );
  assert.equal(triggeredCtx.message.inboundHistory, undefined);
  assert.deepEqual(triggeredCtx.media, [
    {
      path: '/home/test/.openclaw/media/inbound/bncr-inbound-media-1.bin',
      contentType: 'image/png',
      kind: 'image',
      messageId: 'pending-album-1',
    },
    {
      path: '/home/test/.openclaw/media/inbound/bncr-inbound-media-2.bin',
      contentType: 'image/jpeg',
      kind: 'image',
      messageId: 'pending-album-1',
    },
  ]);
  assert.equal(
    calls.builtContexts.at(-1)?.UntrustedStructuredContext?.[0]?.type,
    'bncr.inbound_context',
  );
});

test('dispatchBncrInbound merges pending group media into a later text trigger turn', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();

  const pendingImage = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10002',
    userName: 'bob',
    isGroup: true,
    shouldRespond: false,
    type: 'image',
    msg: '收到媒体文件',
    base64: Buffer.from('img-1').toString('base64'),
    mimeType: 'image/png',
    fileName: 'pending.png',
    msgId: 'pending-image-later-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: pendingImage,
    canonicalAgentId: 'public',
    shouldDispatch: false,
    shouldAccumulate: true,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const trigger = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: '@bot 这张图是什么',
    mimeType: 'text/plain',
    msgId: 'trigger-text-after-image-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: trigger,
    canonicalAgentId: 'public',
    shouldDispatch: true,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const triggeredCtx = calls.builtContextArgs.at(-1);
  assert.ok(triggeredCtx);
  assert.deepEqual(triggeredCtx.media, [
    {
      path: '/home/test/.openclaw/media/inbound/bncr-inbound-media-1.bin',
      contentType: 'image/png',
      kind: 'image',
      messageId: 'pending-image-later-1',
    },
  ]);
  assert.equal(triggeredCtx.message.inboundHistory, undefined);
  assert.equal(triggeredCtx.message.bodyForAgent, 'ENV:@bot 这张图是什么');
  const historyFacts = triggeredCtx.extra?.BncrStructuredContextFacts?.conversationContext;
  assert.equal(
    historyFacts?.find((entry) => entry.messageId === 'pending-image-later-1')?.content,
    '<media:image>',
  );
  assert.equal(
    historyFacts?.find((entry) => entry.messageId === 'trigger-text-after-image-1')?.content,
    '@bot 这张图是什么',
  );
  assert.equal(
    calls.builtContexts.at(-1)?.UntrustedStructuredContext?.[0]?.type,
    'bncr.inbound_context',
  );
});

test('dispatchBncrInbound flushes pending group history silently at the limit and keeps prior flushes readable later', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const enqueueCalls = [];
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        agentId: 'public',
        groupReplyMode: 'mention',
        historyLimit: 3,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);

  for (const [index, text] of ['测试1', '测试2', '测试3', '测试4', '测试5'].entries()) {
    const parsed = parseBncrInboundParams({
      accountId: 'Primary',
      clientId: 'client-1',
      platform: 'tgBot',
      groupId: '-1001',
      userId: '10001',
      userName: 'xmo',
      isGroup: true,
      shouldRespond: false,
      type: 'text',
      msg: text,
      mimeType: 'text/plain',
      msgId: `pending-overflow-${index + 1}`,
    });

    await dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed,
      canonicalAgentId: 'public',
      shouldDispatch: false,
      shouldAccumulate: true,
      sceneRegistry,
      conversationHistories,
      rememberSessionRoute() {},
      enqueueFromReply: async (args) => {
        enqueueCalls.push(args);
      },
      setInboundActivity() {},
      scheduleSave() {},
    });
  }

  assert.equal(calls.turnRuns.length, 1);
  assert.equal(enqueueCalls.length, 0);
  assert.equal(conversationHistories.get('tgBot:-1001')?.length, 2);
  assert.deepEqual(
    conversationHistories.get('tgBot:-1001')?.map((entry) => entry.body),
    ['测试4', '测试5'],
  );
  assert.equal(calls.turnRuns[0].ctxPayload.SenderId, 'bncr-history-system');
  assert.match(String(calls.turnRuns[0].ctxPayload.RawBody || ''), /Output exactly NO_REPLY\./);
  assert.match(calls.turnRuns[0].ctxPayload.BodyForAgent, /Output exactly NO_REPLY\./);
  assert.deepEqual(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext.map(
      (entry) => entry.content,
    ),
    ['测试1', '测试2', '测试3'],
  );

  const trigger = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: '@bot 测试6',
    mimeType: 'text/plain',
    msgId: 'pending-overflow-trigger-6',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: trigger,
    canonicalAgentId: 'public',
    shouldDispatch: true,
    sceneRegistry,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 2);
  assert.equal(enqueueCalls.length, 0);
  assert.equal(calls.turnRuns[1].ctxPayload.SenderId, 'bncr-history-system');
  assert.deepEqual(
    calls.turnRuns[1].ctxPayload.StructuredContextFacts.conversationContext.map(
      (entry) => entry.content,
    ),
    ['测试4', '测试5', '@bot 测试6'],
  );
  assert.equal(
    calls.turnRuns[1].ctxPayload.UntrustedStructuredContext?.some(
      (entry) => entry?.type === 'bncr.history_window',
    ),
    false,
  );
  assert.deepEqual(conversationHistories.get('tgBot:-1001'), []);

  const carry = ['测试6', '测试7', '测试8'];
  for (const [index, text] of carry.entries()) {
    const parsed = parseBncrInboundParams({
      accountId: 'Primary',
      clientId: 'client-1',
      platform: 'tgBot',
      groupId: '-1001',
      userId: '10001',
      userName: 'xmo',
      isGroup: true,
      shouldRespond: false,
      type: 'text',
      msg: text,
      mimeType: 'text/plain',
      msgId: `pending-overflow-2-${index + 6}`,
    });

    await dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed,
      canonicalAgentId: 'public',
      shouldDispatch: false,
      shouldAccumulate: true,
      sceneRegistry,
      conversationHistories,
      rememberSessionRoute() {},
      enqueueFromReply: async (args) => {
        enqueueCalls.push(args);
      },
      setInboundActivity() {},
      scheduleSave() {},
    });
  }

  assert.equal(calls.turnRuns.length, 3);
  assert.equal(enqueueCalls.length, 0);
  assert.deepEqual(conversationHistories.get('tgBot:-1001'), []);
  assert.deepEqual(
    calls.turnRuns[2].ctxPayload.StructuredContextFacts.conversationContext.map(
      (entry) => entry.content,
    ),
    ['测试6', '测试7', '测试8'],
  );

  const finalTrigger = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: '@bot 请复述之前的测试消息',
    mimeType: 'text/plain',
    msgId: 'pending-overflow-trigger-history-readback',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: finalTrigger,
    canonicalAgentId: 'public',
    shouldDispatch: true,
    sceneRegistry,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 4);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(calls.turnRuns[3].ctxPayload.SenderId, '10001');
  assert.deepEqual(
    calls.turnRuns[3].ctxPayload.StructuredContextFacts.conversationContext.map(
      (entry) => entry.content,
    ),
    ['@bot 请复述之前的测试消息'],
  );
  assert.equal(
    calls.turnRuns[3].ctxPayload.UntrustedStructuredContext?.find(
      (entry) => entry?.type === 'bncr.history_window',
    ),
    undefined,
  );
});

test('dispatchBncrInbound honors scene history limit from the first accumulated group message', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:-1002',
      {
        sceneKey: 'tgBot:-1002',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1002',
        agentId: 'public',
        groupReplyMode: 'mention',
        historyLimit: 3,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);

  for (const [index, text] of ['首1', '首2', '首3'].entries()) {
    await dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed: parseBncrInboundParams({
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1002',
        userId: '10001',
        userName: 'xmo',
        isGroup: true,
        shouldRespond: false,
        type: 'text',
        msg: text,
        mimeType: 'text/plain',
        msgId: `first-limit-${index + 1}`,
      }),
      canonicalAgentId: 'public',
      shouldDispatch: false,
      shouldAccumulate: true,
      sceneRegistry,
      conversationHistories,
      rememberSessionRoute() {},
      enqueueFromReply: async () => {},
      setInboundActivity() {},
      scheduleSave() {},
    });
  }

  assert.equal(calls.turnRuns.length, 1);
  assert.equal(calls.turnRuns[0].ctxPayload.SenderId, 'bncr-history-system');
  assert.deepEqual(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext.map(
      (entry) => entry.content,
    ),
    ['首1', '首2', '首3'],
  );
  assert.deepEqual(conversationHistories.get('tgBot:-1002'), []);
});

test('dispatchBncrInbound flushes pending direct history at the direct scene history limit', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        agentId: 'public',
        historyLimit: 3,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);

  for (const [index, text] of ['私聊1', '私聊2', '私聊3', '私聊4', '私聊5'].entries()) {
    await dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed: parseBncrInboundParams({
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '0',
        userId: '10001',
        userName: 'xmo',
        isGroup: false,
        shouldRespond: false,
        type: 'text',
        msg: text,
        mimeType: 'text/plain',
        msgId: `direct-overflow-${index + 1}`,
      }),
      canonicalAgentId: 'public',
      shouldDispatch: false,
      shouldAccumulate: true,
      sceneRegistry,
      conversationHistories,
      rememberSessionRoute() {},
      enqueueFromReply: async () => {},
      setInboundActivity() {},
      scheduleSave() {},
    });
  }

  assert.equal(calls.turnRuns.length, 1);
  assert.equal(calls.turnRuns[0].ctxPayload.SenderId, 'bncr-history-system');
  assert.deepEqual(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext.map(
      (entry) => entry.content,
    ),
    ['私聊1', '私聊2', '私聊3'],
  );
  assert.deepEqual(
    conversationHistories.get('tgBot:10001')?.map((entry) => entry.body),
    ['私聊4', '私聊5'],
  );
});

test('dispatchBncrInbound force-flushes a dispatched direct message when accumulated history reaches the limit', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        agentId: 'public',
        historyLimit: 3,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: parseBncrInboundParams({
      accountId: 'Primary',
      clientId: 'client-1',
      platform: 'tgBot',
      groupId: '0',
      userId: '10001',
      userName: 'xmo',
      isGroup: false,
      shouldRespond: false,
      type: 'text',
      msg: 'direct-1',
      mimeType: 'text/plain',
      msgId: 'direct-dispatched-limit-1',
    }),
    canonicalAgentId: 'public',
    shouldDispatch: false,
    shouldAccumulate: true,
    sceneRegistry,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  recordBncrOutboundReplay({
    cache: new Map(),
    conversationHistories,
    historyLimit: 3,
    entry: makeOutboundReplayEntry('direct-dispatched-limit-bot-1', {
      platform: 'tgBot',
      groupId: '0',
      userId: '10001',
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: parseBncrInboundParams({
      accountId: 'Primary',
      clientId: 'client-1',
      platform: 'tgBot',
      groupId: '0',
      userId: '10001',
      userName: 'xmo',
      isGroup: false,
      shouldRespond: false,
      type: 'text',
      msg: 'direct-2',
      mimeType: 'text/plain',
      msgId: 'direct-dispatched-limit-2',
    }),
    canonicalAgentId: 'public',
    shouldDispatch: true,
    sceneRegistry,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 1);
  assert.equal(enqueueCalls.length, 0);
  assert.equal(calls.turnRuns[0].ctxPayload.SenderId, 'bncr-history-system');
  assert.deepEqual(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext.map(
      (entry) => entry.messageId,
    ),
    ['direct-dispatched-limit-1', 'direct-dispatched-limit-bot-1', 'direct-dispatched-limit-2'],
  );
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
});

test('raw outbound replay recording does not dispatch history flush by itself', async () => {
  const { calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };
  let lastResult;

  for (let index = 1; index <= 3; index += 1) {
    lastResult = recordBncrOutboundReplay({
      cache: outboundReplayCache,
      conversationHistories,
      historyLimit: 3,
      entry: makeOutboundReplayEntry(`bot-only-${index}`, route, {
        lastPushAt: 1000 + index,
      }),
      sender: 'OpenClaw',
      senderId: 'Primary',
    });
  }

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(conversationHistories.get('tgBot:10001')?.length, 3);
  assert.equal(outboundReplayCache.get('Primary:tgBot:10001')?.length, 3);
  assert.equal(lastResult.historyOverflow, true);
});

test('dispatch marks the history shard failed when upload throws', async () => {
  resetConversationHistorySerialForTest();
  const { api } = createInboundApiStub({
    onReplyDispatchStart() {
      throw new Error('upload failed');
    },
  });
  const conversationHistories = new Map();
  const failedMarks = [];
  const historyShardQueue = {
    createHistoryShard: () => ({ shardId: 99, created: true }),
    markHistoryShardProcessing: () => {},
    markHistoryShardFailed: (shardId, error) => failedMarks.push({ shardId, error }),
    markHistoryShardCompleted: () => {},
    completeHistoryShard: () => {},
  };
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    type: 'text',
    msg: 'trigger upload failure',
    mimeType: 'text/plain',
    msgId: 'upload-failure-1',
  });

  await assert.rejects(
    dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed,
      canonicalAgentId: 'orion',
      conversationHistories,
      historyShardQueue,
      rememberSessionRoute() {},
      enqueueFromReply: async () => {},
      setInboundActivity() {},
      scheduleSave() {},
    }),
    /upload failed/,
  );

  assert.equal(failedMarks.length, 1);
  assert.equal(failedMarks[0].shardId, 99);
  assert.match(String(failedMarks[0].error), /upload failed/);
  resetConversationHistorySerialForTest();
});

test('dispatch reconciles consumed memory before building the snapshot payload', async () => {
  resetConversationHistorySerialForTest();
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map([
    [
      'tgBot:10001',
      [
        {
          sender: 'alice',
          senderId: '10001',
          role: 'user',
          body: 'already consumed',
          timestamp: 100,
          messageId: 'consumed-1',
        },
        {
          sender: 'alice',
          senderId: '10001',
          role: 'user',
          body: 'still active',
          timestamp: 200,
          messageId: 'active-1',
        },
      ],
    ],
  ]);
  const reconcileCalls = [];
  const historyShardQueue = {
    createHistoryShard: () => ({ shardId: 90, created: true }),
    reconcileHistoryMemory: async (historyKey) => {
      reconcileCalls.push(historyKey);
      const entries = conversationHistories.get(historyKey) || [];
      conversationHistories.set(
        historyKey,
        entries.filter((entry) => entry.messageId !== 'consumed-1'),
      );
    },
    markHistoryShardProcessing: () => {},
    markHistoryShardFailed: () => {},
    markHistoryShardCompleted: () => {},
    renewHistoryShardLease: () => true,
    completeHistoryShard: () => {},
  };
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    type: 'text',
    msg: 'current message',
    mimeType: 'text/plain',
    msgId: 'current-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'public',
    shouldDispatch: true,
    shouldAccumulate: true,
    conversationHistories,
    historyShardQueue,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.deepEqual(reconcileCalls, ['tgBot:10001']);
  assert.equal(calls.turnRuns.length, 1);
  const messageIds = calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext.map(
    (entry) => entry.messageId,
  );
  assert.equal(messageIds.includes('consumed-1'), false);
  assert.equal(messageIds.includes('active-1'), true);
  assert.equal(messageIds.includes('current-1'), true);
  resetConversationHistorySerialForTest();
});

test('dispatch does not fall back to direct upload when shard activation fails', async () => {
  resetConversationHistorySerialForTest();
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const historyShardQueue = {
    createHistoryShard: () => ({ shardId: 98, created: true }),
    markHistoryShardProcessing: () => {
      throw new Error('activate failed');
    },
    markHistoryShardFailed: () => {},
    markHistoryShardCompleted: () => {},
    renewHistoryShardLease: () => true,
    completeHistoryShard: () => {},
  };
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    type: 'text',
    msg: 'activation failure',
    mimeType: 'text/plain',
    msgId: 'activation-failure-1',
  });

  await assert.rejects(
    dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed,
      canonicalAgentId: 'public',
      shouldDispatch: true,
      shouldAccumulate: true,
      conversationHistories,
      historyShardQueue,
      rememberSessionRoute() {},
      enqueueFromReply: async () => {},
      setInboundActivity() {},
      scheduleSave() {},
    }),
    /activate failed/,
  );

  assert.equal(calls.turnRuns.length, 0);
  // The shard owns the snapshot in SQLite, so the local window is disconnected
  // even if marking the shard as processing fails before direct upload.
  assert.equal(conversationHistories.get('tgBot:10001')?.length, 0);
  resetConversationHistorySerialForTest();
});

test('dispatch aborts direct upload when shard activation ownership is lost', async () => {
  resetConversationHistorySerialForTest();
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const historyShardQueue = {
    createHistoryShard: () => ({ shardId: 96, created: true }),
    markHistoryShardProcessing: () => false,
    markHistoryShardFailed: () => {},
    markHistoryShardCompleted: () => {},
    renewHistoryShardLease: () => false,
    completeHistoryShard: () => {},
  };
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    type: 'text',
    msg: 'activation ownership lost',
    mimeType: 'text/plain',
    msgId: 'activation-ownership-lost-1',
  });

  await assert.rejects(
    dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed,
      canonicalAgentId: 'public',
      shouldDispatch: true,
      shouldAccumulate: true,
      conversationHistories,
      historyShardQueue,
      rememberSessionRoute() {},
      enqueueFromReply: async () => {},
      setInboundActivity() {},
      scheduleSave() {},
    }),
    /history shard activation lost/,
  );

  assert.equal(calls.turnRuns.length, 0);
  // SQLite owns the snapshot and the real worker will retain the claim, so the
  // local window is intentionally disconnected before the direct attempt stops.
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
  resetConversationHistorySerialForTest();
});

test('dispatch reuses an existing shard delivery id and activates its claim', async () => {
  resetConversationHistorySerialForTest();
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const queueCalls = [];
  const historyShardQueue = {
    createHistoryShard: () => {
      queueCalls.push('create');
      return { shardId: 55, created: false };
    },
    markHistoryShardProcessing: () => queueCalls.push('processing'),
    markHistoryShardFailed: () => queueCalls.push('failed'),
    markHistoryShardCompleted: () => queueCalls.push('completed'),
    renewHistoryShardLease: () => queueCalls.push('renew'),
    completeHistoryShard: () => queueCalls.push('complete'),
  };
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    type: 'text',
    msg: 'existing shard direct dispatch',
    mimeType: 'text/plain',
    msgId: 'existing-shard-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'public',
    shouldDispatch: true,
    shouldAccumulate: true,
    conversationHistories,
    historyShardQueue,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 1);
  assert.equal(calls.ingested[0].id, 'bncr-history-shard:55');
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
  assert.deepEqual(queueCalls, ['create', 'processing', 'completed', 'complete']);
  resetConversationHistorySerialForTest();
});

test('dispatch aborts direct upload when an existing shard claim is owned elsewhere', async () => {
  resetConversationHistorySerialForTest();
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const queueCalls = [];
  const historyShardQueue = {
    createHistoryShard: () => {
      queueCalls.push('create');
      return { shardId: 56, created: false };
    },
    markHistoryShardProcessing: () => {
      queueCalls.push('processing');
      return false;
    },
    markHistoryShardFailed: () => queueCalls.push('failed'),
    markHistoryShardCompleted: () => queueCalls.push('completed'),
    renewHistoryShardLease: () => queueCalls.push('renew'),
    completeHistoryShard: () => queueCalls.push('complete'),
  };
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    type: 'text',
    msg: 'existing shard owned elsewhere',
    mimeType: 'text/plain',
    msgId: 'existing-shard-2',
  });

  await assert.rejects(
    dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed,
      canonicalAgentId: 'public',
      shouldDispatch: true,
      shouldAccumulate: true,
      conversationHistories,
      historyShardQueue,
      rememberSessionRoute() {},
      enqueueFromReply: async () => {},
      setInboundActivity() {},
      scheduleSave() {},
    }),
    /history shard activation lost/,
  );

  assert.equal(calls.turnRuns.length, 0);
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
  assert.deepEqual(queueCalls, ['create', 'processing']);
  resetConversationHistorySerialForTest();
});

test('dispatch clears local history even when shard completion marking fails', async () => {
  resetConversationHistorySerialForTest();
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const completedShardIds = [];
  const historyShardQueue = {
    createHistoryShard: () => ({ shardId: 97, created: true }),
    markHistoryShardProcessing: () => {},
    markHistoryShardFailed: () => {},
    markHistoryShardCompleted: () => {
      throw new Error('mark complete failed');
    },
    renewHistoryShardLease: () => true,
    completeHistoryShard: (shardId) => completedShardIds.push(shardId),
  };
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    type: 'text',
    msg: 'complete mark failure',
    mimeType: 'text/plain',
    msgId: 'complete-mark-failure-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'public',
    shouldDispatch: true,
    shouldAccumulate: true,
    conversationHistories,
    outboundReplayCache,
    historyShardQueue,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 1);
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
  assert.equal(outboundReplayCache.has('Primary:tgBot:10001'), false);
  assert.deepEqual(completedShardIds, [97]);
  resetConversationHistorySerialForTest();
});

test('dispatchBncrOutboundHistoryFlush force-flushes bot-only history when an outbound reaches the limit', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        agentId: 'public',
        historyLimit: 3,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  for (let index = 1; index <= 3; index += 1) {
    recordBncrOutboundReplay({
      cache: outboundReplayCache,
      conversationHistories,
      historyLimit: 3,
      entry: makeOutboundReplayEntry(`outbound-flush-${index}`, route, {
        lastPushAt: 1000 + index,
      }),
      sender: 'OpenClaw',
      senderId: 'Primary',
    });
  }

  await dispatchBncrOutboundHistoryFlush({
    api,
    channelId: 'bncr',
    cfg: {},
    entry: makeOutboundReplayEntry('outbound-flush-3', route),
    canonicalAgentId: 'public',
    sceneRegistry,
    conversationHistories,
    outboundReplayCache,
    defaultAdminAgentId: 'public',
    defaultPublicAgentId: 'public',
    now: () => Date.now(),
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 1);
  assert.equal(calls.turnRuns[0].ctxPayload.SenderId, 'bncr-history-system');
  assert.deepEqual(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext.map(
      (entry) => entry.messageId,
    ),
    ['outbound-flush-1', 'outbound-flush-2', 'outbound-flush-3'],
  );
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
  assert.equal(outboundReplayCache.has('Primary:tgBot:10001'), false);
});

test('dispatchBncrOutboundHistoryFlush does not run an empty system flush', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  await dispatchBncrOutboundHistoryFlush({
    api,
    channelId: 'bncr',
    cfg: {},
    entry: makeOutboundReplayEntry('outbound-empty-flush-1', route),
    canonicalAgentId: 'public',
    sceneRegistry: new Map(),
    conversationHistories,
    outboundReplayCache,
    defaultAdminAgentId: 'public',
    defaultPublicAgentId: 'public',
    now: () => Date.now(),
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(calls.builtContexts.length, 0);
});

test('dispatchBncrOutboundHistoryFlush keeps the triggering bot reply on out-of-order timestamps', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        agentId: 'public',
        historyLimit: 2,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 2,
    entry: makeOutboundReplayEntry('out-of-order-bot-1', route, {
      lastPushAt: 1000,
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });
  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 2,
    entry: makeOutboundReplayEntry('out-of-order-bot-2', route, {
      lastPushAt: 2000,
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });
  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 2,
    entry: makeOutboundReplayEntry('out-of-order-bot-3', route, {
      lastPushAt: 500,
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  await dispatchBncrOutboundHistoryFlush({
    api,
    channelId: 'bncr',
    cfg: {},
    entry: makeOutboundReplayEntry('out-of-order-bot-3', route, {
      lastPushAt: 500,
    }),
    canonicalAgentId: 'public',
    sceneRegistry,
    conversationHistories,
    outboundReplayCache,
    defaultAdminAgentId: 'public',
    defaultPublicAgentId: 'public',
    now: () => Date.now(),
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 1);
  assert.deepEqual(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext.map(
      (entry) => entry.messageId,
    ),
    ['out-of-order-bot-3', 'out-of-order-bot-2'],
  );
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
  assert.equal(outboundReplayCache.has('Primary:tgBot:10001'), false);
});

test('dispatchBncrOutboundHistoryFlush serializes snapshots and skips redundant flushes', async () => {
  resetConversationHistorySerialForTest();
  const gate = createDeferred();
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        agentId: 'public',
        historyLimit: 3,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  for (let index = 1; index <= 3; index += 1) {
    recordBncrOutboundReplay({
      cache: outboundReplayCache,
      conversationHistories,
      historyLimit: 3,
      entry: makeOutboundReplayEntry(`serial-outbound-${index}`, route, {
        lastPushAt: 1000 + index,
      }),
      sender: 'OpenClaw',
      senderId: 'Primary',
    });
  }

  const lock = runConversationHistorySerial('tgBot:10001', () => gate.promise);
  const first = dispatchBncrOutboundHistoryFlush({
    api,
    channelId: 'bncr',
    cfg: {},
    entry: makeOutboundReplayEntry('serial-outbound-3', route),
    canonicalAgentId: 'public',
    sceneRegistry,
    conversationHistories,
    outboundReplayCache,
    defaultAdminAgentId: 'public',
    defaultPublicAgentId: 'public',
    now: () => Date.now(),
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });
  const second = dispatchBncrOutboundHistoryFlush({
    api,
    channelId: 'bncr',
    cfg: {},
    entry: makeOutboundReplayEntry('serial-outbound-3', route),
    canonicalAgentId: 'public',
    sceneRegistry,
    conversationHistories,
    outboundReplayCache,
    defaultAdminAgentId: 'public',
    defaultPublicAgentId: 'public',
    now: () => Date.now(),
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.turnRuns.length, 0);
  gate.resolve();
  await Promise.all([lock, first, second]);

  assert.equal(calls.turnRuns.length, 1);
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
  assert.equal(outboundReplayCache.has('Primary:tgBot:10001'), false);
  resetConversationHistorySerialForTest();
});

test('dispatchBncrOutboundHistoryFlush skips a stale snapshot when history changes while waiting', async () => {
  resetConversationHistorySerialForTest();
  const gate = createDeferred();
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        agentId: 'public',
        historyLimit: 3,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };
  let flushVersion;

  for (let index = 1; index <= 3; index += 1) {
    const replay = recordBncrOutboundReplay({
      cache: outboundReplayCache,
      conversationHistories,
      historyLimit: 3,
      entry: makeOutboundReplayEntry(`stale-flush-bot-${index}`, route, {
        lastPushAt: 1000 + index,
      }),
      sender: 'OpenClaw',
      senderId: 'Primary',
    });
    if (replay.historyOverflow) flushVersion = replay.historyVersion;
  }
  assert.equal(flushVersion, 3);

  const lock = runConversationHistorySerial('tgBot:10001', () => gate.promise);
  const staleFlush = dispatchBncrOutboundHistoryFlush({
    api,
    channelId: 'bncr',
    cfg: {},
    entry: makeOutboundReplayEntry('stale-flush-bot-3', route),
    historyVersion: flushVersion,
    canonicalAgentId: 'public',
    sceneRegistry,
    conversationHistories,
    outboundReplayCache,
    defaultAdminAgentId: 'public',
    defaultPublicAgentId: 'public',
    now: () => Date.now(),
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 3,
    entry: makeOutboundReplayEntry('stale-flush-bot-4', route, {
      lastPushAt: 1004,
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  gate.resolve();
  await Promise.all([lock, staleFlush]);

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(
    conversationHistories
      .get('tgBot:10001')
      ?.some((entry) => entry.messageId === 'stale-flush-bot-4'),
    true,
  );
  assert.equal(outboundReplayCache.get('Primary:tgBot:10001')?.length, 3);
  assert.equal(
    outboundReplayCache
      .get('Primary:tgBot:10001')
      ?.some((entry) => entry.messageId === 'stale-flush-bot-4'),
    true,
  );
  resetConversationHistorySerialForTest();
});

test('stop command bypasses conversation history serial and does not accumulate', async () => {
  resetConversationHistorySerialForTest();
  resetBncrReplyDispatchSerialForTest();
  const gate = createDeferred();
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const lock = runConversationHistorySerial('tgBot:10001', () => gate.promise);

  const stop = dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: parseBncrInboundParams({
      accountId: 'Primary',
      clientId: 'client-1',
      platform: 'tgBot',
      groupId: '0',
      userId: '10001',
      userName: 'xmo',
      isGroup: false,
      type: 'text',
      msg: '/stop',
      mimeType: 'text/plain',
      msgId: 'stop-bypass-serial-1',
    }),
    canonicalAgentId: 'orion',
    conversationHistories,
    outboundReplayCache,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const outcome = await Promise.race([
    stop.then(() => 'bypassed'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 1500)),
  ]);
  assert.equal(outcome, 'bypassed');
  assert.equal(calls.turnRuns.length, 1);
  assert.equal(conversationHistories.has('tgBot:10001'), false);
  assert.equal(outboundReplayCache.size, 0);

  gate.resolve();
  await lock;
  resetBncrReplyDispatchSerialForTest();
  resetConversationHistorySerialForTest();
});

test('dispatch outbound flush queued during an upload is not invalidated by that upload cleanup', async () => {
  resetConversationHistorySerialForTest();
  resetBncrReplyDispatchSerialForTest();
  const started = createDeferred();
  const gate = createDeferred();
  let gatedOnce = false;
  const { api, calls } = createInboundApiStub({
    onReplyDispatchStart: async () => {
      if (!gatedOnce) {
        gatedOnce = true;
        started.resolve();
        await gate.promise;
      }
    },
  });
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        agentId: 'public',
        historyLimit: 2,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 2,
    entry: makeOutboundReplayEntry('upload-flush-bot-1', route, {
      lastPushAt: 1001,
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });
  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 2,
    entry: makeOutboundReplayEntry('upload-flush-bot-2', route, {
      lastPushAt: 1002,
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  const run = dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: parseBncrInboundParams({
      accountId: 'Primary',
      clientId: 'client-1',
      platform: 'tgBot',
      groupId: '0',
      userId: '10001',
      userName: 'xmo',
      isGroup: false,
      type: 'text',
      msg: 'current during upload flush',
      mimeType: 'text/plain',
      msgId: 'upload-flush-current-1',
    }),
    canonicalAgentId: 'public',
    shouldDispatch: true,
    shouldAccumulate: true,
    sceneRegistry,
    conversationHistories,
    outboundReplayCache,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  await started.promise;
  const replay = recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 2,
    entry: makeOutboundReplayEntry('upload-flush-bot-3', route, {
      lastPushAt: 1003,
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });
  assert.equal(replay.historyOverflow, true);
  const flush = dispatchBncrOutboundHistoryFlush({
    api,
    channelId: 'bncr',
    cfg: {},
    entry: makeOutboundReplayEntry('upload-flush-bot-3', route, {
      lastPushAt: 1003,
    }),
    historyVersion: replay.historyVersion,
    canonicalAgentId: 'public',
    sceneRegistry,
    conversationHistories,
    outboundReplayCache,
    defaultAdminAgentId: 'public',
    defaultPublicAgentId: 'public',
    now: () => Date.now(),
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  gate.resolve();
  await Promise.all([run, flush]);

  assert.equal(calls.turnRuns.length, 2);
  assert.ok(calls.turnRuns.some((turn) => turn.ctxPayload.SenderId === 'bncr-history-system'));
  assert.deepEqual(conversationHistories.get('tgBot:10001') || [], []);
  assert.equal(outboundReplayCache.has('Primary:tgBot:10001'), false);
  resetConversationHistorySerialForTest();
  resetBncrReplyDispatchSerialForTest();
});

test('dispatchBncrInbound waits for the conversation history snapshot lock', async () => {
  resetConversationHistorySerialForTest();
  const gate = createDeferred();
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const lock = runConversationHistorySerial('tgBot:10001', () => gate.promise);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    shouldRespond: false,
    type: 'text',
    msg: 'serial inbound',
    mimeType: 'text/plain',
    msgId: 'history-serial-inbound-1',
  });
  const run = dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'public',
    shouldDispatch: true,
    shouldAccumulate: true,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(conversationHistories.size, 0);
  assert.equal(calls.turnRuns.length, 0);
  gate.resolve();
  await Promise.all([lock, run]);

  assert.equal(calls.builtContexts.length, 1);
  assert.deepEqual(
    calls.builtContexts[0].StructuredContextFacts.conversationContext.map(
      (entry) => entry.messageId,
    ),
    ['history-serial-inbound-1'],
  );
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
  resetConversationHistorySerialForTest();
});

test('clearConversationHistorySerialLocks keeps a stale started chain as a barrier', async () => {
  resetConversationHistorySerialForTest();
  const gate = createDeferred();
  const staleLock = runConversationHistorySerial('tgBot:10001', () => gate.promise);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clearConversationHistorySerialLocks(), 1);
  let ran = false;
  const next = runConversationHistorySerial('tgBot:10001', async () => {
    ran = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false);

  gate.resolve();
  await Promise.all([staleLock, next]);
  assert.equal(ran, true);

  resetConversationHistorySerialForTest();
});

test('clearConversationHistorySerialLocks keeps queued serial work behind the old started lock', async () => {
  resetConversationHistorySerialForTest();
  const gate = createDeferred();
  const staleLock = runConversationHistorySerial('tgBot:queued-clear', () => gate.promise);
  let ran = false;
  const queued = runConversationHistorySerial('tgBot:queued-clear', async () => {
    ran = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ran, false);
  assert.equal(clearConversationHistorySerialLocks(), 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false);

  gate.resolve();
  await Promise.all([staleLock, queued]);
  assert.equal(ran, true);
  resetConversationHistorySerialForTest();
});

test('clearConversationHistorySerialLocks keeps queued serial work in front of new tasks', async () => {
  resetConversationHistorySerialForTest();
  const staleGate = createDeferred();
  const queuedGate = createDeferred();
  const staleLock = runConversationHistorySerial('tgBot:queued-front', () => staleGate.promise);
  let queuedRan = false;
  const queued = runConversationHistorySerial('tgBot:queued-front', async () => {
    queuedRan = true;
    await queuedGate.promise;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(queuedRan, false);
  assert.equal(clearConversationHistorySerialLocks(), 2);

  let newRan = false;
  const next = runConversationHistorySerial('tgBot:queued-front', async () => {
    newRan = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(newRan, false);

  staleGate.resolve();
  await staleLock;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queuedRan, true);
  queuedGate.resolve();
  await Promise.all([queued, next]);
  assert.equal(newRan, true);
  resetConversationHistorySerialForTest();
});

test('runConversationHistorySerial continues after a rejected task', async () => {
  resetConversationHistorySerialForTest();
  let ran = false;

  await assert.rejects(
    runConversationHistorySerial('tgBot:rejected-chain', () => Promise.reject(new Error('boom'))),
    /boom/,
  );
  await runConversationHistorySerial('tgBot:rejected-chain', async () => {
    ran = true;
  });

  assert.equal(ran, true);
  resetConversationHistorySerialForTest();
});

test('conversation history serial records upload, cache-delete, and lock-clear phases', async () => {
  resetConversationHistorySerialForTest();
  let observed;
  let uploadCompletedState;
  const gate = createDeferred();
  const run = runConversationHistorySerial('tgBot:phase-state', async (handle) => {
    handle.phase('snapshot');
    handle.setCleanup(() => {});
    handle.phase('upload_start', {
      snapshotMessageIds: ['phase-m1'],
      cacheKey: 'Primary:tgBot:phase-state',
    });
    observed = readConversationHistorySerialStates().find(
      (state) => state.historyKey === 'tgBot:phase-state',
    );
    handle.phase('upload_end');
    uploadCompletedState = readConversationHistorySerialStates().find(
      (state) => state.historyKey === 'tgBot:phase-state',
    );
    handle.phase('cache_delete_start');
    handle.phase('cache_delete_done');
    gate.resolve();
  });

  await gate.promise;
  assert.equal(observed?.phase, 'upload_start');
  assert.deepEqual(observed?.snapshotMessageIds, ['phase-m1']);
  assert.equal(observed?.cacheKey, 'Primary:tgBot:phase-state');
  assert.equal(observed?.uploadCompleted, false);
  assert.equal(observed?.abandoned, false);
  assert.equal(uploadCompletedState?.uploadCompleted, true);
  await run;
  resetConversationHistorySerialForTest();
});

test('clear stale conversation history lock during upload preserves local cache', async () => {
  resetConversationHistorySerialForTest();
  const gate = createDeferred();
  let cleanupCalls = 0;
  const run = runConversationHistorySerial('tgBot:stale-upload', async (handle) => {
    handle.setCleanup(() => {
      cleanupCalls += 1;
    });
    handle.phase('upload_start', {
      snapshotMessageIds: ['stale-upload-m1'],
      cacheKey: 'Primary:tgBot:stale-upload',
    });
    await gate.promise;
    assert.equal(handle.isAbandoned(), true);
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    readConversationHistorySerialStates().find((state) => state.historyKey === 'tgBot:stale-upload')
      ?.phase,
    'upload_start',
  );
  assert.equal(clearConversationHistorySerialLocks(), 1);
  assert.equal(cleanupCalls, 0);
  gate.resolve();
  await run;
  assert.equal(cleanupCalls, 0);
  resetConversationHistorySerialForTest();
});

test('clear stale conversation history lock after upload completes finishes cache cleanup', async () => {
  resetConversationHistorySerialForTest();
  const gate = createDeferred();
  let cleanupCalls = 0;
  const run = runConversationHistorySerial('tgBot:stale-upload-end', async (handle) => {
    handle.setCleanup(() => {
      cleanupCalls += 1;
    });
    handle.phase('upload_start', {
      snapshotMessageIds: ['stale-upload-end-m1'],
      cacheKey: 'Primary:tgBot:stale-upload-end',
    });
    handle.phase('upload_end');
    await gate.promise;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clearConversationHistorySerialLocks(), 1);
  assert.equal(cleanupCalls, 1);
  gate.resolve();
  await run;
  assert.equal(cleanupCalls, 1);
  resetConversationHistorySerialForTest();
});

test('dispatchBncrInbound clears legacy outbound replay on silent overflow to avoid duplicate bot replies', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        agentId: 'public',
        historyLimit: 3,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  const dispatchDirect = async (msgId, text, shouldDispatch) =>
    dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed: parseBncrInboundParams({
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '0',
        userId: '10001',
        userName: 'xmo',
        isGroup: false,
        shouldRespond: false,
        type: 'text',
        msg: text,
        mimeType: 'text/plain',
        msgId,
      }),
      canonicalAgentId: 'public',
      shouldDispatch,
      shouldAccumulate: true,
      sceneRegistry,
      conversationHistories,
      outboundReplayCache,
      rememberSessionRoute() {},
      enqueueFromReply: async () => {},
      setInboundActivity() {},
      scheduleSave() {},
    });

  await dispatchDirect('silent-overflow-user-1', 'first', false);
  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 3,
    entry: makeOutboundReplayEntry('silent-overflow-bot-1', route),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });
  await dispatchDirect('silent-overflow-user-2', 'second', false);

  assert.equal(calls.turnRuns.length, 1);
  assert.equal(calls.turnRuns[0].ctxPayload.SenderId, 'bncr-history-system');
  assert.deepEqual(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext.map(
      (entry) => entry.messageId,
    ),
    ['silent-overflow-user-1', 'silent-overflow-bot-1', 'silent-overflow-user-2'],
  );
  assert.equal(outboundReplayCache.has('Primary:tgBot:10001'), false);
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);

  await dispatchDirect('silent-overflow-user-3', 'third', true);

  const ctx = calls.builtContextArgs.at(-1);
  assert.ok(ctx);
  assert.deepEqual(
    ctx.extra?.BncrStructuredContextFacts?.conversationContext.map((entry) => entry.messageId),
    ['silent-overflow-user-3'],
  );
  assert.equal(outboundReplayCache.has('Primary:tgBot:10001'), false);
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
});

test('dispatchBncrInbound clears group legacy outbound replay on silent overflow to avoid duplicate bot replies', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        agentId: 'public',
        groupReplyMode: 'mention',
        historyLimit: 3,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);
  const route = { platform: 'tgBot', groupId: '-1001', userId: '0' };

  const dispatchGroup = async (msgId, text, shouldDispatch) =>
    dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed: parseBncrInboundParams({
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        userName: 'xmo',
        isGroup: true,
        shouldRespond: false,
        type: 'text',
        msg: text,
        mimeType: 'text/plain',
        msgId,
      }),
      canonicalAgentId: 'public',
      shouldDispatch,
      shouldAccumulate: true,
      sceneRegistry,
      conversationHistories,
      outboundReplayCache,
      rememberSessionRoute() {},
      enqueueFromReply: async () => {},
      setInboundActivity() {},
      scheduleSave() {},
    });

  await dispatchGroup('group-silent-overflow-user-1', 'first', false);
  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 3,
    entry: makeOutboundReplayEntry('group-silent-overflow-bot-1', route),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });
  await dispatchGroup('group-silent-overflow-user-2', 'second', false);

  assert.equal(calls.turnRuns.length, 1);
  assert.equal(calls.turnRuns[0].ctxPayload.SenderId, 'bncr-history-system');
  assert.deepEqual(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext.map(
      (entry) => entry.messageId,
    ),
    ['group-silent-overflow-user-1', 'group-silent-overflow-bot-1', 'group-silent-overflow-user-2'],
  );
  assert.equal(outboundReplayCache.has('Primary:tgBot:-1001'), false);
  assert.deepEqual(conversationHistories.get('tgBot:-1001'), []);

  await dispatchGroup('group-silent-overflow-user-3', 'third', true);

  const ctx = calls.builtContextArgs.at(-1);
  assert.ok(ctx);
  assert.deepEqual(
    ctx.extra?.BncrStructuredContextFacts?.conversationContext.map((entry) => entry.messageId),
    ['group-silent-overflow-user-3'],
  );
  assert.equal(outboundReplayCache.has('Primary:tgBot:-1001'), false);
  assert.deepEqual(conversationHistories.get('tgBot:-1001'), []);
});

test('dispatchBncrInbound truncates merged assistant history to the limit and keeps the current message', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        agentId: 'public',
        historyLimit: 3,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  for (let index = 1; index <= 8; index += 1) {
    recordBncrOutboundReplay({
      cache: outboundReplayCache,
      conversationHistories,
      historyLimit: 3,
      entry: makeOutboundReplayEntry(`merged-bot-${index}`, route, {
        lastPushAt: 1000 + index,
      }),
      sender: 'OpenClaw',
      senderId: 'Primary',
    });
  }

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: parseBncrInboundParams({
      accountId: 'Primary',
      clientId: 'client-1',
      platform: 'tgBot',
      groupId: '0',
      userId: '10001',
      userName: 'xmo',
      isGroup: false,
      shouldRespond: false,
      type: 'text',
      msg: 'current after many replies',
      mimeType: 'text/plain',
      msgId: 'merged-current-1',
    }),
    canonicalAgentId: 'public',
    shouldDispatch: true,
    sceneRegistry,
    conversationHistories,
    outboundReplayCache,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 1);
  assert.equal(calls.turnRuns[0].ctxPayload.SenderId, 'bncr-history-system');
  assert.deepEqual(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext.map(
      (entry) => entry.messageId,
    ),
    ['merged-bot-7', 'merged-bot-8', 'merged-current-1'],
  );
  assert.equal(outboundReplayCache.has('Primary:tgBot:10001'), false);
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
});

test('dispatchBncrInbound keeps the current synthetic message when history overflows without a platform id', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        agentId: 'public',
        historyLimit: 3,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };
  const future = Date.now() + 60_000;

  for (let index = 1; index <= 4; index += 1) {
    recordBncrOutboundReplay({
      cache: outboundReplayCache,
      entry: makeOutboundReplayEntry(`synthetic-current-bot-${index}`, route, {
        lastPushAt: future + index,
      }),
      sender: 'OpenClaw',
      senderId: 'Primary',
    });
  }

  const parsedWithoutPlatformId = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    shouldRespond: false,
    type: 'text',
    msg: 'current without platform id',
    mimeType: 'text/plain',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: parsedWithoutPlatformId,
    canonicalAgentId: 'public',
    shouldDispatch: true,
    shouldAccumulate: true,
    sceneRegistry,
    conversationHistories,
    outboundReplayCache,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 1);
  const currentContextEntry =
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext.find((entry) =>
      entry.content.includes('current without platform id'),
    );
  assert.ok(
    currentContextEntry?.messageId,
    'current message without a platform id must be preserved with a synthetic id',
  );
  assert.equal(calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext.length, 3);
  assert.equal(outboundReplayCache.has('Primary:tgBot:10001'), false);
  assert.deepEqual(conversationHistories.get('tgBot:10001'), []);
});

test('dispatch cache cleanup after upload preserves bot replies written during the turn', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 2,
    entry: makeOutboundReplayEntry('pre-upload-bot-1', route, {
      lastPushAt: 1001,
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });
  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 2,
    entry: makeOutboundReplayEntry('pre-upload-bot-2', route, {
      lastPushAt: 1002,
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: parseBncrInboundParams({
      accountId: 'Primary',
      clientId: 'client-1',
      platform: 'tgBot',
      groupId: '0',
      userId: '10001',
      userName: 'xmo',
      isGroup: false,
      type: 'text',
      msg: 'current after replies',
      mimeType: 'text/plain',
      msgId: 'pre-upload-current-1',
    }),
    canonicalAgentId: 'public',
    shouldDispatch: true,
    sceneRegistry: new Map(),
    conversationHistories,
    outboundReplayCache,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {
      recordBncrOutboundReplay({
        cache: outboundReplayCache,
        conversationHistories,
        historyLimit: 2,
        entry: makeOutboundReplayEntry('new-during-upload', route, {
          lastPushAt: 1003,
        }),
        sender: 'OpenClaw',
        senderId: 'Primary',
      });
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 1);
  assert.deepEqual(
    conversationHistories.get('tgBot:10001')?.map((entry) => entry.messageId),
    ['new-during-upload'],
  );
  assert.deepEqual(
    outboundReplayCache.get('Primary:tgBot:10001')?.map((entry) => entry.messageId),
    ['new-during-upload'],
  );
});

test('dispatch cache cleanup preserves bot replies written while context is being built', async () => {
  resetConversationHistorySerialForTest();
  const gate = createDeferred();
  const buildStarted = createDeferred();
  const { api, calls } = createInboundApiStub();
  const originalBuildContext = api.runtime.channel.inbound.buildContext;
  let gatedOnce = false;
  api.runtime.channel.inbound.buildContext = async (args) => {
    if (!gatedOnce) {
      gatedOnce = true;
      buildStarted.resolve();
      await gate.promise;
    }
    return originalBuildContext(args);
  };
  const conversationHistories = new Map();
  const outboundReplayCache = new Map();
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        agentId: 'public',
        historyLimit: 2,
        historyForce: true,
        lastSeenAt: 1,
      },
    ],
  ]);
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 2,
    entry: makeOutboundReplayEntry('before-context-bot-1', route, {
      lastPushAt: 1001,
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });
  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 2,
    entry: makeOutboundReplayEntry('before-context-bot-2', route, {
      lastPushAt: 1002,
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  const run = dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: parseBncrInboundParams({
      accountId: 'Primary',
      clientId: 'client-1',
      platform: 'tgBot',
      groupId: '0',
      userId: '10001',
      userName: 'xmo',
      isGroup: false,
      type: 'text',
      msg: 'current before context build',
      mimeType: 'text/plain',
      msgId: 'before-context-current-1',
    }),
    canonicalAgentId: 'public',
    shouldDispatch: true,
    sceneRegistry,
    conversationHistories,
    outboundReplayCache,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  await buildStarted.promise;
  recordBncrOutboundReplay({
    cache: outboundReplayCache,
    conversationHistories,
    historyLimit: 2,
    entry: makeOutboundReplayEntry('during-context-bot', route, {
      lastPushAt: 1003,
    }),
    sender: 'OpenClaw',
    senderId: 'Primary',
  });

  gate.resolve();
  await run;

  assert.equal(calls.turnRuns.length, 1);
  assert.deepEqual(
    conversationHistories.get('tgBot:10001')?.map((entry) => entry.messageId),
    ['during-context-bot'],
  );
  assert.deepEqual(
    outboundReplayCache.get('Primary:tgBot:10001')?.map((entry) => entry.messageId),
    ['during-context-bot'],
  );
  resetConversationHistorySerialForTest();
});

test('dispatchBncrInbound records video, audio, and document group history markers for later replay', async () => {
  const { api, calls } = createInboundApiStub();
  const conversationHistories = new Map();

  const pendingVideo = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10002',
    userName: 'alice',
    isGroup: true,
    shouldRespond: false,
    type: 'video',
    msg: '收到媒体文件',
    base64: Buffer.from('video').toString('base64'),
    mimeType: 'video/mp4',
    fileName: 'pending.mp4',
    msgId: 'pending-video-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: pendingVideo,
    canonicalAgentId: 'public',
    shouldDispatch: false,
    shouldAccumulate: true,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const pendingAudio = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10003',
    userName: 'bob',
    isGroup: true,
    shouldRespond: false,
    type: 'voice',
    msg: '收到语音',
    base64: Buffer.from('audio').toString('base64'),
    mimeType: 'audio/ogg',
    fileName: 'pending.ogg',
    msgId: 'pending-audio-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: pendingAudio,
    canonicalAgentId: 'public',
    shouldDispatch: false,
    shouldAccumulate: true,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const pendingFile = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10004',
    userName: 'carol',
    isGroup: true,
    shouldRespond: false,
    type: 'file',
    msg: '收到文件',
    base64: Buffer.from('pdf').toString('base64'),
    mimeType: 'application/pdf',
    fileName: 'pending.pdf',
    msgId: 'pending-file-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: pendingFile,
    canonicalAgentId: 'public',
    shouldDispatch: false,
    shouldAccumulate: true,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const trigger = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: '@bot summarize all media',
    mimeType: 'text/plain',
    msgId: 'trigger-media-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: trigger,
    canonicalAgentId: 'public',
    shouldDispatch: true,
    conversationHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const triggeredCtx = calls.builtContextArgs.at(-1);
  assert.ok(triggeredCtx);
  assert.equal(triggeredCtx.message.bodyForAgent, 'ENV:@bot summarize all media');
  const historyFacts = triggeredCtx.extra?.BncrStructuredContextFacts?.conversationContext;
  assert.equal(
    historyFacts?.find((entry) => entry.messageId === 'pending-video-1')?.content,
    '<media:video>',
  );
  assert.equal(
    historyFacts?.find((entry) => entry.messageId === 'pending-audio-1')?.content,
    '<media:audio>',
  );
  assert.equal(
    historyFacts?.find((entry) => entry.messageId === 'pending-file-1')?.content,
    '<media:document>',
  );
  assert.equal(
    historyFacts?.find((entry) => entry.messageId === 'trigger-media-1')?.content,
    '@bot summarize all media',
  );
  assert.equal(triggeredCtx.message.inboundHistory, undefined);
  assert.deepEqual(triggeredCtx.media, [
    {
      path: '/home/test/.openclaw/media/inbound/bncr-inbound-media-1.bin',
      contentType: 'video/mp4',
      kind: 'video',
      messageId: 'pending-video-1',
    },
    {
      path: '/home/test/.openclaw/media/inbound/bncr-inbound-media-2.bin',
      contentType: 'audio/ogg',
      kind: 'audio',
      messageId: 'pending-audio-1',
    },
    {
      path: '/home/test/.openclaw/media/inbound/bncr-inbound-media-3.bin',
      contentType: 'application/pdf',
      kind: 'document',
      messageId: 'pending-file-1',
    },
  ]);
  assert.equal(
    calls.builtContexts.at(-1)?.UntrustedStructuredContext?.[0]?.type,
    'bncr.inbound_context',
  );
});

test('prepareBncrInboundSessionContext converts generic platform media text into Telegram-style placeholders but preserves real captions', async () => {
  const rememberCalls = [];
  const { restore } = withInboundSessionRuntimeStub({
    resolveStorePath() {
      return '/tmp/bncr-inbound-telegram-style.json';
    },
    readSessionUpdatedAt() {
      return 42;
    },
  });

  try {
    const resolution = resolveBncrInboundConversation({
      api: createInboundApiStub().api,
      cfg: {},
      channelId: 'bncr',
      parsed: parseBncrInboundParams({
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        isGroup: true,
        type: 'image',
        msg: '收到媒体文件',
        mimeType: 'image/png',
        msgId: 'prep-media-1',
      }),
      canonicalAgentId: 'public',
    });

    const genericPrepared = await prepareBncrInboundSessionContext({
      api: createInboundApiStub().api,
      cfg: {},
      parsed: parseBncrInboundParams({
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        isGroup: true,
        type: 'image',
        msg: '收到媒体文件',
        mimeType: 'image/png',
        msgId: 'prep-media-1',
      }),
      resolution,
      rememberSessionRoute(sessionKey, accountId, route) {
        rememberCalls.push({ sessionKey, accountId, route });
      },
    });

    const captionPrepared = await prepareBncrInboundSessionContext({
      api: createInboundApiStub().api,
      cfg: {},
      parsed: parseBncrInboundParams({
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        isGroup: true,
        type: 'image',
        msg: '真实图片说明',
        mimeType: 'image/png',
        msgId: 'prep-media-2',
      }),
      resolution,
      rememberSessionRoute() {},
    });

    assert.equal(genericPrepared.rawBody, '<media:image>');
    assert.match(genericPrepared.body, /ENV:<media:image>/);
    assert.equal(captionPrepared.rawBody, '真实图片说明');
    assert.match(captionPrepared.body, /ENV:真实图片说明/);
    assert.ok(rememberCalls.length > 0);
  } finally {
    restore();
  }
});

test('resolveBncrInboundConversation prefers provided originating target when present', async () => {
  const { api } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    originatingTo: 'BncrRaw:tgBot:-1001:10001',
    type: 'text',
    msg: 'hello inbound',
    mimeType: 'text/plain',
    msgId: 'inbound-2',
  });

  const resolution = resolveBncrInboundConversation({
    api,
    cfg: {},
    channelId: 'bncr',
    parsed,
    canonicalAgentId: 'orion',
  });

  assert.equal(resolution.rawTo, 'Bncr:tgBot:-1001:10001');
  assert.equal(resolution.canonicalTo, 'Bncr:tgBot:-1001:0');
  assert.equal(resolution.originatingTo, 'BncrRaw:tgBot:-1001:10001');
});

test('dispatchBncrInbound carries provided originating target into built inbound context', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    originatingTo: 'BncrRaw:tgBot:-1001:10001',
    type: 'text',
    msg: 'hello inbound',
    mimeType: 'text/plain',
    msgId: 'inbound-3',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.builtContexts[0].To, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.builtContexts[0].OriginatingTo, 'BncrRaw:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].EnvelopeFrom, 'BncrRaw:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].ConversationLabel, 'Bncr:tgBot:-1001:0');
  assert.deepEqual(calls.builtContextArgs[0].supplemental.untrustedContext, [
    {
      label: 'Bncr inbound context',
      source: 'bncr',
      type: 'bncr.inbound_context',
      payload: {
        platform: 'bncr/tgBot',
        conversation_context: [
          {
            messageId: 'inbound-3',
            timestamp:
              calls.builtContexts[0].StructuredContextFacts.conversationContext[0].timestamp,
            role: 'user',
            sender: 'Bncr:tgBot:-1001:0',
            senderId: '10001',
            content: 'hello inbound',
          },
        ],
        participants: {
          10001: {
            name: 'Bncr:tgBot:-1001:0',
            isBot: false,
            role: 'user',
            displayName: 'Bncr:tgBot:-1001:0',
          },
        },
        is_group_chat: true,
        account_id: 'Primary',
        reply: {
          to: 'Bncr:tgBot:-1001:0',
          originatingTo: 'BncrRaw:tgBot:-1001:10001',
          rawTo: 'Bncr:tgBot:-1001:10001',
        },
      },
    },
  ]);
  assert.equal(calls.builtContexts[0].GroupSubject, undefined);
});

test('dispatchBncrInbound keeps canonical to/session identity locked while preserving provided originating target', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    originatingTo: 'BncrRaw:tgBot:-1001:10001',
    type: 'text',
    msg: 'hello canonical lock',
    mimeType: 'text/plain',
    msgId: 'inbound-canonical-lock',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 1);
  assert.equal(calls.builtContexts[0].To, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.builtContexts[0].OriginatingTo, 'BncrRaw:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].EnvelopeFrom, 'BncrRaw:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].ConversationLabel, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.builtContexts[0].SessionKey, 'agent:orion:bncr:group:7467426f743a2d31303031');

  assert.equal(calls.recorded.length, 1);
  assert.equal(calls.recorded[0].ctx.SessionKey, 'agent:orion:bncr:group:7467426f743a2d31303031');
  assert.equal(calls.recorded[0].ctx.To, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.recorded[0].ctx.OriginatingTo, 'BncrRaw:tgBot:-1001:10001');
  assert.equal(calls.recorded[0].ctx.ConversationLabel, 'Bncr:tgBot:-1001:0');

  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].sessionKey, 'agent:orion:bncr:group:7467426f743a2d31303031');
  assert.deepEqual(enqueueCalls[0].route, {
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
  });
  assert.equal(enqueueCalls[0].payload.text, 'reply from agent');
  assert.equal(enqueueCalls[0].payload.replyToId, 'inbound-canonical-lock');
});

test('dispatchBncrInbound serializes reply dispatch for the same group sessionKey', async () => {
  resetBncrReplyDispatchSerialForTest();
  const firstGate = createDeferred();
  const secondStarted = createDeferred();
  const startOrder = [];
  const { api, calls } = createInboundApiStub({
    async onReplyDispatchStart({ ctx }) {
      startOrder.push(ctx?.MessageSid);
      if (ctx?.MessageSid === 'inbound-serial-1') {
        await firstGate.promise;
      }
      if (ctx?.MessageSid === 'inbound-serial-2') {
        secondStarted.resolve();
      }
    },
  });

  const firstParsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: 'first dispatch',
    mimeType: 'text/plain',
    msgId: 'inbound-serial-1',
  });
  const secondParsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: 'second dispatch',
    mimeType: 'text/plain',
    msgId: 'inbound-serial-2',
  });

  const firstRun = dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: firstParsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const secondRun = dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: secondParsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  await Promise.race([
    secondStarted.promise.then(() => 'started'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 25)),
  ]).then((result) => {
    assert.equal(result, 'timeout');
  });
  assert.deepEqual(startOrder, ['inbound-serial-1']);
  assert.equal(calls.replyDispatchStarts.length, 1);

  firstGate.resolve();
  await secondStarted.promise;
  await Promise.all([firstRun, secondRun]);

  assert.deepEqual(startOrder, ['inbound-serial-1', 'inbound-serial-2']);
  assert.equal(calls.replyDispatchStarts.length, 2);
  assert.equal(calls.replyDispatchCompletions.length, 2);
});

test('dispatchBncrInbound keeps reply dispatch concurrent across different group sessionKeys', async () => {
  resetBncrReplyDispatchSerialForTest();
  const firstGate = createDeferred();
  const secondStarted = createDeferred();
  const startOrder = [];
  const { api, calls } = createInboundApiStub({
    async onReplyDispatchStart({ ctx }) {
      startOrder.push(ctx?.MessageSid);
      if (ctx?.MessageSid === 'inbound-parallel-1') {
        await firstGate.promise;
      }
      if (ctx?.MessageSid === 'inbound-parallel-2') {
        secondStarted.resolve();
      }
    },
  });

  const firstParsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: 'first group dispatch',
    mimeType: 'text/plain',
    msgId: 'inbound-parallel-1',
  });
  const secondParsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-2002',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: 'second group dispatch',
    mimeType: 'text/plain',
    msgId: 'inbound-parallel-2',
  });

  const firstRun = dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: firstParsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const secondRun = dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed: secondParsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  await secondStarted.promise;
  assert.deepEqual(startOrder, ['inbound-parallel-1', 'inbound-parallel-2']);
  assert.equal(calls.replyDispatchStarts.length, 2);

  firstGate.resolve();
  await Promise.all([firstRun, secondRun]);
  assert.equal(calls.replyDispatchCompletions.length, 2);
});
