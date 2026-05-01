import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridge } from '../src/channel.ts';

function createApiStub() {
  const currentConfig = {};
  return {
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
      },
    },
  };
}

function makeEntry(messageId, text = messageId) {
  return {
    messageId,
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route: { platform: 'tgBot', groupId: '-1001', userId: '6278285192' },
    payload: {
      type: 'message.outbound',
      messageId,
      idempotencyKey: messageId,
      sessionKey: 'agent:orion:bncr:direct:demo',
      message: {
        platform: 'tgBot',
        groupId: '-1001',
        userId: '6278285192',
        type: 'text',
        msg: text,
        path: '',
        base64: '',
        fileName: '',
      },
      ts: Date.now(),
    },
    createdAt: Date.now(),
    retryCount: 0,
    nextAttemptAt: Date.now(),
  };
}

function cleanupBridge(bridge) {
  if (bridge.saveTimer) clearTimeout(bridge.saveTimer);
  if (bridge.pushTimer) clearTimeout(bridge.pushTimer);

  for (const waiter of bridge.messageAckWaiters?.values?.() || []) {
    clearTimeout(waiter.timer);
  }
  bridge.messageAckWaiters?.clear?.();
}

function spyFlushPushQueue(bridge) {
  const calls = [];
  const original = bridge.flushPushQueue.bind(bridge);
  bridge.flushPushQueue = (accountId) => {
    calls.push(accountId);
    return Promise.resolve();
  };
  return {
    calls,
    restore() {
      bridge.flushPushQueue = original;
    },
  };
}

test('enqueueOutbound does not wake another message ack waiter on the same account', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const waiter = bridge.waitForMessageAck('msg-1', 40);
    bridge.enqueueOutbound(makeEntry('msg-2', 'second message'));

    const result = await waiter;
    assert.equal(result, 'timeout');
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck resolves only the matching message ack waiter', async () => {
  const bridge = createBncrBridge(createApiStub());

  try {
    const entry1 = makeEntry('msg-1', 'first');
    const entry2 = makeEntry('msg-2', 'second');
    bridge.outbox.set(entry1.messageId, entry1);
    bridge.outbox.set(entry2.messageId, entry2);

    const waiter1 = bridge.waitForMessageAck('msg-1', 200);
    const waiter2 = bridge.waitForMessageAck('msg-2', 40);

    let respondPayload = null;
    await bridge.handleAck({
      params: { accountId: 'Primary', messageId: 'msg-1', ok: true },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(respondPayload, { ok: true, payload: { ok: true } });
    assert.equal(await waiter1, 'acked');
    assert.equal(await waiter2, 'timeout');
    assert.equal(bridge.outbox.has('msg-1'), false);
    assert.equal(bridge.outbox.has('msg-2'), true);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck success flushes queued outbound for the same account', async () => {
  const bridge = createBncrBridge(createApiStub());
  const spy = spyFlushPushQueue(bridge);

  try {
    const entry = makeEntry('msg-ack-flush', 'ack flush');
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: { accountId: 'Primary', messageId: 'msg-ack-flush', ok: true },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(spy.calls, ['Primary']);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});

test('handleActivity flushes queued outbound for the same account', async () => {
  const bridge = createBncrBridge(createApiStub());
  const spy = spyFlushPushQueue(bridge);

  try {
    await bridge.handleActivity({
      params: { accountId: 'Primary', clientId: 'client-1' },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(spy.calls, ['Primary']);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});

test('handleInbound flushes queued outbound for the same account before async dispatch', async () => {
  const bridge = createBncrBridge(createApiStub());
  const spy = spyFlushPushQueue(bridge);

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
        msgId: 'inbound-1',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(spy.calls, ['Primary']);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});
