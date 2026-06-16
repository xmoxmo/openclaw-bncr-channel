import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridgeOutboxFacade } from '../../src/plugin/bridge-outbox-facade.ts';

function makeEntry(messageId, accountId = 'Primary') {
  return {
    messageId,
    accountId,
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: messageId },
    retryCount: 0,
    nextAttemptAt: 1,
    createdAt: 1,
  };
}

test('bridge outbox facade preserves enqueue, dead-letter, and due collection transitions', () => {
  const outbox = new Map();
  let deadLetter = [];
  const resolved = [];
  const logs = [];
  const flushes = [];
  const enqueueCount = new Map();
  const lastEnqueue = new Map();
  const deadLetterSinceStart = new Map();
  const lastOutboundByAccount = new Map();
  let saveCount = 0;

  const facade = createBncrBridgeOutboxFacade({
    bridgeId: 'bridge-1',
    normalizeAccountId: (accountId) => String(accountId || '').trim(),
    asString: (value, fallback = '') =>
      typeof value === 'string' ? value : value == null ? fallback : String(value),
    now: () => 10,
    backoffMs: () => 100,
    maxRetry: 1,
    maxDeadLetterEntries: 5,
    outbox,
    getDeadLetter: () => deadLetter,
    setDeadLetter: (entries) => {
      deadLetter = entries;
    },
    incrementCounter: (map, accountId) => map.set(accountId, (map.get(accountId) || 0) + 1),
    outboundEnqueueCountByAccount: enqueueCount,
    lastOutboundEnqueueAtByAccount: lastEnqueue,
    prePushGuardSkipCountByAccount: new Map(),
    lastPrePushGuardSkipAtByAccount: new Map(),
    lastPrePushGuardSkipReasonByAccount: new Map(),
    deadLetterSinceStartByAccount: deadLetterSinceStart,
    lastOutboundByAccount,
    scheduleSave: () => {
      saveCount += 1;
    },
    flushPushQueueBestEffort: (args) => flushes.push(args),
    logInfo: (scope, message) => logs.push([scope, message]),
    logOutboundSummary() {},
    logDeadLetterSummary() {},
    resolveMessageAck: (messageId, result = 'acked') => {
      resolved.push([messageId, result]);
      return true;
    },
    markActivity: (accountId, at) => lastOutboundByAccount.set(`${accountId}:activity`, at),
  });

  const first = makeEntry('m1');
  facade.enqueueOutbound(first);
  assert.equal(outbox.get('m1'), first);
  assert.equal(enqueueCount.get('Primary'), 1);
  assert.equal(lastEnqueue.get('Primary'), 10);
  assert.deepEqual(flushes, [{ accountId: 'Primary' }]);

  facade.recordOutboxPushSuccess({ entry: first, connIds: ['c1'], ownerConnId: 'c1' });
  assert.equal(lastOutboundByAccount.get('Primary'), 10);

  outbox.delete('m1');

  const retryLimit = makeEntry('m2');
  retryLimit.retryCount = 2;
  retryLimit.lastError = 'fatal';
  outbox.set(retryLimit.messageId, retryLimit);
  const due = facade.collectDue({ accountId: 'Primary', maxBatch: 10 });
  assert.deepEqual(due, []);
  assert.equal(deadLetter.length, 1);
  assert.equal(deadLetter[0].messageId, 'm2');
  assert.deepEqual(resolved, [['m2', 'timeout']]);
  assert.ok(saveCount >= 2);
  assert.equal(
    logs.some(([scope]) => scope === 'outbound'),
    true,
  );
});
