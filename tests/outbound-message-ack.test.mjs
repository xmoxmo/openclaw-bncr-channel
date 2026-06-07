import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from './helpers/bncr-bridge.mjs';
import { withConsoleCapture } from './helpers/console-capture.mjs';

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

test('waitForMessageAck removes waiter after timeout without leaking state', async () => {
  const bridge = createBridge();

  try {
    assert.equal(bridge.messageAckWaiters.size, 0);

    const waiter = bridge.waitForMessageAck('msg-timeout-cleanup', 40);
    assert.equal(bridge.messageAckWaiters.size, 1);

    const result = await waiter;
    assert.equal(result, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.resolveMessageAck('msg-timeout-cleanup', 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('waitForMessageAck treats invalid timeout inputs as immediate timeout without waiter leak', async () => {
  const bridge = createBridge();

  try {
    assert.equal(await bridge.waitForMessageAck('msg-invalid-nan-timeout', Number.NaN), 'timeout');
    assert.equal(
      await bridge.waitForMessageAck('msg-invalid-infinity-timeout', Number.POSITIVE_INFINITY),
      'timeout',
    );
    assert.equal(await bridge.waitForMessageAck('msg-invalid-negative-timeout', -1), 'timeout');
    assert.equal(await bridge.waitForMessageAck('', 1_000), 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('waitForMessageAck reuses existing waiter for the same message id', async () => {
  const bridge = createBridge();

  try {
    const waiter1 = bridge.waitForMessageAck('msg-shared-waiter', 200);
    const waiter2 = bridge.waitForMessageAck('msg-shared-waiter', 200);

    assert.equal(bridge.messageAckWaiters.size, 1);
    assert.equal(bridge.resolveMessageAck('msg-shared-waiter', 'acked'), true);
    assert.equal(await waiter1, 'acked');
    assert.equal(await waiter2, 'acked');
    assert.equal(bridge.messageAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('late ack after timeout does not resolve twice or recreate waiter state', async () => {
  const bridge = createBridge();

  try {
    const waiter = bridge.waitForMessageAck('msg-late-ack', 40);
    const result = await waiter;

    assert.equal(result, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.resolveMessageAck('msg-late-ack', 'acked'), false);
    assert.equal(bridge.messageAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('shutdown settles message ack waiters and clears waiter state', async () => {
  const bridge = createBridge();
  const logs = [];
  bridge.logInfo = (scope, message, options) => {
    logs.push({ scope, message, options });
  };

  try {
    const waiter1 = bridge.waitForMessageAck('msg-shutdown-1', 200);
    const waiter2 = bridge.waitForMessageAck('msg-shutdown-2', 200);
    bridge.earlyFileAcks.set('transfer-shutdown|complete|-', {
      payload: { ok: true },
      ok: true,
      at: Date.now(),
    });

    assert.equal(bridge.messageAckWaiters.size, 2);
    bridge.shutdown();

    assert.equal(await waiter1, 'timeout');
    assert.equal(await waiter2, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.resolveMessageAck('msg-shutdown-1', 'acked'), false);
    assert.equal(bridge.resolveMessageAck('msg-shutdown-2', 'acked'), false);

    const cleanupLog = logs.find(
      (item) => item.scope === 'lifecycle' && item.message.startsWith('cleanup '),
    );
    assert.ok(cleanupLog);
    const summary = JSON.parse(cleanupLog.message.slice('cleanup '.length));
    assert.equal(summary.reason, 'shutdown');
    assert.equal(summary.messageAckWaiters, 2);
    assert.equal(summary.earlyFileAcks, 1);
    assert.equal(summary.outbox, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('stopService settles message ack waiters and clears timers like shutdown', async () => {
  const bridge = createBridge();

  try {
    const waiter = bridge.waitForMessageAck('msg-stop-service', 1_000);
    bridge.saveTimer = setTimeout(() => {}, 1_000);
    bridge.pushTimer = setTimeout(() => {}, 1_000);
    bridge.earlyFileAcks.set('transfer-stop|complete|-', {
      payload: { ok: true },
      ok: true,
      at: Date.now(),
    });

    assert.equal(bridge.messageAckWaiters.size, 1);
    assert.ok(bridge.saveTimer);
    assert.ok(bridge.pushTimer);
    assert.equal(bridge.earlyFileAcks.size, 1);

    await bridge.stopService();

    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.saveTimer, null);
    assert.equal(bridge.pushTimer, null);
    assert.equal(bridge.earlyFileAcks.size, 0);
    assert.equal(bridge.resolveMessageAck('msg-stop-service', 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue emits ack wait-start before blocking on message ack waiter', async () => {
  const bridge = createBridge();

  try {
    await withConsoleCapture('log', async ({ log: logs }) => {
      bridge.isDebugEnabled = () => true;
      const entry = makeEntry('msg-ack-wait-start', 'ack wait start');
      entry.nextAttemptAt = Date.now() - 1_000;
      bridge.outbox.set(entry.messageId, entry);

      bridge.tryPushEntry = async (pushedEntry) => {
        pushedEntry.lastPushConnId = 'conn-wait-start';
        pushedEntry.lastPushClientId = 'client-wait-start';
        return true;
      };
      bridge.sleepMs = async () => {};
      bridge.isOnline = () => true;
      bridge.isOutboundAckRequired = () => true;
      bridge.resolveMessageAckTimeoutMs = () => 5;

      await bridge.flushPushQueue({
        accountId: 'Primary',
        trigger: 'test',
        reason: 'ack-wait-start',
      });

      const waitStart = logs.find(
        (line) =>
          line.includes('[bncr] outbox ack wait-start') &&
          line.includes('msg-ack-wait-start') &&
          line.includes('conn-wait-start'),
      );
      assert.ok(waitStart, 'push success should emit debug ack wait-start before waiter resolves');
    });
  } finally {
    cleanupBridge(bridge);
  }
});

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
