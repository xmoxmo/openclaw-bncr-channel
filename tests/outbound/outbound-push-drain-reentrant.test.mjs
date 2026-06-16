import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from '../helpers/bncr-bridge.mjs';
import { withConsoleCapture } from '../helpers/console-capture.mjs';

test('flushPushQueue skips reentrant drain for the same account', async () => {
  const bridge = createBridge();
  const pushed = [];
  let nestedReturned = false;

  try {
    await withConsoleCapture(['log', 'warn'], async ({ log: logs, warn: warnings }) => {
      bridge.isDebugEnabled = () => true;
      const entry = makeEntry('msg-reentrant-same-account', 'same account reentry');
      entry.nextAttemptAt = Date.now() - 1_000;
      bridge.outbox.set(entry.messageId, entry);

      bridge.tryPushEntry = async (pushedEntry) => {
        pushed.push(pushedEntry.messageId);
        await bridge.flushPushQueue({
          accountId: 'Primary',
          trigger: 'test',
          reason: 'nested-same-account',
        });
        nestedReturned = true;
        bridge.outbox.delete(pushedEntry.messageId);
        return true;
      };
      bridge.sleepMs = async () => {};
      bridge.isOutboundAckRequired = () => false;

      await bridge.flushPushQueue({
        accountId: 'Primary',
        trigger: 'test',
        reason: 'outer-same-account',
      });

      assert.equal(nestedReturned, true);
      assert.deepEqual(pushed, ['msg-reentrant-same-account']);
      assert.equal(bridge.outbox.has(entry.messageId), false);
      assert.equal(bridge.pushDrainRunningAccounts.has('Primary'), false);
      assert.equal(
        warnings.some((line) => line.includes('[bncr] outbox drain stuck')),
        false,
      );
      const drainSkip = logs.find(
        (line) =>
          line.includes('[bncr] outbox drain-skip') &&
          line.includes('already-running') &&
          !line.includes('msg-reentrant-same-account'),
      );
      assert.ok(drainSkip, 'reentrant drain skip should be observable in debug logs');
    });
  } finally {
    cleanupBridge(bridge);
  }
});

test('flushPushQueue emits non-debug drain stuck summary after long-running account drain', async () => {
  const bridge = createBridge();

  try {
    await withConsoleCapture(['log', 'warn'], async ({ log: logs, warn: warnings }) => {
      bridge.isDebugEnabled = () => true;
      const entry = makeEntry('msg-drain-stuck', 'drain stuck');
      bridge.outbox.set(entry.messageId, entry);
      bridge.pushDrainRunningAccounts.add('Primary');
      bridge.pushDrainRunningSinceByAccount.set('Primary', Date.now() - 31_000);

      await bridge.flushPushQueue({
        accountId: 'Primary',
        trigger: 'test',
        reason: 'nested-stuck-check',
      });

      const summary = warnings.find((line) => line.includes('[bncr] outbox drain stuck'));
      assert.ok(summary, 'drain stuck summary should be non-debug visible');
      assert.ok(summary.includes('accountId=Primary'));
      assert.ok(summary.includes('pending=1'));
      assert.ok(summary.includes('runningMs='));
      assert.ok(summary.includes('waiters=0/0'));

      const detail = logs.find((line) => line.includes('[bncr] outbox drain-stuck'));
      assert.ok(detail, 'drain stuck detail should be emitted through debug logs');
      assert.ok(detail.includes('msg-drain-stuck'));
      assert.ok(detail.includes('hasGatewayContext'));
    });
  } finally {
    bridge.pushDrainRunningAccounts.delete('Primary');
    bridge.pushDrainRunningSinceByAccount.delete('Primary');
    bridge.pushDrainStuckWarnedAtByAccount.delete('Primary');
    cleanupBridge(bridge);
  }
});
