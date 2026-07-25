import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from '../helpers/bncr-bridge.mjs';
import { withConsoleCapture } from '../helpers/console-capture.mjs';

test('flushPushQueueBestEffort logs and reschedules drain exceptions with a retry limit', async () => {
  const bridge = createBridge();
  const scheduled = [];

  try {
    await withConsoleCapture('error', async ({ error: errors }) => {
      bridge.flushPushQueue = async () => {
        throw new Error('synthetic drain explosion');
      };
      bridge.schedulePushDrain = (delayMs = 0) => {
        scheduled.push(delayMs);
      };

      for (let i = 0; i < 4; i += 1) {
        bridge.flushPushQueueBestEffort({
          accountId: 'Primary',
          trigger: 'test',
          reason: 'drain-exception',
        });
        await new Promise((resolve) => setImmediate(resolve));
      }

      assert.equal(errors.length, 4);
      assert.ok(errors[0].includes('[bncr] outbox drain fail'));
      assert.ok(errors[0].includes('accountId=Primary'));
      assert.ok(errors[0].includes('reason=drain-exception'));
      assert.ok(errors[0].includes('synthetic drain explosion'));
      assert.ok(errors[0].includes('retry=1'));
      assert.ok(errors[1].includes('retry=2'));
      assert.ok(errors[2].includes('retry=3'));
      assert.ok(errors[3].includes('retry=false'));
      assert.deepEqual(scheduled, [1_000, 1_000, 1_000]);

      bridge.flushPushQueue = async () => {};
      bridge.flushPushQueueBestEffort({
        accountId: 'Primary',
        trigger: 'test',
        reason: 'recovered',
      });
      await new Promise((resolve) => setImmediate(resolve));

      bridge.flushPushQueue = async () => {
        throw new Error('synthetic drain explosion after recovery');
      };
      bridge.flushPushQueueBestEffort({
        accountId: 'Primary',
        trigger: 'test',
        reason: 'drain-exception-after-recovery',
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.ok(errors[4].includes('retry=1'));
      assert.equal(scheduled.length, 4);
    });
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue logs non-debug push skip summary when text push guard rejects', async () => {
  const bridge = createBridge();
  const scheduled = [];
  let saveCount = 0;
  const before = Date.now();

  try {
    await withConsoleCapture('log', async ({ log: logs }) => {
      const entry = makeEntry(
        'msg-push-skip-no-active-connection',
        'push skip no active connection',
      );
      entry.nextAttemptAt = before - 1_000;
      bridge.outbox.set(entry.messageId, entry);

      bridge.gatewayContext = null;
      bridge.sleepMs = async () => {};
      bridge.scheduleSave = () => {
        saveCount += 1;
      };
      bridge.schedulePushDrain = (delayMs = 0) => {
        scheduled.push(delayMs);
      };

      await bridge.flushPushQueue({
        accountId: 'Primary',
        trigger: 'test',
        reason: 'push-skip-summary',
      });

      const skipSummary = logs.find(
        (line) =>
          line.includes('[bncr] outbox push skip') &&
          line.includes(`mid=${entry.messageId}`) &&
          line.includes('reason=no-gateway-context'),
      );
      assert.ok(skipSummary, 'push guard skip should emit non-debug summary log');

      const updated = bridge.outbox.get(entry.messageId);
      assert.ok(updated, 'entry should remain queued for retry after push skip');
      assert.equal(updated.retryCount, 1);
      assert.equal(updated.lastError, 'gateway context unavailable');
      assert.ok(saveCount >= 1, 'guard reason should be persisted');
      assert.deepEqual(scheduled, [1_000]);
    });
  } finally {
    cleanupBridge(bridge);
  }
});

test('pre-push guard skip consumes retry budget but does not prematurely dead-letter', async () => {
  const bridge = createBridge();
  const scheduled = [];
  const before = Date.now();

  try {
    const entry = makeEntry('msg-push-skip-retry-budget', 'push skip retry budget');
    entry.retryCount = 0;
    entry.nextAttemptAt = before - 1_000;
    bridge.outbox.set(entry.messageId, entry);

    bridge.gatewayContext = null;
    bridge.sleepMs = async () => {};
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'pre-push-guard-retry-budget',
    });

    const updated = bridge.outbox.get(entry.messageId);
    assert.ok(updated, 'pre-push guard should keep entry queued until budget exhausted');
    assert.equal(updated.retryCount, 1);
    assert.equal(updated.lastError, 'gateway context unavailable');
    assert.equal(bridge.deadLetter.length, 0);
    assert.deepEqual(scheduled, [1_000]);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue converts tryPushEntry exceptions into retryable push failure', async () => {
  const bridge = createBridge();
  const scheduled = [];
  let saveCount = 0;
  const before = Date.now();

  try {
    await withConsoleCapture('log', async ({ log: logs }) => {
      const entry = makeEntry('msg-pre-push-exception', 'pre push exception');
      entry.nextAttemptAt = before - 1_000;
      bridge.outbox.set(entry.messageId, entry);

      bridge.tryPushEntry = async () => {
        throw new Error('synthetic pre-push explosion');
      };
      bridge.sleepMs = async () => {};
      bridge.scheduleSave = () => {
        saveCount += 1;
      };
      bridge.schedulePushDrain = (delayMs = 0) => {
        scheduled.push(delayMs);
      };

      await bridge.flushPushQueue({
        accountId: 'Primary',
        trigger: 'test',
        reason: 'pre-push-exception',
      });

      const failureSummary = logs.find(
        (line) =>
          line.includes('[bncr] outbox push fail') &&
          line.includes(`mid=${entry.messageId}`) &&
          line.includes('synthetic pre-push explosion'),
      );
      assert.ok(failureSummary, 'pre-push exception should emit non-debug push failure summary');

      const updated = bridge.outbox.get(entry.messageId);
      assert.ok(updated, 'entry should remain queued for retry after pre-push exception');
      assert.equal(updated.retryCount, 1);
      assert.equal(updated.lastError, 'synthetic pre-push explosion');
      assert.ok(updated.nextAttemptAt >= updated.lastAttemptAt);
      assert.equal(saveCount, 1);
      assert.equal(scheduled.length, 1);
    });
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue schedules retry after push failure without dead-lettering', async () => {
  const bridge = createBridge();
  const scheduled = [];
  let saveCount = 0;
  const before = Date.now();

  try {
    const entry = makeEntry('msg-push-failure-retry', 'push failure retry');
    entry.nextAttemptAt = before - 1_000;
    bridge.outbox.set(entry.messageId, entry);

    bridge.tryPushEntry = async () => false;
    bridge.sleepMs = async () => {};
    bridge.scheduleSave = () => {
      saveCount += 1;
    };
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'push-failure-retry',
    });

    const updated = bridge.outbox.get(entry.messageId);
    assert.ok(updated, 'entry should remain queued for retry');
    assert.equal(updated.retryCount, 1);
    assert.equal(updated.lastError, 'push-retry');
    assert.ok(updated.lastAttemptAt >= before);
    assert.ok(updated.nextAttemptAt >= updated.lastAttemptAt);
    assert.equal(saveCount, 1);
    assert.equal(bridge.deadLetter.length, 0);
    assert.equal(scheduled.length, 1);
    assert.ok(scheduled[0] >= 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue moves push failure retry-limit entries to deadLetter without retry scheduling', async () => {
  const bridge = createBridge();
  const scheduled = [];
  let saveCount = 0;
  const before = Date.now();

  try {
    const entry = makeEntry('msg-push-failure-retry-limit', 'push failure retry limit');
    entry.retryCount = 10;
    entry.nextAttemptAt = before - 1_000;
    entry.lastError = 'push-terminal-seed';
    bridge.outbox.set(entry.messageId, entry);
    const waiter = bridge.waitForMessageAck(entry.messageId, 1_000);

    bridge.tryPushEntry = async () => false;
    bridge.sleepMs = async () => {};
    bridge.scheduleSave = () => {
      saveCount += 1;
    };
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'push-failure-retry-limit',
    });

    assert.equal(await waiter, 'timeout');
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has(entry.messageId), false);
    assert.equal(bridge.deadLetter.length, 1);
    assert.equal(bridge.deadLetter[0].messageId, entry.messageId);
    assert.equal(bridge.deadLetter[0].lastError, 'push-terminal-seed');
    assert.equal(saveCount, 1);
    assert.deepEqual(scheduled, []);
    assert.equal(bridge.resolveMessageAck(entry.messageId, 'acked'), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('push failure matrix separates guard deferral retry retry-limit and dead-letter outcomes', async () => {
  const bridge = createBridge();
  const scheduled = [];

  try {
    bridge.sleepMs = async () => {};
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: Date.now() - 1_000,
      lastSeenAt: Date.now(),
      outboundReadyUntil: Date.now() + 60_000,
      preferredForOutboundUntil: Date.now() + 60_000,
      inboundOnly: false,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');

    const guard = makeEntry('matrix-guard', 'guard');
    bridge.outbox.set(guard.messageId, guard);
    bridge.gatewayContext = null;
    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'guard' });
    assert.equal(bridge.outbox.get('matrix-guard')?.retryCount, 1);
    bridge.outbox.clear();

    const retry = makeEntry('matrix-retry', 'retry');
    bridge.outbox.set(retry.messageId, retry);
    bridge.tryPushEntry = async () => {
      throw new Error('matrix retry failure');
    };
    bridge.gatewayContext = { broadcastToConnIds() {} };
    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'retry' });
    assert.equal(bridge.outbox.get('matrix-retry')?.retryCount, 1);
    bridge.outbox.clear();

    const terminal = makeEntry('matrix-terminal', 'terminal');
    terminal.retryCount = 99;
    terminal.lastError = 'push-terminal-seed';
    bridge.outbox.set(terminal.messageId, terminal);
    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'terminal' });
    assert.equal(bridge.outbox.has('matrix-terminal'), false);
    assert.ok(bridge.deadLetter.some((entry) => entry.messageId === 'matrix-terminal'));
    assert.ok(scheduled.length >= 1);
  } finally {
    cleanupBridge(bridge);
  }
});
