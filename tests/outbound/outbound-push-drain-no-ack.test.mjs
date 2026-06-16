import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from '../helpers/bncr-bridge.mjs';

test('flushPushQueue does not degrade or reroute when pushed entry leaves outbox before ack handling', async () => {
  const bridge = createBridge();
  const scheduled = [];
  let degraded = false;
  let waited = false;

  try {
    const entry = makeEntry('msg-removed-after-push', 'removed after push');
    entry.lastPushConnId = 'conn-a';
    entry.lastPushClientId = 'client-a';
    bridge.outbox.set(entry.messageId, entry);

    bridge.tryPushEntry = async (pushedEntry) => {
      assert.equal(pushedEntry.messageId, entry.messageId);
      bridge.outbox.delete(pushedEntry.messageId);
      return true;
    };
    bridge.waitForMessageAck = async () => {
      waited = true;
      return 'timeout';
    };
    bridge.degradeOutboundCapability = () => {
      degraded = true;
    };
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };
    bridge.sleepMs = async () => {};
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => true;

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'removed-after-push',
    });

    assert.equal(waited, true);
    assert.equal(degraded, false);
    assert.equal(bridge.outbox.has(entry.messageId), false);
    assert.deepEqual(scheduled, []);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue does not wait for ack or degrade when no-ack pushed entry leaves outbox', async () => {
  const bridge = createBridge();
  let waited = false;
  let degraded = false;

  try {
    const entry = makeEntry('msg-no-ack-removed-after-push', 'no ack removed after push');
    entry.lastPushConnId = 'conn-no-ack';
    entry.lastPushClientId = 'client-no-ack';
    bridge.outbox.set(entry.messageId, entry);

    bridge.tryPushEntry = async (pushedEntry) => {
      assert.equal(pushedEntry.messageId, entry.messageId);
      bridge.outbox.delete(pushedEntry.messageId);
      return true;
    };
    bridge.waitForMessageAck = async () => {
      waited = true;
      return 'timeout';
    };
    bridge.degradeOutboundCapability = () => {
      degraded = true;
    };
    bridge.sleepMs = async () => {};
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => false;

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'no-ack-removed-after-push',
    });

    assert.equal(waited, false);
    assert.equal(degraded, false);
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(bridge.outbox.has(entry.messageId), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue marks no-ack offline pushes as unconfirmed retry without waiting for ack', async () => {
  const bridge = createBridge();
  const scheduled = [];
  let waited = false;
  let degraded = null;
  let saveCount = 0;
  const before = Date.now();

  try {
    const entry = makeEntry('msg-no-ack-offline-unconfirmed', 'no ack offline unconfirmed');
    entry.lastPushConnId = 'conn-no-ack-offline';
    entry.lastPushClientId = 'client-no-ack-offline';
    entry.nextAttemptAt = before - 1_000;
    bridge.outbox.set(entry.messageId, entry);

    bridge.tryPushEntry = async (pushedEntry) => {
      assert.equal(pushedEntry.messageId, entry.messageId);
      return true;
    };
    bridge.waitForMessageAck = async () => {
      waited = true;
      return 'timeout';
    };
    bridge.degradeOutboundCapability = (args) => {
      degraded = args;
    };
    bridge.sleepMs = async () => {};
    bridge.isOnline = () => false;
    bridge.isOutboundAckRequired = () => false;
    bridge.scheduleSave = () => {
      saveCount += 1;
    };
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };

    await bridge.flushPushQueue({
      accountId: 'Primary',
      trigger: 'test',
      reason: 'no-ack-offline-unconfirmed',
    });

    const updated = bridge.outbox.get(entry.messageId);
    assert.ok(updated, 'offline no-ack push should remain queued for retry');
    assert.equal(waited, false);
    assert.equal(bridge.messageAckWaiters.size, 0);
    assert.equal(degraded?.reason, 'push-unconfirmed');
    assert.equal(degraded?.connId, 'conn-no-ack-offline');
    assert.equal(degraded?.clientId, 'client-no-ack-offline');
    assert.equal(updated.retryCount, 1);
    assert.equal(updated.lastError, 'push-delivery-unconfirmed');
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
