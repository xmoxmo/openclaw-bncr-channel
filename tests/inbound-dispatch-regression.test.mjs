import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBncrBridge } from '../src/channel.ts';
import {
  assertInboundMediaBase64Size,
  decodeInboundMediaBase64,
  dispatchBncrInbound,
  estimateBase64DecodedBytes,
  resolveBncrInboundConversation,
} from '../src/messaging/inbound/dispatch.ts';
import { parseBncrInboundParams, resolveChatType } from '../src/messaging/inbound/parse.ts';
import { setBncrInboundSessionRuntimeForTest } from '../src/openclaw/inbound-session-runtime.ts';

function createInboundApiStub(options = {}) {
  const currentConfig = {};
  const storePath = options.storePath || path.join(os.tmpdir(), `bncr-test-store-${Date.now()}-${Math.random()}.json`);
  const nativeCommandProducesReply = options.nativeCommandProducesReply ?? true;
  const calls = {
    builtContextArgs: [],
    builtContexts: [],
    recorded: [],
    delivered: [],
    turnRuns: [],
    sessionPatches: [],
    savedMediaBuffers: [],
  };

  const restoreSessionRuntime = setBncrInboundSessionRuntimeForTest({
    resolveStorePath() {
      return storePath;
    },
    async recordInboundSession(args) {
      calls.recorded.push(args);
    },
    readSessionUpdatedAt() {
      return 0;
    },
    async recordSessionMetaFromInbound(args) {
      const existing = fs.existsSync(args.storePath)
        ? JSON.parse(fs.readFileSync(args.storePath, 'utf8'))
        : {};
      existing[args.sessionKey] = {
        ...(existing[args.sessionKey] || {}),
        label: args.ctx?.ConversationLabel,
        channel: args.ctx?.OriginatingChannel,
        chatType: args.ctx?.ChatType,
      };
      fs.writeFileSync(args.storePath, JSON.stringify(existing, null, 2));
    },
    async updateSessionStoreEntry(args) {
      calls.sessionPatches.push(args);
      const existing = fs.existsSync(args.storePath)
        ? JSON.parse(fs.readFileSync(args.storePath, 'utf8'))
        : {};
      const current = existing[args.sessionKey] || {};
      const patch = args.update(current);
      if (patch) {
        existing[args.sessionKey] = { ...current, ...patch };
        fs.writeFileSync(args.storePath, JSON.stringify(existing, null, 2));
      }
    },
  });

  const api = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {
      config: {
        current() {
          return currentConfig;
        },
        get() {
          return currentConfig;
        },
        async loadConfig() {
          return currentConfig;
        },
      },
      channel: {
        routing: {
          resolveAgentRoute() {
            return { sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion' };
          },
        },
        session: {
          resolveStorePath() {
            return storePath;
          },
          readSessionUpdatedAt() {
            return 0;
          },
          async recordInboundSession(args) {
            calls.recorded.push(args);
          },
          async recordSessionMetaFromInbound(args) {
            calls.recorded.push(args);
          },
          async updateSessionStoreEntry(args) {
            calls.sessionPatches.push(args);
          },
        },
        media: {
          async saveMediaBuffer(buffer, mimeType, direction, maxBytes, fileName) {
            calls.savedMediaBuffers.push({ buffer, mimeType, direction, maxBytes, fileName });
            return { path: '/tmp/bncr-inbound-media.bin' };
          },
        },
        reply: {
          resolveEnvelopeFormatOptions() {
            return {};
          },
          formatAgentEnvelope({ body }) {
            return `ENV:${body}`;
          },
          async dispatchReplyWithBufferedBlockDispatcher({ ctx, dispatcherOptions }) {
            if (ctx?.CommandTurn?.kind === 'native' && !nativeCommandProducesReply) {
              calls.delivered.push({ text: null, kind: 'native-noop' });
              return;
            }
            await dispatcherOptions.deliver({ text: 'reply from agent' }, { kind: 'final' });
            calls.delivered.push({ text: 'reply from agent', kind: 'final' });
          },
        },
        turn: {
          buildContext(args) {
            calls.builtContextArgs.push(args);
            const ctx = {
              ...args.extra,
              Body: args.message.body,
              BodyForAgent: args.message.bodyForAgent,
              RawBody: args.message.rawBody,
              CommandBody: args.message.commandBody,
              BodyForCommands: args.message.commandBody,
              MediaPath: args.media?.[0]?.path,
              MediaType: args.media?.[0]?.contentType,
              ChatType: args.conversation.kind,
              SenderId: args.sender.id,
              MessageSid: args.messageId,
              To: args.reply.to,
              OriginatingTo: args.reply.originatingTo,
              EnvelopeFrom: args.message.envelopeFrom,
              ConversationLabel: args.conversation.label,
              SessionKey: args.route.dispatchSessionKey,
              RouteSessionKey: args.route.routeSessionKey,
              DispatchSessionKey: args.route.dispatchSessionKey,
              MainSessionKey: args.route.mainSessionKey,
              CommandTurn: args.commandTurn,
              UntrustedStructuredContext: args.supplemental?.untrustedContext,
            };
            calls.builtContexts.push(ctx);
            return ctx;
          },
          async run({ adapter }) {
            const turn = adapter.resolveTurn();
            calls.turnRuns.push(turn);
            await turn.recordInboundSession({
              storePath: turn.storePath,
              sessionKey: turn.routeSessionKey,
              ctx: turn.ctxPayload,
              updateLastRoute: turn.record.updateLastRoute,
              onRecordError: turn.record.onRecordError,
            });
            await turn.runDispatch();
            adapter.onFinalize?.();
          },
        },
      },
    },
  };

  return { api, calls, storePath, restoreSessionRuntime };
}

function cleanupBridge(bridge) {
  if (bridge.saveTimer) clearTimeout(bridge.saveTimer);
  if (bridge.pushTimer) clearTimeout(bridge.pushTimer);
  for (const waiter of bridge.messageAckWaiters?.values?.() || []) {
    clearTimeout(waiter.timer);
  }
  bridge.messageAckWaiters?.clear?.();
}


test('estimateBase64DecodedBytes accounts for padding and whitespace before inbound media guard', () => {
  assert.equal(estimateBase64DecodedBytes('TWFu'), 3);
  assert.equal(estimateBase64DecodedBytes('TWE='), 2);
  assert.equal(estimateBase64DecodedBytes('TQ=='), 1);
  assert.equal(estimateBase64DecodedBytes(' T W F u\n'), 3);
  assert.doesNotThrow(() => assertInboundMediaBase64Size('TWFu', 3));
  assert.throws(
    () => assertInboundMediaBase64Size('TWFu', 2),
    /inbound media too large: estimated 3 bytes exceeds 2 bytes/,
  );
});

test('decodeInboundMediaBase64 rejects empty decoded media and decoded oversize payloads', () => {
  assert.equal(decodeInboundMediaBase64(' T 2s= ').toString(), 'Ok');
  assert.throws(
    () => decodeInboundMediaBase64('', 10),
    /inbound media base64 decoded to empty buffer/,
  );
  assert.throws(
    () => decodeInboundMediaBase64('====', 10),
    /inbound media base64 decoded to empty buffer/,
  );
  assert.throws(
    () => decodeInboundMediaBase64(Buffer.from('too-large').toString('base64'), 3),
    /inbound media too large:/,
  );
});

test('dispatchBncrInbound saves normal inline base64 media after preflight size check', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'image',
    msg: 'image inbound',
    base64: Buffer.from('ok').toString('base64'),
    mimeType: 'image/png',
    fileName: 'demo.png',
    msgId: 'inbound-media-small',
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

  assert.equal(calls.savedMediaBuffers.length, 1);
  assert.equal(calls.savedMediaBuffers[0].buffer.toString(), 'ok');
  assert.equal(calls.savedMediaBuffers[0].mimeType, 'image/png');
  assert.equal(calls.builtContexts[0].Body, 'ENV:image inbound');
  assert.equal(calls.builtContexts[0].BodyForAgent, 'image inbound');
  assert.equal(calls.builtContexts[0].RawBody, 'image inbound');
  assert.equal(calls.builtContexts[0].CommandBody, 'image inbound');
  assert.equal(calls.builtContexts[0].BodyForCommands, 'image inbound');
  assert.equal(calls.builtContexts[0].MediaPath, '/tmp/bncr-inbound-media.bin');
  assert.equal(calls.builtContexts[0].MediaType, 'image/png');
  assert.deepEqual(
    calls.builtContexts[0].BncrStructuredContextFacts,
    calls.builtContexts[0].StructuredContextFacts,
  );
  assert.deepEqual(calls.builtContexts[0].StructuredContextFacts.media, [
    {
      path: '/tmp/bncr-inbound-media.bin',
      contentType: 'image/png',
      kind: 'image',
      messageId: 'inbound-media-small',
    },
  ]);
  assert.deepEqual(calls.builtContextArgs[0].supplemental.untrustedContext, [
    {
      label: 'Bncr inbound context',
      source: 'bncr',
      type: 'bncr.inbound_context',
      payload: {
        media: [
          {
            contentType: 'image/png',
            kind: 'image',
            messageId: 'inbound-media-small',
          },
        ],
      },
    },
  ]);
});

test('resolveChatType keeps inbound bncr conversations locked to direct compatibility mode', () => {
  assert.equal(resolveChatType({ platform: 'tgBot', groupId: '0', userId: '10001' }), 'direct');
  assert.equal(
    resolveChatType({ platform: 'tgBot', groupId: '-1001', userId: '10001' }),
    'direct',
  );

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
  assert.equal(resolution.baseSessionKey, 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031');
  assert.equal(resolution.dispatchSessionKey, 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031');
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
  assert.equal(enqueueCalls[0].sessionKey, 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031');
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
  assert.equal(enqueueCalls[0].sessionKey, 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031');
  assert.deepEqual(enqueueCalls[0].route, {
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
  });
  assert.equal(enqueueCalls[0].payload.text, 'reply from agent');
  assert.equal(enqueueCalls[0].payload.replyToId, 'inbound-canonical-lock');
});

test('slash verbose command is handled natively and preserves bncr session identity', async () => {
  const { api, calls, storePath } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'text',
    msg: '/verbose on',
    mimeType: 'text/plain',
    msgId: 'slash-verbose-on',
  });
  const enqueueCalls = [];
  const activityCalls = [];

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
    setInboundActivity: (...args) => activityCalls.push(args),
    scheduleSave() {},
  });

  assert.equal(result.accountId, 'Primary');
  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'Verbose logging enabled.');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-verbose-on');
  assert.equal(activityCalls.length, 1);
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const entry = stored['agent:orion:bncr:direct:7467426f743a2d313030313a3130303031'];
  assert.ok(entry);
  assert.equal(entry.verboseLevel, 'on');
  assert.equal(entry.label, 'Bncr:tgBot:-1001:10001');
  assert.equal(entry.channel, 'bncr');
  assert.equal(entry.chatType, 'direct');
  assert.equal(entry.origin.to, 'Bncr:tgBot:-1001:10001');
  assert.equal(entry.deliveryContext.channel, 'bncr');
  assert.equal(entry.route.target.to, 'Bncr:tgBot:-1001:10001');
  assert.equal(entry.lastTo, 'Bncr:tgBot:-1001:10001');
});

test('slash command with native reply is handled on bncr route without normal agent fallback', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: true });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'text',
    msg: '/help',
    mimeType: 'text/plain',
    msgId: 'slash-native-reply',
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
  assert.equal(calls.turnRuns.length, 1);
  assert.equal(calls.turnRuns[0].ctxPayload.CommandTurn.kind, 'native');
  assert.equal(calls.turnRuns[0].ctxPayload.Body, '/commands');
  assert.equal(calls.turnRuns[0].ctxPayload.BodyForAgent, '/commands');
  assert.equal(calls.turnRuns[0].ctxPayload.RawBody, '/commands');
  assert.equal(calls.turnRuns[0].ctxPayload.CommandBody, '/commands');
  assert.equal(calls.turnRuns[0].ctxPayload.BodyForCommands, '/commands');
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'reply from agent');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-native-reply');
});

test('slash command with no native reply falls back to normal bncr agent inbound instead of webchat', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: false });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'text',
    msg: '/unknown-native-command',
    mimeType: 'text/plain',
    msgId: 'slash-fallback-1',
  });
  const enqueueCalls = [];
  const logLines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logLines.push(args.join(' '));
    originalLog(...args);
  };

  let result;
  try {
    result = await dispatchBncrInbound({
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
  } finally {
    console.log = originalLog;
  }

  assert.equal(result.accountId, 'Primary');
  assert.equal(calls.turnRuns.length, 2);
  assert.equal(calls.turnRuns[0].ctxPayload.CommandTurn.kind, 'native');
  assert.equal(calls.turnRuns[0].ctxPayload.To, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.turnRuns[0].ctxPayload.OriginatingTo, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.turnRuns[0].ctxPayload.ConversationLabel, 'Bncr:tgBot:-1001:10001');
  assert.equal(
    calls.turnRuns[0].ctxPayload.SessionKey,
    'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
  );
  assert.equal(calls.turnRuns[1].ctxPayload.CommandTurn?.kind, undefined);
  assert.equal(calls.turnRuns[1].ctxPayload.Body, 'ENV:/unknown-native-command');
  assert.equal(calls.turnRuns[1].ctxPayload.BodyForAgent, '/unknown-native-command');
  assert.equal(calls.turnRuns[1].ctxPayload.RawBody, '/unknown-native-command');
  assert.equal(calls.turnRuns[1].ctxPayload.CommandBody, '/unknown-native-command');
  assert.equal(calls.turnRuns[1].ctxPayload.BodyForCommands, '/unknown-native-command');
  assert.deepEqual(
    calls.turnRuns[1].ctxPayload.BncrStructuredContextFacts,
    calls.turnRuns[1].ctxPayload.StructuredContextFacts,
  );
  assert.equal(
    calls.turnRuns[1].ctxPayload.StructuredContextFacts.message.envelopeBody,
    'ENV:/unknown-native-command',
  );
  assert.equal(
    calls.turnRuns[1].ctxPayload.StructuredContextFacts.message.bodyForAgent,
    '/unknown-native-command',
  );
  assert.equal(
    calls.turnRuns[1].ctxPayload.StructuredContextFacts.message.commandBody,
    '/unknown-native-command',
  );
  assert.equal(calls.turnRuns[1].ctxPayload.StructuredContextFacts.reply.to, 'Bncr:tgBot:-1001:10001');
  assert.deepEqual(calls.turnRuns[1].ctxPayload.UntrustedStructuredContext, []);
  assert.equal(calls.turnRuns[1].ctxPayload.To, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.turnRuns[1].ctxPayload.OriginatingTo, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.turnRuns[1].ctxPayload.ConversationLabel, 'Bncr:tgBot:-1001:10001');
  assert.equal(
    calls.turnRuns[1].ctxPayload.SessionKey,
    'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
  );
  assert.equal(calls.recorded.length, 2);
  assert.equal(calls.recorded[0].ctx.To, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.recorded[0].ctx.OriginatingTo, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.recorded[0].ctx.ConversationLabel, 'Bncr:tgBot:-1001:10001');
  assert.equal(
    calls.recorded[0].ctx.SessionKey,
    'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
  );
  assert.equal(calls.recorded[1].ctx.To, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.recorded[1].ctx.OriginatingTo, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.recorded[1].ctx.ConversationLabel, 'Bncr:tgBot:-1001:10001');
  assert.equal(
    calls.recorded[1].ctx.SessionKey,
    'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
  );
  assert.equal(
    logLines.some((line) => line.includes('[bncr] native-command') && line.includes('"event":"detected"')),
    false,
  );
  assert.ok(logLines.some((line) => line.includes('[bncr] native-command') && line.includes('"event":"no-payload-fallback-to-agent"') && line.includes('"fallbackToAgent":true')));
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].sessionKey, 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031');
  assert.deepEqual(enqueueCalls[0].route, {
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
  });
  assert.equal(enqueueCalls[0].payload.text, 'reply from agent');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-fallback-1');
});

test('slash command without clientId still falls back to normal bncr agent inbound', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: false });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'text',
    msg: '/unknown-native-command',
    mimeType: 'text/plain',
    msgId: 'slash-fallback-no-client',
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
  assert.equal(calls.turnRuns.length, 2);
  assert.equal(calls.turnRuns[0].ctxPayload.CommandTurn.kind, 'native');
  assert.equal(calls.turnRuns[0].ctxPayload.SenderId, 'Bncr:tgBot:-1001:10001');
  assert.equal(calls.turnRuns[1].ctxPayload.CommandTurn?.kind, undefined);
  assert.equal(calls.turnRuns[1].ctxPayload.Body, 'ENV:/unknown-native-command');
  assert.equal(calls.turnRuns[1].ctxPayload.BodyForAgent, '/unknown-native-command');
  assert.equal(calls.turnRuns[1].ctxPayload.RawBody, '/unknown-native-command');
  assert.equal(calls.turnRuns[1].ctxPayload.CommandBody, '/unknown-native-command');
  assert.equal(calls.turnRuns[1].ctxPayload.BodyForCommands, '/unknown-native-command');
  assert.deepEqual(
    calls.turnRuns[1].ctxPayload.BncrStructuredContextFacts,
    calls.turnRuns[1].ctxPayload.StructuredContextFacts,
  );
  assert.equal(
    calls.turnRuns[1].ctxPayload.StructuredContextFacts.message.envelopeBody,
    'ENV:/unknown-native-command',
  );
  assert.equal(
    calls.turnRuns[1].ctxPayload.StructuredContextFacts.sender.id,
    'Bncr:tgBot:-1001:10001',
  );
  assert.equal(
    calls.turnRuns[1].ctxPayload.StructuredContextFacts.sender.displayName,
    'Bncr:tgBot:-1001:10001',
  );
  assert.equal(calls.turnRuns[1].ctxPayload.SenderId, 'Bncr:tgBot:-1001:10001');
  assert.deepEqual(calls.turnRuns[1].ctxPayload.UntrustedStructuredContext, []);
  assert.equal(calls.turnRuns[1].ctxPayload.To, 'Bncr:tgBot:-1001:10001');
  assert.equal(
    calls.turnRuns[1].ctxPayload.SessionKey,
    'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
  );
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].sessionKey, 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031');
  assert.deepEqual(enqueueCalls[0].route, {
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
  });
  assert.equal(enqueueCalls[0].payload.text, 'reply from agent');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-fallback-no-client');
});

test('handleInbound async dispatch path reaches built inbound context instead of stopping at pre-dispatch flush', async () => {
  const { api, calls } = createInboundApiStub();
  const bridge = createBncrBridge(api);
  const responses = [];

  try {
    await bridge.handleInbound({
      params: {
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        type: 'text',
        msg: 'hello inbound',
        mimeType: 'text/plain',
        msgId: 'inbound-async-1',
      },
      respond(ok, payload) {
        responses.push({ ok, payload });
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, true);
    assert.equal(responses[0].payload.msgId, 'inbound-async-1');
    assert.equal(calls.builtContexts.length, 1);
    assert.equal(calls.recorded.length, 1);
    assert.equal(calls.builtContexts[0].MediaType, undefined);
    assert.equal(calls.builtContexts[0].ChatType, 'direct');
    assert.deepEqual(calls.builtContexts[0].UntrustedStructuredContext, []);
  } finally {
    cleanupBridge(bridge);
  }
});
