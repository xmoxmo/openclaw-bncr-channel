import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { dispatchBncrInbound } from '../../src/messaging/inbound/dispatch.ts';
import { parseBncrInboundParams } from '../../src/messaging/inbound/parse.ts';
import { withConsoleCapture } from '../helpers/console-capture.mjs';
import { buildParsedInboundText, createInboundApiStub } from '../helpers/inbound-runtime.mjs';

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

  const { result, logLines } = await withConsoleCapture('log', async ({ log }) => {
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
    return { result, logLines: log };
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
  assert.ok(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes(
          'verbose command=verbose|accountId=Primary|to=Bncr:tgBot:-1001:10001|msgId=slash-verbose-on|result=handled',
        ),
    ),
  );
  assert.equal(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes('"event":"handled-verbose"') &&
        line.includes('"fallbackToAgent":false'),
    ),
    false,
  );
});

test('slash verbose command emits detailed native-command JSON only in verbose debug mode', async () => {
  const { api } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'text',
    msg: '/verbose on',
    mimeType: 'text/plain',
    msgId: 'slash-verbose-debug',
  });

  const { logLines } = await withConsoleCapture('log', async ({ log }) => {
    await dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: { channels: { bncr: { debug: { verbose: true } } } },
      parsed,
      canonicalAgentId: 'orion',
      rememberSessionRoute() {},
      enqueueFromReply: async () => {},
      setInboundActivity() {},
      scheduleSave() {},
    });
    return { logLines: log };
  });

  assert.ok(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes(
          'verbose command=verbose|accountId=Primary|to=Bncr:tgBot:-1001:10001|msgId=slash-verbose-debug|result=handled',
        ),
    ),
  );
  assert.ok(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes('"event":"handled-verbose"') &&
        line.includes('"fallbackToAgent":false') &&
        line.includes('"msgId":"slash-verbose-debug"'),
    ),
  );
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

  const { result, logLines } = await withConsoleCapture('log', async ({ log }) => {
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
    return { result, logLines: log };
  });

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
  assert.equal(
    calls.turnRuns[1].ctxPayload.StructuredContextFacts.reply.to,
    'Bncr:tgBot:-1001:10001',
  );
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
    logLines.some(
      (line) => line.includes('[bncr] native-command') && line.includes('"event":"detected"'),
    ),
    false,
  );
  assert.ok(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes(
          'fallback command=unknown-native-command|accountId=Primary|to=Bncr:tgBot:-1001:10001|msgId=slash-fallback-1|reason=no-payload',
        ),
    ),
  );
  assert.equal(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes('"event":"no-payload-fallback-to-agent"') &&
        line.includes('"fallbackToAgent":true'),
    ),
    false,
  );
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
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-fallback-1');
});

test('slash command fallback emits detailed native-command JSON only in verbose debug mode', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'text',
    msg: '/unknown-native-command',
    mimeType: 'text/plain',
    msgId: 'slash-fallback-debug',
  });

  const { logLines } = await withConsoleCapture('log', async ({ log }) => {
    await dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: { channels: { bncr: { debug: { verbose: true } } } },
      parsed,
      canonicalAgentId: 'orion',
      rememberSessionRoute() {},
      enqueueFromReply: async () => {},
      setInboundActivity() {},
      scheduleSave() {},
    });
    return { logLines: log };
  });

  assert.ok(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes(
          'fallback command=unknown-native-command|accountId=Primary|to=Bncr:tgBot:-1001:10001|msgId=slash-fallback-debug|reason=no-payload',
        ),
    ),
  );
  assert.ok(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes('"event":"no-payload-fallback-to-agent"') &&
        line.includes('"fallbackToAgent":true') &&
        line.includes('"msgId":"slash-fallback-debug"'),
    ),
  );
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
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-fallback-no-client');
});

test('native command help reply and fallback reply keep the same canonical session route', async () => {
  const nativeReplyStub = createInboundApiStub({ nativeCommandProducesReply: true });
  const fallbackStub = createInboundApiStub({ nativeCommandProducesReply: false });
  const nativeParsed = parseBncrInboundParams(
    buildParsedInboundText({ msg: '/help', msgId: 'slash-help-route' }),
  );
  const fallbackParsed = parseBncrInboundParams(
    buildParsedInboundText({ msg: '/unknown-native-command', msgId: 'slash-fallback-route' }),
  );
  const nativeEnqueueCalls = [];
  const fallbackEnqueueCalls = [];

  await dispatchBncrInbound({
    api: nativeReplyStub.api,
    channelId: 'bncr',
    cfg: {},
    parsed: nativeParsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      nativeEnqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });
  await dispatchBncrInbound({
    api: fallbackStub.api,
    channelId: 'bncr',
    cfg: {},
    parsed: fallbackParsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      fallbackEnqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(nativeEnqueueCalls[0].sessionKey, fallbackEnqueueCalls[0].sessionKey);
  assert.deepEqual(nativeEnqueueCalls[0].route, fallbackEnqueueCalls[0].route);
  assert.equal(nativeEnqueueCalls[0].payload.replyToId, 'slash-help-route');
  assert.equal(fallbackEnqueueCalls[0].payload.replyToId, 'slash-fallback-route');
});
