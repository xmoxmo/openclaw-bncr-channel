import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from '../helpers/bncr-bridge.mjs';

test('handleAck retryable ack keeps entry queued and reports willRetry', async () => {
  const bridge = createBridge();

  try {
    const entry = makeEntry('msg-ack-retryable', 'retry me');
    entry.nextAttemptAt = Date.now() - 1_000;
    bridge.outbox.set(entry.messageId, entry);

    let respondPayload = null;
    const before = Date.now();

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retryable',
        ok: false,
        error: 'retryable-ack-from-test',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    const updated = bridge.outbox.get('msg-ack-retryable');
    assert.ok(updated);
    assert.equal(updated.lastError, 'retryable-ack-from-test');
    assert.ok(updated.nextAttemptAt >= before + 900);
    assert.deepEqual(respondPayload, { ok: true, payload: { ok: true, willRetry: true } });
    assert.equal(
      bridge.deadLetter.some((item) => item.messageId === 'msg-ack-retryable'),
      false,
    );
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck retryable ack does not resolve the pending message ack waiter', async () => {
  const bridge = createBridge();

  try {
    const entry = makeEntry('msg-ack-retryable-waiter', 'retry keeps waiter pending');
    bridge.outbox.set(entry.messageId, entry);
    const waiter = bridge.waitForMessageAck(entry.messageId, 40);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: entry.messageId,
        ok: false,
        error: 'retryable-ack-waiter-test',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(bridge.messageAckWaiters.size, 1);
    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has(entry.messageId), true);
    assert.equal(
      bridge.deadLetter.some((item) => item.messageId === entry.messageId),
      false,
    );
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck fatal ack moves entry to deadLetter and reports movedToDeadLetter', async () => {
  const bridge = createBridge();

  try {
    const entry = makeEntry('msg-ack-fatal', 'fatal me');
    bridge.outbox.set(entry.messageId, entry);

    let respondPayload = null;

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-fatal',
        ok: false,
        fatal: true,
        error: 'fatal-ack-from-test',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(bridge.outbox.has('msg-ack-fatal'), false);
    assert.equal(
      bridge.deadLetter.some((item) => item.messageId === 'msg-ack-fatal'),
      true,
    );
    assert.deepEqual(respondPayload, { ok: true, payload: { ok: true, movedToDeadLetter: true } });
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleAck fatal ack resolves pending message ack waiter as timeout', async () => {
  const bridge = createBridge();

  try {
    const entry = makeEntry('msg-ack-fatal-waiter', 'fatal resolves waiter timeout');
    bridge.outbox.set(entry.messageId, entry);
    const waiter = bridge.waitForMessageAck(entry.messageId, 1_000);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: entry.messageId,
        ok: false,
        fatal: true,
        error: 'fatal-ack-waiter-test',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has(entry.messageId), false);
    assert.equal(
      bridge.deadLetter.some((item) => item.messageId === entry.messageId),
      true,
    );
    assert.equal(bridge.resolveMessageAck(entry.messageId, 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('moveToDeadLetter resolves pending message ack waiter as timeout', async () => {
  const bridge = createBridge();

  try {
    const entry = makeEntry('msg-deadletter-waiter', 'deadletter resolves waiter timeout');
    bridge.outbox.set(entry.messageId, entry);
    const waiter = bridge.waitForMessageAck(entry.messageId, 1_000);

    bridge.moveToDeadLetter(entry, 'direct-deadletter-waiter-test');

    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has(entry.messageId), false);
    assert.equal(
      bridge.deadLetter.some((item) => item.messageId === entry.messageId),
      true,
    );
    assert.equal(bridge.resolveMessageAck(entry.messageId, 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('collectDue retry-limit dead-letter resolves pending message ack waiter as timeout', async () => {
  const bridge = createBridge();

  try {
    const entry = makeEntry('msg-collectdue-waiter', 'collectDue resolves waiter timeout');
    entry.retryCount = 99;
    entry.nextAttemptAt = Date.now() - 1_000;
    entry.lastError = 'retry-limit-test';
    bridge.outbox.set(entry.messageId, entry);
    const waiter = bridge.waitForMessageAck(entry.messageId, 1_000);

    const payloads = bridge.collectDue('Primary', 10);

    assert.deepEqual(payloads, []);
    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has(entry.messageId), false);
    assert.equal(
      bridge.deadLetter.some((item) => item.messageId === entry.messageId),
      true,
    );
    assert.equal(bridge.resolveMessageAck(entry.messageId, 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});
