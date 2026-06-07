import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from './helpers/bncr-bridge.mjs';

test('deadLetter memory keeps only the newest bounded entries', async () => {
  const bridge = createBridge();

  try {
    bridge.stopped = true;
    for (let i = 0; i < 1005; i += 1) {
      bridge.moveToDeadLetter(makeEntry(`dead-${i}`, `dead ${i}`), 'test-dead-letter-cap');
    }

    assert.equal(bridge.deadLetter.length, 1000);
    assert.equal(
      bridge.deadLetter.some((entry) => entry.messageId === 'dead-0'),
      false,
    );
    assert.equal(bridge.deadLetter[0].messageId, 'dead-5');
    assert.equal(bridge.deadLetter.at(-1).messageId, 'dead-1004');
  } finally {
    cleanupBridge(bridge);
  }
});

test('late ok ack after fatal ack does not recreate outbox state or duplicate deadLetter entry', async () => {
  const bridge = createBridge();

  try {
    const entry = makeEntry('msg-ack-fatal-late', 'fatal then late ok');
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-fatal-late',
        ok: false,
        fatal: true,
        error: 'fatal-before-late-ok',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    const deadLetterCountBefore = bridge.deadLetter.filter(
      (item) => item.messageId === 'msg-ack-fatal-late',
    ).length;

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-fatal-late',
        ok: true,
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    const deadLetterCountAfter = bridge.deadLetter.filter(
      (item) => item.messageId === 'msg-ack-fatal-late',
    ).length;
    assert.equal(bridge.outbox.has('msg-ack-fatal-late'), false);
    assert.equal(deadLetterCountBefore, 1);
    assert.equal(deadLetterCountAfter, 1);
  } finally {
    cleanupBridge(bridge);
  }
});

test('late ok ack after shutdown does not recreate waiter or outbox state', async () => {
  const bridge = createBridge();

  try {
    const waiter = bridge.waitForMessageAck('msg-ack-shutdown-late', 1_000);
    const entry = makeEntry('msg-ack-shutdown-late', 'shutdown then late ok');
    bridge.outbox.set(entry.messageId, entry);

    bridge.shutdown();

    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-shutdown-late',
        ok: true,
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has('msg-ack-shutdown-late'), true);
    assert.equal(bridge.resolveMessageAck('msg-ack-shutdown-late', 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});
