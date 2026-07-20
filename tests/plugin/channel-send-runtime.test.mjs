import assert from 'node:assert/strict';
import test from 'node:test';
import { createBncrChannelSendRuntime } from '../../src/plugin/channel-send.ts';

function createRuntimeHarness() {
  const calls = [];
  const outbox = [];
  const runtime = createBncrChannelSendRuntime({
    channelId: 'bncr',
    asString: (value, fallback = '') =>
      typeof value === 'string' ? value : value == null ? fallback : String(value),
    syncDebugFlag: async () => {},
    logInfo: () => {},
    resolveVerifiedTarget: () => ({
      sessionKey: 'agent:orion:bncr:direct:7467426f743a303a3130303031',
      route: { platform: 'tgBot', groupId: '0', userId: '10001' },
      displayScope: 'Bncr:tgBot:0:10001',
    }),
    rememberSessionRoute: () => {},
    enqueueFromReply: async (args) => {
      calls.push(args);
      outbox.push({
        messageId: `msg-${calls.length}`,
        accountId: args.accountId,
        sessionKey: args.sessionKey,
        route: args.route,
        payload: args.payload,
        createdAt: Date.now(),
        retryCount: 0,
        nextAttemptAt: Date.now(),
      });
    },
    listOutboxEntries: () => outbox,
  });

  return { runtime, calls };
}

test('createBncrChannelSendRuntime preserves supported reply kinds for text and media sends', async () => {
  const { runtime, calls } = createRuntimeHarness();

  await runtime.channelMessageSendText({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    text: 'hi',
    kind: 'tool',
  });
  await runtime.channelMessageSendMedia({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    mediaUrl: '/tmp/a.png',
    kind: 'block',
  });

  assert.equal(calls[0].payload.kind, 'tool');
  assert.equal(calls[1].payload.kind, 'block');
});

test('channel-send passes kind through; normalisation downstream', async () => {
  const { runtime, calls } = createRuntimeHarness();

  await runtime.channelMessageSendText({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    text: 'hi',
    kind: 'unexpected',
    payload: { kind: 'still-bad' },
  });

  // Raw kind passes through (ctx.kind = 'unexpected', no override)
  assert.equal(calls[0].payload.kind, 'unexpected');
});

test('payload kind passes through raw; normalisation downstream', async () => {
  const { runtime, calls } = createRuntimeHarness();

  await runtime.channelMessageSendPayload({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    payload: { text: 'hi', kind: 'final' },
  });
  await runtime.channelMessageSendPayload({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    payload: { text: 'hi', kind: 'invalid' },
  });

  // Kind passes through raw (normalisation happens in orchestrator downstream)
  assert.equal(calls[0].payload.kind, 'final');
  assert.equal(calls[1].payload.kind, 'invalid');
});

test('createBncrChannelSendRuntime preserves mediaUrls and asVoice for media and payload sends', async () => {
  const { runtime, calls } = createRuntimeHarness();

  await runtime.channelSendMedia({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    text: 'voice album',
    mediaUrls: ['/tmp/runtime-voice-1.ogg', '/tmp/runtime-voice-2.ogg'],
    asVoice: true,
  });
  await runtime.channelMessageSendPayload({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    payload: {
      text: 'payload voice album',
      mediaUrls: ['/tmp/runtime-payload-voice-1.ogg', '/tmp/runtime-payload-voice-2.ogg'],
      asVoice: true,
    },
  });

  assert.deepEqual(calls[0].payload.mediaUrls, [
    '/tmp/runtime-voice-1.ogg',
    '/tmp/runtime-voice-2.ogg',
  ]);
  assert.equal(calls[0].payload.asVoice, true);
  assert.deepEqual(calls[1].payload.mediaUrls, [
    '/tmp/runtime-payload-voice-1.ogg',
    '/tmp/runtime-payload-voice-2.ogg',
  ]);
  assert.equal(calls[1].payload.asVoice, true);
});

test('channel send runtime exposes channel.message and direct send runtime together', async () => {
  const { calls } = createRuntimeHarness();
  const runtime = createBncrChannelSendRuntime({
    channelId: 'bncr',
    asString: (value, fallback = '') =>
      typeof value === 'string' ? value : value == null ? fallback : String(value),
    syncDebugFlag: async () => {},
    logInfo: () => {},
    resolveVerifiedTarget: () => ({
      sessionKey: 'agent:orion:bncr:direct:7467426f743a303a3130303031',
      route: { platform: 'tgBot', groupId: '0', userId: '10001' },
      displayScope: 'Bncr:tgBot:0:10001',
    }),
    rememberSessionRoute: () => {},
    enqueueFromReply: async (args) => {
      calls.push(args);
    },
    listOutboxEntries: () => [
      {
        messageId: `msg-${calls.length}`,
        accountId: 'Primary',
        sessionKey: 'agent:orion:bncr:direct:7467426f743a303a3130303031',
        route: { platform: 'tgBot', groupId: '0', userId: '10001' },
        payload: {},
        createdAt: Date.now(),
        retryCount: 0,
        nextAttemptAt: Date.now(),
      },
    ],
  });

  await runtime.channelSendText({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    text: 'hello',
  });

  assert.equal(typeof runtime.channelMessageSendText, 'function');
  assert.equal(calls.length, 1);
});

test('sendDispatch passes raw marker text to bridge; normalisation downstream', async () => {
  const { runtime, calls } = createRuntimeHarness();

  await runtime.channelSendText({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    text: '[BncrParam:{"type":"file","path":"/tmp/doc.pdf"}] send as file',
    extra: { gifPlayback: true },
  });

  // sendDispatch no longer normalises markers — raw text passes through
  assert.ok(calls[0].payload.text.includes('send as file'));
  assert.ok(calls[0].payload.text.includes('[BncrParam'));
  // mediaUrl stays empty (marker path not resolved; happens downstream)
  assert.equal(calls[0].payload.mediaUrl, undefined);
  // Host-level extra (gifPlayback) survives; marker-only fields absent
  assert.equal(calls[0].payload.extra?.gifPlayback, true);
  assert.equal(calls[0].payload.extra?.type, undefined);
  assert.equal(calls[0].payload.extra?.path, undefined);
});

test('sendDispatch passes raw marker-only text; extra unchanged', async () => {
  const { runtime, calls } = createRuntimeHarness();

  await runtime.channelSendText({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    text: '[BncrParam:{"forceDocument":true}]',
  });

  // Raw text passes through (normalisation happens downstream)
  assert.equal(calls[0].payload.text, '[BncrParam:{"forceDocument":true}]');
  // forceDocument is NOT in extra — it was not in ctx.extra (mergeHostFields adds it,
  // but for this test ctx has no extra). Downstream normalisation handles it.
  assert.equal(calls[0].payload.extra, undefined);
});

test('messageSendDispatch passes raw text; extra from ctx', async () => {
  const { runtime, calls } = createRuntimeHarness();

  await runtime.channelMessageSendText({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    text: 'hello [BncrParam:{"silent":true}]',
  });

  // Raw text with marker passes through
  assert.ok(calls[0].payload.text.includes('hello'));
  assert.ok(calls[0].payload.text.includes('BncrParam'));
  // silent not in extra unless mergeHostFields promoted it
  assert.equal(calls[0].payload.extra, undefined);
});

test('messageSendDispatch passes raw asVoice through; marker not resolved at this layer', async () => {
  const { runtime, calls } = createRuntimeHarness();

  await runtime.channelMessageSendMedia({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    text: 'voice [BncrParam:{"asVoice":false}]',
    mediaUrl: '/tmp/clip.ogg',
    asVoice: true,
  });

  // Dispatch layer passes raw asVoice from overrides without resolving markers.
  // Marker resolution happens in normalizeOutboundSend one layer deeper.
  assert.equal(calls[0].payload.asVoice, true);
  assert.equal(calls[0].payload.text, 'voice [BncrParam:{"asVoice":false}]');
});
