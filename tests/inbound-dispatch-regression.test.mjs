import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridge } from '../src/channel.ts';
import { dispatchBncrInbound } from '../src/messaging/inbound/dispatch.ts';
import { parseBncrInboundParams } from '../src/messaging/inbound/parse.ts';

function createInboundApiStub() {
  const currentConfig = {};
  const calls = {
    finalized: [],
    recorded: [],
    delivered: [],
  };

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
            return '/tmp/bncr-test-store';
          },
          readSessionUpdatedAt() {
            return 0;
          },
          async recordInboundSession(args) {
            calls.recorded.push(args);
          },
        },
        media: {
          async saveMediaBuffer(_buffer, _mimeType, _direction, _maxBytes, _fileName) {
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
          finalizeInboundContext(ctx) {
            calls.finalized.push(ctx);
            return ctx;
          },
          async dispatchReplyWithBufferedBlockDispatcher({ dispatcherOptions }) {
            await dispatcherOptions.deliver({ text: 'reply from agent' }, { kind: 'final' });
            calls.delivered.push({ text: 'reply from agent', kind: 'final' });
          },
        },
      },
    },
  };

  return { api, calls };
}

function cleanupBridge(bridge) {
  if (bridge.saveTimer) clearTimeout(bridge.saveTimer);
  if (bridge.pushTimer) clearTimeout(bridge.pushTimer);
  for (const waiter of bridge.messageAckWaiters?.values?.() || []) {
    clearTimeout(waiter.timer);
  }
  bridge.messageAckWaiters?.clear?.();
}

test('dispatchBncrInbound carries parsed mimeType and peer kind into finalized inbound context', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '6278285192',
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
  assert.equal(calls.finalized.length, 1);
  assert.equal(calls.recorded.length, 1);
  assert.equal(calls.finalized[0].MediaType, 'text/plain');
  assert.equal(calls.finalized[0].ChatType, 'direct');
  assert.equal(calls.finalized[0].SenderId, 'client-1');
  assert.equal(calls.finalized[0].MessageSid, 'inbound-1');
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'reply from agent');
  assert.equal(enqueueCalls[0].payload.kind, 'final');
});

test('handleInbound async dispatch path reaches finalized inbound context instead of stopping at pre-dispatch flush', async () => {
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
        userId: '6278285192',
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
    assert.equal(calls.finalized.length, 1);
    assert.equal(calls.recorded.length, 1);
    assert.equal(calls.finalized[0].MediaType, 'text/plain');
    assert.equal(calls.finalized[0].ChatType, 'direct');
  } finally {
    cleanupBridge(bridge);
  }
});
