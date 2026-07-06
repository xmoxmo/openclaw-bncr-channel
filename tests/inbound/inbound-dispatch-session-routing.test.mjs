import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCommandAuthorization } from 'openclaw/plugin-sdk/command-auth-native';
import {
  dispatchBncrInbound,
  resolveBncrInboundConversation,
} from '../../src/messaging/inbound/dispatch.ts';
import { prepareBncrInboundSessionContext } from '../../src/messaging/inbound/dispatch-prep.ts';
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
  assert.equal(resolution.originatingTo, resolution.rawTo);
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
    originatingTo: 'Bncr:tgBot:-1001:10001',
  });
  assert.deepEqual(calls.builtContextArgs[0].message, {
    inboundEventKind: 'user_request',
    body: 'ENV:hello inbound',
    rawBody: 'hello inbound',
    bodyForAgent: 'ENV:hello inbound',
    inboundHistory: [],
    commandBody: 'hello inbound',
    envelopeFrom: 'Bncr:tgBot:-1001:10001',
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
      originatingTo: 'Bncr:tgBot:-1001:10001',
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
  });
  assert.equal(calls.builtContexts[0].To, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.builtContexts[0].OriginatingTo, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].EnvelopeFrom, 'Bncr:tgBot:-1001:10001');
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
  const groupHistories = new Map();
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
    groupHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.builtContexts.length, 1);
  assert.equal(calls.recorded.length, 1);
  assert.equal(calls.delivered.length, 0);
  assert.equal(groupHistories.size, 0);
});

test('dispatchBncrInbound replays pending group text and image history on later dispatched turn and clears window', async () => {
  const { api, calls } = createInboundApiStub();
  const groupHistories = new Map();

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
    groupHistories,
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
    groupHistories,
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
    groupHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const triggeredCtx = calls.builtContextArgs.at(-1);
  assert.ok(triggeredCtx);
  assert.match(triggeredCtx.message.bodyForAgent, /ENV:silent text/);
  assert.match(triggeredCtx.message.bodyForAgent, /ENV:<media:image>/);
  assert.equal(triggeredCtx.message.inboundHistory?.length, 2);
  assert.deepEqual(triggeredCtx.message.inboundHistory?.[1]?.media, [
    {
      path: '/tmp/bncr-inbound-media-1.bin',
      contentType: 'image/png',
      kind: 'image',
      messageId: 'pending-image-1',
    },
  ]);
  assert.deepEqual(groupHistories.get('tgBot:-1001'), []);
});

test('dispatchBncrInbound retains all pending group images from one mediaList turn for later replay', async () => {
  const { api, calls } = createInboundApiStub();
  const groupHistories = new Map();

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
    groupHistories,
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
    groupHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const triggeredCtx = calls.builtContextArgs.at(-1);
  assert.ok(triggeredCtx);
  assert.match(triggeredCtx.message.bodyForAgent, /ENV:<media:image> \(2 images\)/);
  assert.equal(triggeredCtx.message.inboundHistory?.length, 1);
  assert.deepEqual(triggeredCtx.message.inboundHistory?.[0]?.media, [
    {
      path: '/tmp/bncr-inbound-media-1.bin',
      contentType: 'image/png',
      kind: 'image',
      messageId: 'pending-album-1',
    },
    {
      path: '/tmp/bncr-inbound-media-2.bin',
      contentType: 'image/jpeg',
      kind: 'image',
      messageId: 'pending-album-1',
    },
  ]);
});

test('dispatchBncrInbound records video, audio, and document group history markers for later replay', async () => {
  const { api, calls } = createInboundApiStub();
  const groupHistories = new Map();

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
    groupHistories,
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
    groupHistories,
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
    groupHistories,
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
    groupHistories,
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  const triggeredCtx = calls.builtContextArgs.at(-1);
  assert.ok(triggeredCtx);
  assert.match(triggeredCtx.message.bodyForAgent, /ENV:<media:video>/);
  assert.match(triggeredCtx.message.bodyForAgent, /ENV:<media:audio>/);
  assert.match(triggeredCtx.message.bodyForAgent, /ENV:<media:document>/);
  assert.deepEqual(triggeredCtx.message.inboundHistory, [
    {
      sender: 'alice',
      body: '<media:video>',
      timestamp: triggeredCtx.message.inboundHistory[0].timestamp,
      messageId: 'pending-video-1',
    },
    {
      sender: 'bob',
      body: '<media:audio>',
      timestamp: triggeredCtx.message.inboundHistory[1].timestamp,
      messageId: 'pending-audio-1',
    },
    {
      sender: 'carol',
      body: '<media:document>',
      timestamp: triggeredCtx.message.inboundHistory[2].timestamp,
      messageId: 'pending-file-1',
    },
  ]);
  assert.equal(triggeredCtx.message.inboundHistory[0].media, undefined);
  assert.equal(triggeredCtx.message.inboundHistory[1].media, undefined);
  assert.equal(triggeredCtx.message.inboundHistory[2].media, undefined);
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
        reply: {
          to: 'Bncr:tgBot:-1001:0',
          originatingTo: 'BncrRaw:tgBot:-1001:10001',
        },
      },
    },
  ]);
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
