import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridgeAckFacade } from '../../src/plugin/bridge-ack-facade.ts';

test('bridge ack facade preserves ack wait/file ack delegation and adaptive timeout decision', async () => {
  const logs = [];
  const facade = createBncrBridgeAckFacade({
    normalizeAccountId: (accountId) => String(accountId || '').trim(),
    now: () => 10_000,
    pushAckTimeoutMs: 45_000,
    adaptiveAckTimeoutDefaultEnabled: true,
    adaptiveAckTimeoutLogThrottleMs: 60_000,
    adaptiveAckTimeoutObservationTtlMs: 300_000,
    adaptiveAckTimeoutRecoveryOkThreshold: 2,
    recommendedAckTimeoutMinMs: 30_000,
    recommendedAckTimeoutMaxMs: 120_000,
    getCounter: (map, accountId) => map.get(accountId) || 0,
    ackTimeoutCountByAccount: new Map([['Primary', 3]]),
    lateAckOkCountByAccount: new Map([['Primary', 2]]),
    lastLateAckPushLatencyMsByAccount: new Map([['Primary', 70_000]]),
    lastLateAckOkByAccount: new Map([['Primary', 9_000]]),
    adaptiveAckRecoveryOkCountByAccount: new Map([['Primary', 0]]),
    adaptiveAckTimeoutLogStateByAccount: new Map(),
    logInfo(scope, message) {
      logs.push([scope, message]);
    },
    buildRuntimeAckObservability: (accountId) => ({ accountId, currentAckTimeoutMs: 60_000 }),
    buildRuntimeAckStrategy: (ackObservability) => ({ mode: 'adaptive', ackObservability }),
    waitForMessageAck: async (messageId, waitMs) => `${messageId}:${waitMs}:acked`,
    resolveMessageAck: (messageId, result = 'acked') => `${messageId}:${result}`,
    fileAckKey: (transferId, stage, chunkIndex) => `${transferId}:${stage}:${chunkIndex ?? '-'}`,
    waitForFileAck: async (params) => ({ ok: true, ...params }),
    resolveFileAck: (params) => params.ok,
  });

  assert.equal(await facade.waitForMessageAck('m1', 123), 'm1:123:acked');
  assert.equal(facade.resolveMessageAck('m2', 'timeout'), 'm2:timeout');
  assert.equal(facade.fileAckKey('t1', 'chunk', 2), 't1:chunk:2');
  assert.deepEqual(await facade.waitForFileAck({ transferId: 't1', stage: 'complete' }), {
    ok: true,
    transferId: 't1',
    stage: 'complete',
  });
  assert.equal(facade.resolveMessageAckTimeoutMs('Primary') >= 45_000, true);
  assert.deepEqual(facade.buildRuntimeAckObservability('Primary'), {
    accountId: 'Primary',
    currentAckTimeoutMs: 60_000,
  });
  assert.deepEqual(facade.buildRuntimeAckStrategy({ currentAckTimeoutMs: 60_000 }), {
    mode: 'adaptive',
    ackObservability: { currentAckTimeoutMs: 60_000 },
  });
  assert.equal(logs.length, 1);
});
