import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from '../helpers/bncr-bridge.mjs';

test('flushPushQueue yields after per-account time budget instead of monopolizing the drain', async () => {
  const bridge = createBridge();
  const originalNow = Date.now;
  let fakeNow = originalNow() + 3_000_000;
  Date.now = () => fakeNow;
  const pushed = [];
  const scheduled = [];

  try {
    for (let i = 1; i <= 3; i++) {
      const entry = makeEntry(`msg-time-budget-${i}`, `time budget ${i}`);
      entry.createdAt = fakeNow + i;
      entry.nextAttemptAt = fakeNow - 1_000;
      bridge.outbox.set(entry.messageId, entry);
    }

    bridge.tryPushEntry = async (entry) => {
      pushed.push(entry.messageId);
      bridge.outbox.delete(entry.messageId);
      fakeNow += 2_500;
      return true;
    };
    bridge.sleepMs = async () => {};
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => false;

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'time-budget-yield',
    });

    assert.deepEqual(pushed, ['msg-time-budget-1']);
    assert.equal(bridge.outbox.size, 2);
    assert.equal(bridge.outbox.has('msg-time-budget-2'), true);
    assert.equal(bridge.outbox.has('msg-time-budget-3'), true);
    assert.deepEqual(scheduled, [0]);
  } finally {
    Date.now = originalNow;
    cleanupBridge(bridge);
  }
});
