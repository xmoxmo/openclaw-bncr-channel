import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatchBncrInbound,
  resolveBncrInboundConversation,
} from '../../src/messaging/inbound/dispatch.ts';
import { parseBncrInboundParams, resolveChatType } from '../../src/messaging/inbound/parse.ts';
import { createInboundApiStub } from '../helpers/inbound-runtime.mjs';

test('resolveChatType keeps inbound bncr conversations locked to direct compatibility mode', () => {
  assert.equal(resolveChatType({ platform: 'tgBot', groupId: '0', userId: '10001' }), 'direct');
  assert.equal(resolveChatType({ platform: 'tgBot', groupId: '-1001', userId: '10001' }), 'direct');

  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'text',
    msg: 'group-looking inbound still direct',
    msgId: 'inbound-group-looking-direct',
  });

  assert.equal(parsed.peer.kind, 'direct');
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
  assert.equal(resolution.chatType, 'direct');
  assert.equal(resolution.rawTo, 'Bncr:tgBot:-1001:10001');
  assert.equal(resolution.canonicalTo, 'Bncr:tgBot:-1001:10001');
  assert.equal(resolution.originatingTo, resolution.rawTo);
  assert.equal(
    resolution.baseSessionKey,
    'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
  );
  assert.equal(
    resolution.dispatchSessionKey,
    'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
  );
});

test('dispatchBncrInbound carries parsed mimeType and peer kind into built inbound context', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
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
  assert.equal(calls.builtContexts[0].ChatType, 'direct');
  assert.equal(calls.builtContexts[0].SenderId, 'client-1');
  assert.equal(calls.builtContexts[0].MessageSid, 'inbound-1');
  assert.equal(calls.builtContexts[0].Body, 'ENV:hello inbound');
  assert.equal(calls.builtContexts[0].BodyForAgent, 'hello inbound');
  assert.equal(calls.builtContexts[0].RawBody, 'hello inbound');
  assert.equal(calls.builtContexts[0].CommandBody, 'hello inbound');
  assert.equal(calls.builtContexts[0].BodyForCommands, 'hello inbound');
  assert.deepEqual(calls.builtContextArgs[0].sender, {
    id: 'client-1',
    name: 'bncr-client',
    username: 'bncr-client',
  });
  assert.deepEqual(calls.builtContextArgs[0].conversation, {
    kind: 'direct',
    id: '-1001',
    label: 'Bncr:tgBot:-1001:10001',
    routePeer: {
      kind: 'direct',
      id: '-1001',
    },
  });
  assert.deepEqual(calls.builtContextArgs[0].route, {
    agentId: 'orion',
    accountId: 'Primary',
    routeSessionKey: 'agent:orion:bncr:direct:demo',
    dispatchSessionKey: 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
    mainSessionKey: undefined,
  });
  assert.deepEqual(calls.builtContextArgs[0].reply, {
    to: 'Bncr:tgBot:-1001:10001',
    originatingTo: 'Bncr:tgBot:-1001:10001',
  });
  assert.deepEqual(calls.builtContextArgs[0].message, {
    inboundEventKind: 'user_request',
    body: 'ENV:hello inbound',
    rawBody: 'hello inbound',
    bodyForAgent: 'hello inbound',
    commandBody: 'hello inbound',
    envelopeFrom: 'Bncr:tgBot:-1001:10001',
    senderLabel: 'bncr-client',
  });
  assert.equal(calls.builtContextArgs[0].supplemental.untrustedContext.length, 0);
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
      routeSessionKey: 'agent:orion:bncr:direct:demo',
      dispatchSessionKey: 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
      mainSessionKey: undefined,
    },
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
      id: 'inbound-1',
      rawBody: 'hello inbound',
      bodyForAgent: 'hello inbound',
      commandBody: 'hello inbound',
      envelopeBody: 'ENV:hello inbound',
    },
    media: [],
  });
  assert.equal(calls.builtContexts[0].To, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].OriginatingTo, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].EnvelopeFrom, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].ConversationLabel, 'Bncr:tgBot:-1001:10001');
  assert.deepEqual(calls.recorded[0].updateLastRoute, {
    sessionKey: 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
    channel: 'bncr',
    to: 'Bncr:tgBot:-1001:10001',
    accountId: 'Primary',
    mainDmOwnerPin: undefined,
  });
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].accountId, 'Primary');
  assert.equal(
    enqueueCalls[0].sessionKey,
    'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
  );
  assert.deepEqual(enqueueCalls[0].route, {
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
  });
  assert.equal(enqueueCalls[0].payload.text, 'reply from agent');
  assert.equal(enqueueCalls[0].payload.kind, 'final');
  assert.equal(calls.builtContexts[0].ChatType, 'direct');
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
  assert.equal(resolution.canonicalTo, 'Bncr:tgBot:-1001:10001');
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

  assert.equal(calls.builtContexts[0].To, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].OriginatingTo, 'BncrRaw:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].EnvelopeFrom, 'BncrRaw:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].ConversationLabel, 'Bncr:tgBot:-1001:10001');
  assert.deepEqual(calls.builtContextArgs[0].supplemental.untrustedContext, [
    {
      label: 'Bncr inbound context',
      source: 'bncr',
      type: 'bncr.inbound_context',
      payload: {
        reply: {
          to: 'Bncr:tgBot:-1001:10001',
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
  assert.equal(calls.builtContexts[0].To, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].OriginatingTo, 'BncrRaw:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].EnvelopeFrom, 'BncrRaw:tgBot:-1001:10001');
  assert.equal(calls.builtContexts[0].ConversationLabel, 'Bncr:tgBot:-1001:10001');
  assert.equal(
    calls.builtContexts[0].SessionKey,
    'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
  );

  assert.equal(calls.recorded.length, 1);
  assert.equal(
    calls.recorded[0].ctx.SessionKey,
    'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
  );
  assert.equal(calls.recorded[0].ctx.To, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.recorded[0].ctx.OriginatingTo, 'BncrRaw:tgBot:-1001:10001');
  assert.equal(calls.recorded[0].ctx.ConversationLabel, 'Bncr:tgBot:-1001:10001');

  assert.equal(enqueueCalls.length, 1);
  assert.equal(
    enqueueCalls[0].sessionKey,
    'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
  );
  assert.deepEqual(enqueueCalls[0].route, {
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
  });
  assert.equal(enqueueCalls[0].payload.text, 'reply from agent');
  assert.equal(enqueueCalls[0].payload.replyToId, 'inbound-canonical-lock');
});
