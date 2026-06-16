import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from '../helpers/bncr-bridge.mjs';
import { withConsoleCapture } from '../helpers/console-capture.mjs';

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
