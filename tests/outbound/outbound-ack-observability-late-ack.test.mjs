import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge, makeEntry } from '../helpers/bncr-bridge.mjs';

test('late ok ack after retryable ack clears the queue and records slow-ack observability', async () => {
  const logs = [];
  const bridge = createBridge();
  const originalLogInfo = bridge.logInfo.bind(bridge);
  bridge.logInfo = (scope, message, options) => {
    logs.push({ scope, message, options });
    return originalLogInfo(scope, message, options);
  };

  try {
    const entry = makeEntry('msg-ack-retry-late', 'retry then late ok');
    entry.createdAt = Math.max(0, entry.createdAt - 8000);
    entry.lastPushAt = entry.createdAt + 2000;
    entry.lastPushConnId = 'conn-1';
    entry.lastPushClientId = 'client-1';
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retry-late',
        ok: false,
        error: 'retry-first',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    let respondPayload = null;
    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retry-late',
        ok: true,
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.equal(bridge.outbox.has('msg-ack-retry-late'), false);
    assert.deepEqual(respondPayload, { ok: true, payload: { ok: true } });
    assert.equal(bridge.getCounter(bridge.lateAckOkCountByAccount, 'Primary'), 1);
    assert.ok(bridge.lastLateAckOkByAccount.get('Primary'));
    assert.ok(bridge.lastAckOkByAccount.get('Primary'));
    assert.ok((bridge.lastAckQueueLatencyMsByAccount.get('Primary') || 0) >= 8000);
    assert.ok((bridge.lastAckPushLatencyMsByAccount.get('Primary') || 0) >= 6000);
    assert.equal(
      bridge.lastLateAckQueueLatencyMsByAccount.get('Primary'),
      bridge.lastAckQueueLatencyMsByAccount.get('Primary'),
    );
    assert.equal(
      bridge.lastLateAckPushLatencyMsByAccount.get('Primary'),
      bridge.lastAckPushLatencyMsByAccount.get('Primary'),
    );
    const lateAckLog = logs.find((item) => item.scope === 'outbox ack ok late');
    assert.ok(lateAckLog);
    assert.match(lateAckLog.message, /queueMs=\d+/);
    assert.match(lateAckLog.message, /pushMs=\d+/);
  } finally {
    bridge.logInfo = originalLogInfo;
    cleanupBridge(bridge);
  }
});

test('normal ack successes increment adaptive recovery counter', async () => {
  const bridge = createBridge();

  try {
    for (let i = 1; i <= 3; i += 1) {
      const entry = makeEntry(`msg-ack-recover-${i}`, 'recover');
      entry.createdAt = Date.now();
      entry.lastPushAt = Date.now() - 100;
      entry.lastPushConnId = 'conn-1';
      entry.lastPushClientId = 'client-1';
      bridge.outbox.set(entry.messageId, entry);
      await bridge.handleAck({
        params: { accountId: 'Primary', messageId: entry.messageId, ok: true },
        respond() {},
        client: { connId: 'conn-1' },
        context: null,
      });
    }

    assert.equal(bridge.getCounter(bridge.adaptiveAckRecoveryOkCountByAccount, 'Primary'), 3);
  } finally {
    cleanupBridge(bridge);
  }
});
