import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from '../helpers/bncr-bridge.mjs';

function spyFlushPushQueue(bridge) {
  const calls = [];
  const original = bridge.flushPushQueue.bind(bridge);
  bridge.flushPushQueue = (args) => {
    calls.push(args);
    return Promise.resolve();
  };
  return {
    calls,
    restore() {
      bridge.flushPushQueue = original;
    },
  };
}

test('resolveMessageAck clears only the targeted waiter and leaves others pending', async () => {
  const bridge = createBridge();

  try {
    const waiter1 = bridge.waitForMessageAck('msg-target', 200);
    const waiter2 = bridge.waitForMessageAck('msg-other', 40);

    assert.equal(bridge.messageAckWaiters.size, 2);
    assert.equal(bridge.resolveMessageAck('msg-target', 'acked'), true);
    assert.equal(bridge.messageAckWaiters.size, 1);

    assert.equal(await waiter1, 'acked');
    assert.equal(await waiter2, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('enqueueOutbound does not wake another message ack waiter on the same account', async () => {
  const bridge = createBridge();

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
  const bridge = createBridge();

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
  const bridge = createBridge();
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

    assert.deepEqual(spy.calls, [
      { accountId: 'Primary', trigger: 'ack-ok', reason: 'message-acked' },
    ]);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});
