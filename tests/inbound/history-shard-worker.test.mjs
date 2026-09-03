import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearConversationHistorySerialLocks,
  resetConversationHistorySerialForTest,
  runConversationHistorySerial,
  setConversationHistorySerialOwner,
} from '../../src/messaging/inbound/conversation-history-serial.ts';
import {
  parseBncrHistoryShardPayload,
  processBncrHistoryShardSlot,
  runBncrHistoryShardWithLeaseRenewal,
} from '../../src/messaging/inbound/history-shard-worker.ts';

function buildHistoryShard(overrides = {}) {
  return {
    id: 77,
    historyKey: 'Primary:tgBot:10001',
    accountId: 'Primary',
    status: 'claimed',
    attempts: 1,
    payloadJson: JSON.stringify({
      version: 2,
      historyKey: 'Primary:tgBot:10001',
      accountId: 'Primary',
      messageIds: ['h1', 'h2'],
      bufferKeys: ['Primary:tgBot:10001'],
      dispatch: {
        parsed: {
          accountId: 'Primary',
          platform: 'tgBot',
          groupId: '0',
          userId: '10001',
          msgId: 'shard-msg',
          peer: { kind: 'direct', id: '10001' },
        },
        msgId: 'shard-msg',
        peer: { kind: 'direct', id: '10001' },
        rawBody: 'history flush',
        storePath: '/tmp/bncr-session',
        ctxPayload: {},
        resolution: {
          accountId: 'Primary',
          chatType: 'direct',
          route: { platform: 'tgBot', groupId: '0', userId: '10001' },
          originalResolvedRouteSessionKey: 'agent:orion:bncr:direct:demo',
          resolvedRoute: {
            sessionKey: 'agent:orion:bncr:direct:demo',
            agentId: 'orion',
          },
          canonicalTo: 'Bncr:tgBot:0:10001',
          rawTo: 'Bncr:tgBot:0:10001',
          originatingTo: 'Bncr:tgBot:0:10001',
          baseSessionKey: 'agent:orion:bncr:direct:demo',
          dispatchSessionKey: 'agent:orion:bncr:direct:demo',
        },
        replyRouteFact: {
          accountId: 'Primary',
          sessionKey: 'agent:orion:bncr:direct:demo',
          route: { platform: 'tgBot', groupId: '0', userId: '10001' },
          canonicalTo: 'Bncr:tgBot:0:10001',
          rawTo: 'Bncr:tgBot:0:10001',
          originatingTo: 'Bncr:tgBot:0:10001',
          chatType: 'direct',
        },
        senderIdForContext: '10001',
        senderDisplayName: 'alice',
        shouldDispatch: true,
        silentHistoryFlush: true,
      },
    }),
    messageIds: ['h1', 'h2'],
    bufferKeys: ['Primary:tgBot:10001'],
    lastError: null,
    nextAttemptAt: null,
    ...overrides,
  };
}

function buildQueue() {
  const calls = [];
  return {
    calls,
    claimNextHistoryShard: () => null,
    markHistoryShardProcessing: (shardId) => calls.push(`processing:${shardId}`),
    markHistoryShardFailed: (shardId, error) => calls.push(`failed:${shardId}:${String(error)}`),
    markHistoryShardCompleted: (shardId) => calls.push(`completed:${shardId}`),
    renewHistoryShardLease: (shardId) => {
      calls.push(`renew:${shardId}`);
      return true;
    },
    completeHistoryShard: (shardId) => calls.push(`complete:${shardId}`),
  };
}

test('history shard lease renewal runs while a long upload is active', async () => {
  let releaseUpload;
  const gate = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const queue = buildQueue();
  const run = runBncrHistoryShardWithLeaseRenewal({
    shardId: 77,
    historyShardQueue: queue,
    intervalMs: 5,
    task: async () => {
      await gate;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseUpload();
  await run;
  assert.ok(queue.calls.includes('renew:77'));
});

test('history shard lease renewal stops after the upload settles', async () => {
  const queue = buildQueue();
  await runBncrHistoryShardWithLeaseRenewal({
    shardId: 77,
    historyShardQueue: queue,
    intervalMs: 5,
    task: async () => {},
  });
  const renewCount = queue.calls.filter((call) => call === 'renew:77').length;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(renewCount, 0);
});

test('history shard worker renews the lease while waiting for the serial lock', async () => {
  resetConversationHistorySerialForTest();
  let releaseSerialGate;
  const serialGate = new Promise((resolve) => {
    releaseSerialGate = resolve;
  });
  const lock = runConversationHistorySerial('Primary:tgBot:10001', () => serialGate);
  const queue = buildQueue();
  const run = processBncrHistoryShardSlot({
    shard: buildHistoryShard(),
    historyShardQueue: queue,
    leaseRenewIntervalMs: 5,
    runDispatch: async () => {},
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    queue.calls.some((call) => call === 'renew:77'),
    'expected lease renewals while the shard waits for the serial lock',
  );

  releaseSerialGate();
  await Promise.all([lock, run]);
  assert.ok(queue.calls.includes('processing:77'));
  assert.ok(queue.calls.includes('completed:77'));
  assert.ok(queue.calls.includes('complete:77'));
  resetConversationHistorySerialForTest();
});

test('parseBncrHistoryShardPayload rejects legacy payloads without replay data', () => {
  assert.throws(
    () => parseBncrHistoryShardPayload('{"version":1}'),
    /unsupported history shard payload/,
  );
});

test('history shard worker dispatches a claimed shard and completes cleanup', async () => {
  resetConversationHistorySerialForTest();
  const shard = buildHistoryShard();
  const queue = buildQueue();
  const historyMap = new Map([
    [
      'Primary:tgBot:10001',
      [
        { sender: 'alice', body: 'h1', messageId: 'h1' },
        { sender: 'alice', body: 'h2', messageId: 'h2' },
      ],
    ],
  ]);
  let dispatched = false;
  await processBncrHistoryShardSlot({
    shard,
    historyShardQueue: queue,
    conversationHistories: historyMap,
    runDispatch: async (payload) => {
      dispatched = true;
      assert.equal(payload.parsed.msgId, 'shard-msg');
      assert.equal(payload.silentHistoryFlush, true);
      assert.equal(payload.deliveryId, 'bncr-history-shard:77');
    },
  });
  assert.equal(dispatched, true);
  assert.deepEqual(queue.calls, ['processing:77', 'completed:77', 'complete:77']);
  assert.equal(historyMap.get('Primary:tgBot:10001').length, 0);
});

test('history shard worker marks failed and does not complete on dispatch error', async () => {
  resetConversationHistorySerialForTest();
  const queue = buildQueue();
  const originalError = new Error('original upload failure');
  let caught;
  try {
    await processBncrHistoryShardSlot({
      shard: buildHistoryShard(),
      historyShardQueue: queue,
      runDispatch: async () => {
        throw originalError;
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, originalError);
  assert.deepEqual(queue.calls, ['processing:77', 'failed:77:Error: original upload failure']);
});

test('history shard worker aborts before dispatch when another owner holds the claim', async () => {
  resetConversationHistorySerialForTest();
  const queue = buildQueue();
  queue.markHistoryShardProcessing = (shardId) => {
    queue.calls.push(`processing:${shardId}`);
    return false;
  };
  let dispatched = false;

  await assert.rejects(
    processBncrHistoryShardSlot({
      shard: buildHistoryShard(),
      historyShardQueue: queue,
      runDispatch: async () => {
        dispatched = true;
      },
    }),
    /history shard activation lost/,
  );

  assert.equal(dispatched, false);
  assert.deepEqual(queue.calls, ['processing:77']);
  resetConversationHistorySerialForTest();
});

test('history shard worker preserves the original parse error', async () => {
  resetConversationHistorySerialForTest();
  const queue = buildQueue();
  const shard = buildHistoryShard({ payloadJson: 'not-json' });

  let caught;
  try {
    await processBncrHistoryShardSlot({
      shard,
      historyShardQueue: queue,
      runDispatch: async () => {},
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof SyntaxError);
  assert.equal(queue.calls.length, 1);
  assert.ok(queue.calls[0].startsWith('failed:77:SyntaxError:'));
});

test('history shard worker preserves the claim owner on parse failure', async () => {
  resetConversationHistorySerialForTest();
  setConversationHistorySerialOwner('bridge-b:2:new');
  const queue = buildQueue();
  queue.markHistoryShardFailed = (shardId, error, owner) =>
    queue.calls.push(`failed:${shardId}:${owner}:${String(error)}`);
  const shard = buildHistoryShard({
    owner: 'bridge-a:1:old',
    payloadJson: 'not-json',
  });

  let caught;
  try {
    await processBncrHistoryShardSlot({
      shard,
      historyShardQueue: queue,
      runDispatch: async () => {},
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof SyntaxError);
  assert.equal(queue.calls.length, 1);
  assert.ok(queue.calls[0].startsWith('failed:77:bridge-a:1:old:SyntaxError:'));
  resetConversationHistorySerialForTest();
});

test('history shard worker finalizes a completed upload after stale lock clear', async () => {
  resetConversationHistorySerialForTest();
  const queue = buildQueue();
  let releaseDispatch;
  const gate = new Promise((resolve) => {
    releaseDispatch = resolve;
  });
  const run = processBncrHistoryShardSlot({
    shard: buildHistoryShard(),
    historyShardQueue: queue,
    runDispatch: async () => {
      await gate;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clearConversationHistorySerialLocks(), 1);
  releaseDispatch();
  await run;
  assert.deepEqual(queue.calls, ['processing:77', 'completed:77', 'complete:77']);
});

test('history shard worker keeps the original claim owner after a stale lock clear', async () => {
  resetConversationHistorySerialForTest();
  setConversationHistorySerialOwner('bridge-a:1:old');
  const queue = buildQueue();
  queue.markHistoryShardProcessing = (shardId, owner) =>
    queue.calls.push(`processing:${shardId}:${owner}`);
  queue.markHistoryShardCompleted = (shardId, owner) =>
    queue.calls.push(`completed:${shardId}:${owner}`);
  queue.renewHistoryShardLease = (shardId, owner) => {
    queue.calls.push(`renew:${shardId}:${owner}`);
    return true;
  };
  queue.completeHistoryShard = (shardId, owner) => queue.calls.push(`complete:${shardId}:${owner}`);
  const shard = buildHistoryShard({ owner: 'bridge-a:1:old' });
  let releaseDispatch;
  const gate = new Promise((resolve) => {
    releaseDispatch = resolve;
  });
  const run = processBncrHistoryShardSlot({
    shard,
    historyShardQueue: queue,
    leaseRenewIntervalMs: 5,
    runDispatch: async () => {
      await gate;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(clearConversationHistorySerialLocks('runtime-restart', 'bridge-b:2:new'), 1);
  releaseDispatch();
  await run;

  assert.ok(queue.calls.includes('renew:77:bridge-a:1:old'));
  assert.ok(queue.calls.includes('processing:77:bridge-a:1:old'));
  assert.ok(queue.calls.includes('completed:77:bridge-a:1:old'));
  assert.ok(queue.calls.includes('complete:77:bridge-a:1:old'));
  assert.equal(
    queue.calls.some((call) => call.includes('bridge-b:2:new')),
    false,
  );
  resetConversationHistorySerialForTest();
});

test('history shard worker keeps the claim owner when queued behind a stale lock clear', async () => {
  resetConversationHistorySerialForTest();
  setConversationHistorySerialOwner('bridge-a:1:old');
  let releaseSerialGate;
  const serialGate = new Promise((resolve) => {
    releaseSerialGate = resolve;
  });
  const blocker = runConversationHistorySerial('Primary:tgBot:10001', () => serialGate);
  const queue = buildQueue();
  queue.markHistoryShardProcessing = (shardId, owner) =>
    queue.calls.push(`processing:${shardId}:${owner}`);
  queue.markHistoryShardCompleted = (shardId, owner) =>
    queue.calls.push(`completed:${shardId}:${owner}`);
  queue.completeHistoryShard = (shardId, owner) => queue.calls.push(`complete:${shardId}:${owner}`);
  const run = processBncrHistoryShardSlot({
    shard: buildHistoryShard({ owner: 'bridge-a:1:old' }),
    historyShardQueue: queue,
    runDispatch: async () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clearConversationHistorySerialLocks('runtime-restart', 'bridge-b:2:new'), 2);
  releaseSerialGate();
  await Promise.all([blocker, run]);

  assert.ok(queue.calls.includes('processing:77:bridge-a:1:old'));
  assert.ok(queue.calls.includes('completed:77:bridge-a:1:old'));
  assert.ok(queue.calls.includes('complete:77:bridge-a:1:old'));
  assert.equal(
    queue.calls.some((call) => call.includes('bridge-b:2:new')),
    false,
  );
  resetConversationHistorySerialForTest();
});
