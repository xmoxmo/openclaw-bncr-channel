import assert from 'node:assert/strict';
import test from 'node:test';
import { createBncrChannelSendRuntime } from '../../src/plugin/channel-send.ts';
import { createBncrChannelSendRuntimeGroup } from '../../src/plugin/channel-send-runtime-group.ts';

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

test('createBncrChannelSendRuntime drops unsupported reply kind values', async () => {
  const { runtime, calls } = createRuntimeHarness();

  await runtime.channelMessageSendText({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    text: 'hi',
    kind: 'unexpected',
    payload: { kind: 'still-bad' },
  });

  assert.equal(calls[0].payload.kind, undefined);
});

test('createBncrChannelSendRuntime normalizes payload kind before enqueue', async () => {
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

  assert.equal(calls[0].payload.kind, 'final');
  assert.equal(calls[1].payload.kind, undefined);
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

test('channel send runtime group exposes channel.message and direct send runtime together', async () => {
  const { calls } = createRuntimeHarness();
  const group = createBncrChannelSendRuntimeGroup({
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

  await group.channelSendRuntime.channelSendText({
    accountId: 'Primary',
    to: 'Bncr:tgBot:0:10001',
    text: 'hello',
  });

  assert.equal(typeof group.channelSendRuntime.channelMessageSendText, 'function');
  assert.equal(calls.length, 1);
});
