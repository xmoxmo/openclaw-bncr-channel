import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from './helpers/bncr-bridge.mjs';

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

test('stale non-owner ack keeps waiter pending and leaves outbox entry intact', async () => {
  const bridge = createBridge();

  try {
    const entry = makeEntry('msg-stale-non-owner', 'stale should not win');
    entry.lastPushConnId = 'conn-owner';
    entry.lastPushClientId = 'client-owner';
    bridge.outbox.set(entry.messageId, entry);

    const waiter = bridge.waitForMessageAck('msg-stale-non-owner', 40);
    const originalObserveLease = bridge.observeLease.bind(bridge);
    bridge.observeLease = (...args) => ({ ...originalObserveLease(...args), stale: true });

    let respondPayload = null;
    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-stale-non-owner',
        ok: true,
        clientId: 'client-intruder',
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-intruder' },
      context: null,
    });

    const waiterResult = await waiter;
    assert.deepEqual(respondPayload, {
      ok: true,
      payload: { ok: true, stale: true, ignored: true },
    });
    assert.equal(waiterResult, 'timeout');
    assert.equal(bridge.outbox.has('msg-stale-non-owner'), true);
    assert.equal(bridge.messageAckWaiters.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('ok ack is accepted again after retryable entry is pushed again', async () => {
  const bridge = createBridge();

  try {
    const entry = makeEntry('msg-ack-retry-repush', 'retry then repush then ok');
    entry.lastPushConnId = 'conn-1';
    entry.lastPushClientId = 'client-1';
    bridge.outbox.set(entry.messageId, entry);

    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retry-repush',
        ok: false,
        error: 'retry-first',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    const retried = bridge.outbox.get('msg-ack-retry-repush');
    assert.ok(retried);
    assert.equal(retried.awaitingRetryPush, true);

    bridge.recordOutboxPushSuccess({
      entry: retried,
      connIds: ['conn-2'],
      ownerConnId: 'conn-2',
      ownerClientId: 'client-2',
      clearLastError: false,
    });

    let respondPayload = null;
    await bridge.handleAck({
      params: {
        accountId: 'Primary',
        messageId: 'msg-ack-retry-repush',
        ok: true,
      },
      respond(ok, payload) {
        respondPayload = { ok, payload };
      },
      client: { connId: 'conn-2' },
      context: null,
    });

    assert.equal(bridge.outbox.has('msg-ack-retry-repush'), false);
    assert.deepEqual(respondPayload, { ok: true, payload: { ok: true } });
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleActivity flushes queued outbound for the same account', async () => {
  const bridge = createBridge();
  const spy = spyFlushPushQueue(bridge);

  try {
    await bridge.handleActivity({
      params: { accountId: 'Primary', clientId: 'client-1' },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(spy.calls, [
      { accountId: 'Primary', trigger: 'activity', reason: 'activity-heartbeat' },
    ]);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});

test('handleInbound flushes queued outbound for the same account before async dispatch', async () => {
  const bridge = createBridge();
  const spy = spyFlushPushQueue(bridge);

  try {
    await bridge.handleInbound({
      params: {
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        type: 'text',
        msg: 'hello inbound',
        msgId: 'inbound-1',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    assert.deepEqual(spy.calls, [
      { accountId: 'Primary', trigger: 'inbound', reason: 'inbound-accepted' },
    ]);
  } finally {
    spy.restore();
    cleanupBridge(bridge);
  }
});

test('startService reopens runtime scheduling after stopService cleanup', async () => {
  const bridge = createBridge();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-start-stop-'));

  try {
    await bridge.stopService();
    assert.equal(bridge.stopped, true);

    await bridge.startService({ stateDir }, false);
    assert.equal(bridge.stopped, false);

    bridge.schedulePushDrain(1_000);
    assert.ok(bridge.pushTimer, 'schedulePushDrain should work after restart');
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('push path does not depend on recent inbound helper fallback', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: 0,
      preferredForOutboundUntil: 0,
      inboundOnly: false,
    });
    bridge.lastInboundByAccount.set('Primary', nowTs - 500);
    let broadcastCalls = 0;
    bridge.gatewayContext = {
      broadcastToConnIds() {
        broadcastCalls += 1;
      },
    };

    const entry = makeEntry('msg-no-recent-inbound', 'no recent inbound fallback');
    bridge.outbox.set(entry.messageId, entry);

    const pushed = await bridge.tryPushEntry(entry);
    assert.equal(pushed, true);
    assert.equal(broadcastCalls, 1);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleInbound does not force inboundOnly false', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      inboundOnly: true,
    });
    await bridge.handleInbound({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        type: 'text',
        msg: 'hello',
        msgId: 'inbound-keep-inboundOnly',
      },
      respond() {},
      client: { connId: 'conn-a' },
      context: null,
    });
    const conn = bridge.connections.get('Primary:client-a');
    assert.equal(conn.inboundOnly, true);
  } finally {
    cleanupBridge(bridge);
  }
});

test('first ack timeout fast-reroutes away from lastPushConnId when an alternative exists', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.connections.set('Primary:client-b', {
      accountId: 'Primary',
      connId: 'conn-b',
      clientId: 'client-b',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');

    const firstPushes = [];
    bridge.gatewayContext = {
      broadcastToConnIds(_event, _payload, connIds) {
        firstPushes.push(Array.from(connIds));
      },
    };

    const entry = makeEntry('msg-fast-reroute', 'fast reroute');
    entry.lastPushConnId = 'conn-a';
    entry.lastPushClientId = 'client-a';
    bridge.outbox.set(entry.messageId, entry);
    bridge.waitForMessageAck = async () => 'timeout';
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => true;

    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'fast-reroute' });

    const updated = bridge.outbox.get(entry.messageId);
    assert.deepEqual(firstPushes[0], ['conn-a']);
    assert.deepEqual(updated.routeAttemptConnIds, ['conn-a']);
    assert.equal(updated.fastReroutePending, true);
    assert.equal(updated.nextAttemptAt - updated.lastAttemptAt <= 1_100, true);

    const pushedEntry = makeEntry('msg-fast-reroute-next', 'fast reroute next');
    pushedEntry.routeAttemptConnIds = ['conn-a'];
    let pushedConnIds = null;
    bridge.gatewayContext = {
      broadcastToConnIds(_event, _payload, connIds) {
        pushedConnIds = Array.from(connIds);
      },
    };
    const pushed = await bridge.tryPushEntry(pushedEntry);
    assert.equal(pushed, true);
    assert.deepEqual(pushedConnIds, ['conn-b']);
    assert.equal(pushedEntry.lastPushConnId, 'conn-b');
  } finally {
    cleanupBridge(bridge);
  }
});

test('route attempts reset after all visible candidates are exhausted and original ordering becomes reusable', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 2_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.connections.set('Primary:client-b', {
      accountId: 'Primary',
      connId: 'conn-b',
      clientId: 'client-b',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 30_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');

    const firstPushes = [];
    bridge.gatewayContext = {
      broadcastToConnIds(_event, _payload, connIds) {
        firstPushes.push(Array.from(connIds));
      },
    };

    const entry = makeEntry('msg-route-reset', 'route reset');
    entry.lastPushConnId = 'conn-b';
    entry.lastPushClientId = 'client-b';
    entry.routeAttemptConnIds = ['conn-a'];
    entry.fastReroutePending = true;
    bridge.outbox.set(entry.messageId, entry);
    bridge.waitForMessageAck = async () => 'timeout';
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => true;

    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'route-reset' });

    const updated = bridge.outbox.get(entry.messageId);
    assert.deepEqual(firstPushes[0], ['conn-b']);
    assert.deepEqual(updated.routeAttemptConnIds, []);
    assert.equal(updated.fastReroutePending, false);
    assert.equal(updated.routeAttemptRound, 1);

    const pushedEntry = makeEntry('msg-route-reset-next', 'route reset next');
    let pushedConnIds = null;
    bridge.gatewayContext = {
      broadcastToConnIds(_event, _payload, connIds) {
        pushedConnIds = Array.from(connIds);
      },
    };
    const pushed = await bridge.tryPushEntry(pushedEntry);
    assert.equal(pushed, true);
    assert.ok(Array.isArray(pushedConnIds));
    assert.ok(pushedConnIds.includes('conn-a'));
  } finally {
    cleanupBridge(bridge);
  }
});

test('resolvePushConnIds prefers outbound-capable live connections and falls back to ttl-live live connections', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: 0,
      preferredForOutboundUntil: 0,
      inboundOnly: false,
    });

    const owner = bridge.resolveOutboxPushOwner('Primary');
    const connIds = Array.from(bridge.resolvePushConnIds('Primary'));

    assert.equal(owner?.connId, 'conn-a');
    assert.ok(connIds.includes('conn-a'));
  } finally {
    cleanupBridge(bridge);
  }
});

test('cleanupFileTransfers prunes terminal transfers after short ttl but keeps active transfers on long ttl', async () => {
  const bridge = createBridge();
  const originalNow = Date.now;
  const nowTs = originalNow() + 2_000_000;
  Date.now = () => nowTs;

  try {
    bridge.fileSendTransfers.set('send-completed-old', {
      transferId: 'send-completed-old',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'done.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      startedAt: nowTs - 20 * 60_000,
      terminalAt: nowTs - 11 * 60_000,
      status: 'completed',
      ackedChunks: new Set(),
      failedChunks: new Map(),
    });
    bridge.fileSendTransfers.set('send-transferring-young-for-long-ttl', {
      transferId: 'send-transferring-young-for-long-ttl',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'active.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      startedAt: nowTs - 20 * 60_000,
      status: 'transferring',
      ackedChunks: new Set(),
      failedChunks: new Map(),
    });
    bridge.fileRecvTransfers.set('recv-aborted-old', {
      transferId: 'recv-aborted-old',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'aborted.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      startedAt: nowTs - 20 * 60_000,
      terminalAt: nowTs - 11 * 60_000,
      status: 'aborted',
      bufferByChunk: new Map(),
      receivedChunks: new Set(),
    });
    bridge.fileRecvTransfers.set('recv-completed-recent', {
      transferId: 'recv-completed-recent',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'recent.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      startedAt: nowTs - 20 * 60_000,
      terminalAt: nowTs - 9 * 60_000,
      status: 'completed',
      bufferByChunk: new Map(),
      receivedChunks: new Set(),
    });
    bridge.fileSendTransfers.set('send-completed-invalid-terminal-falls-back-to-started', {
      transferId: 'send-completed-invalid-terminal-falls-back-to-started',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'invalid-terminal.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      startedAt: nowTs - 20 * 60_000,
      terminalAt: Number.NaN,
      status: 'completed',
      ackedChunks: new Set(),
      failedChunks: new Map(),
    });
    bridge.fileRecvTransfers.set('recv-active-invalid-started-kept', {
      transferId: 'recv-active-invalid-started-kept',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:demo',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      fileName: 'invalid-started.png',
      mimeType: 'image/png',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      fileSha256: 'sha',
      startedAt: Number.POSITIVE_INFINITY,
      status: 'receiving',
      bufferByChunk: new Map(),
      receivedChunks: new Set(),
    });

    bridge.cleanupFileTransfers();

    assert.equal(bridge.fileSendTransfers.has('send-completed-old'), false);
    assert.equal(bridge.fileRecvTransfers.has('recv-aborted-old'), false);
    assert.equal(bridge.fileSendTransfers.has('send-transferring-young-for-long-ttl'), true);
    assert.equal(bridge.fileRecvTransfers.has('recv-completed-recent'), true);
    assert.equal(
      bridge.fileSendTransfers.has('send-completed-invalid-terminal-falls-back-to-started'),
      false,
    );
    assert.equal(bridge.fileRecvTransfers.has('recv-active-invalid-started-kept'), true);
  } finally {
    Date.now = originalNow;
    cleanupBridge(bridge);
  }
});

test('route owner ignores stale active and inboundOnly candidates when outbound-ready owner exists', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:stale-active', {
      accountId: 'Primary',
      connId: 'conn-stale-active',
      clientId: 'stale-active',
      connectedAt: nowTs - 10 * 60_000,
      lastSeenAt: nowTs - 5 * 60_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      inboundOnly: false,
    });
    bridge.connections.set('Primary:inbound-only', {
      accountId: 'Primary',
      connId: 'conn-inbound-only',
      clientId: 'inbound-only',
      connectedAt: nowTs - 20_000,
      lastSeenAt: nowTs - 500,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      inboundOnly: true,
    });
    bridge.connections.set('Primary:outbound-ready', {
      accountId: 'Primary',
      connId: 'conn-outbound-ready',
      clientId: 'outbound-ready',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 30_000,
      inboundOnly: false,
    });
    bridge.activeConnectionByAccount.set('Primary', 'Primary:stale-active');
    bridge.lastInboundByAccount.set('Primary', nowTs - 500);
    bridge.lastActivityByAccount.set('Primary', nowTs - 500);

    const ownerFromStaleActive = bridge.resolveOutboxPushOwner('Primary');
    const connIdsFromStaleActive = Array.from(bridge.resolvePushConnIds('Primary'));

    assert.equal(ownerFromStaleActive?.connId, 'conn-outbound-ready');
    assert.deepEqual(connIdsFromStaleActive, ['conn-outbound-ready']);

    bridge.activeConnectionByAccount.set('Primary', 'Primary:inbound-only');

    const ownerFromInboundOnlyActive = bridge.resolveOutboxPushOwner('Primary');
    const connIdsFromInboundOnlyActive = Array.from(bridge.resolvePushConnIds('Primary'));

    assert.equal(ownerFromInboundOnlyActive?.connId, 'conn-outbound-ready');
    assert.deepEqual(connIdsFromInboundOnlyActive, ['conn-outbound-ready']);
  } finally {
    cleanupBridge(bridge);
  }
});

test('startService tolerates corrupt persisted state by falling back to empty state', async () => {
  const bridge = createBridge();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-corrupt-state-'));
  try {
    await fs.writeFile(path.join(stateDir, 'bncr-bridge-state.json'), '{"outbox":[', 'utf8');

    await bridge.startService({ stateDir }, false);

    assert.equal(bridge.outbox.size, 0);
    assert.equal(bridge.deadLetter.length, 0);
    assert.equal(bridge.sessionRoutes.size, 0);
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('startService caps oversized persisted account activity arrays during load', async () => {
  const bridge = createBridge();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-large-activity-state-'));
  try {
    const nowTs = Date.now();
    const mkAccount = (i) => `Account-${i}`;
    const mkSession = (i) => {
      const groupId = `-${200000 + i}`;
      return {
        accountId: mkAccount(i),
        sessionKey: `agent:orion:bncr:direct:${Buffer.from(`tgBot:${groupId}:10001`).toString('hex')}`,
        scope: 'ignored',
        updatedAt: nowTs + i,
      };
    };
    const mkActivity = (i) => ({ accountId: mkAccount(i), updatedAt: nowTs + i });
    const state = {
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
      lastSessionByAccount: Array.from({ length: 1005 }, (_, i) => mkSession(i)),
      lastActivityByAccount: Array.from({ length: 1005 }, (_, i) => mkActivity(i)),
      lastInboundByAccount: Array.from({ length: 1005 }, (_, i) => mkActivity(i)),
      lastOutboundByAccount: Array.from({ length: 1005 }, (_, i) => mkActivity(i)),
    };
    await fs.writeFile(
      path.join(stateDir, 'bncr-bridge-state.json'),
      JSON.stringify(state),
      'utf8',
    );

    await bridge.startService({ stateDir }, false);

    assert.equal(bridge.lastSessionByAccount.size, 1000);
    assert.equal(bridge.lastActivityByAccount.size, 1000);
    assert.equal(bridge.lastInboundByAccount.size, 1000);
    assert.equal(bridge.lastOutboundByAccount.size, 1000);
    for (const map of [
      bridge.lastSessionByAccount,
      bridge.lastActivityByAccount,
      bridge.lastInboundByAccount,
      bridge.lastOutboundByAccount,
    ]) {
      assert.equal(map.has('Account-4'), false);
      assert.equal(map.has('Account-5'), true);
      assert.equal(map.has('Account-1004'), true);
    }
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('startService caps oversized persisted session routes during load', async () => {
  const bridge = createBridge();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-large-routes-state-'));
  try {
    const sessionRoutes = Array.from({ length: 1005 }, (_, i) => {
      const groupId = `-${100000 + i}`;
      const route = { platform: 'tgBot', groupId, userId: '10001' };
      return {
        sessionKey: `agent:orion:bncr:direct:${Buffer.from(`tgBot:${groupId}:10001`).toString('hex')}`,
        accountId: 'Primary',
        route,
        updatedAt: Date.now() + i,
      };
    });
    const state = {
      outbox: [],
      deadLetter: [],
      sessionRoutes,
    };
    await fs.writeFile(
      path.join(stateDir, 'bncr-bridge-state.json'),
      JSON.stringify(state),
      'utf8',
    );

    await bridge.startService({ stateDir }, false);

    assert.equal(bridge.sessionRoutes.size, 1000);
    assert.equal(bridge.routeAliases.size, 1000);
    assert.equal(
      bridge.sessionRoutes.has(
        `agent:orion:bncr:direct:${Buffer.from('tgBot:-100000:10001').toString('hex')}`,
      ),
      false,
    );
    assert.equal(
      bridge.sessionRoutes.has(
        `agent:orion:bncr:direct:${Buffer.from('tgBot:-100004:10001').toString('hex')}`,
      ),
      false,
    );
    assert.equal(
      bridge.sessionRoutes.has(
        `agent:orion:bncr:direct:${Buffer.from('tgBot:-100005:10001').toString('hex')}`,
      ),
      true,
    );
    assert.equal(
      bridge.sessionRoutes.has(
        `agent:orion:bncr:direct:${Buffer.from('tgBot:-101004:10001').toString('hex')}`,
      ),
      true,
    );
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('startService caps oversized persisted deadLetter state during load', async () => {
  const bridge = createBridge();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-large-dead-state-'));
  try {
    const persistedSessionKey = 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031';
    const deadLetter = Array.from({ length: 1005 }, (_, i) => {
      const entry = makeEntry(`persisted-dead-${i}`, `dead ${i}`);
      entry.sessionKey = persistedSessionKey;
      entry.payload.sessionKey = persistedSessionKey;
      return entry;
    });
    const state = {
      outbox: [],
      deadLetter,
      sessionRoutes: [],
    };
    await fs.writeFile(
      path.join(stateDir, 'bncr-bridge-state.json'),
      JSON.stringify(state),
      'utf8',
    );

    await bridge.startService({ stateDir }, false);

    assert.equal(bridge.deadLetter.length, 1000);
    assert.equal(bridge.deadLetter[0].messageId, 'persisted-dead-5');
    assert.equal(bridge.deadLetter.at(-1).messageId, 'persisted-dead-1004');
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('startService skips malformed persisted entries without blocking valid state', async () => {
  const bridge = createBridge();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bncr-dirty-state-'));
  try {
    const nowTs = Date.now();
    const persistedSessionKey = 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031';
    const goodOutbox = makeEntry('persisted-good-outbox', 'good outbox');
    goodOutbox.sessionKey = persistedSessionKey;
    goodOutbox.payload.sessionKey = persistedSessionKey;
    goodOutbox.createdAt = String(nowTs - 10_000);
    goodOutbox.nextAttemptAt = String(nowTs - 5_000);
    goodOutbox.retryCount = '2';
    goodOutbox.lastAttemptAt = 'not-a-number';
    const goodDeadLetter = makeEntry('persisted-good-dead', 'good dead');
    goodDeadLetter.sessionKey = persistedSessionKey;
    goodDeadLetter.payload.sessionKey = persistedSessionKey;
    goodDeadLetter.createdAt = 'not-a-number';
    goodDeadLetter.nextAttemptAt = 'not-a-number';
    goodDeadLetter.retryCount = 'not-a-number';
    goodDeadLetter.lastAttemptAt = 'not-a-number';
    const state = {
      outbox: [
        null,
        {},
        { messageId: 'bad-missing-session', accountId: 'Primary' },
        { ...goodOutbox, route: { malformed: true } },
      ],
      deadLetter: [{ messageId: 'bad-dead-missing-session', accountId: 'Primary' }, goodDeadLetter],
      sessionRoutes: [
        null,
        { sessionKey: 'bad-session-key', accountId: 'Primary', route: {}, updatedAt: nowTs },
        {
          sessionKey: persistedSessionKey,
          accountId: 'Primary',
          route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
          updatedAt: 'not-a-number',
        },
      ],
      lastSessionByAccount: [
        { accountId: 'Primary', sessionKey: 'bad-session-key', scope: 'bad', updatedAt: nowTs },
        {
          accountId: 'Primary',
          sessionKey: persistedSessionKey,
          scope: 'ignored-stored-scope',
          updatedAt: String(nowTs),
        },
      ],
      lastActivityByAccount: [
        { accountId: 'Primary', updatedAt: 'not-a-number' },
        { accountId: 'Primary', updatedAt: String(nowTs - 1_000) },
      ],
      lastInboundByAccount: [
        { accountId: 'Primary', updatedAt: 0 },
        { accountId: 'Primary', updatedAt: String(nowTs - 2_000) },
      ],
      lastOutboundByAccount: [
        { accountId: 'Primary', updatedAt: -1 },
        { accountId: 'Primary', updatedAt: String(nowTs - 3_000) },
      ],
      lastDriftSnapshot: {
        capturedAt: 'not-a-number',
        registerCount: 'not-a-number',
        apiGeneration: '2',
        postWarmupRegisterCount: '3',
        apiInstanceId: 'api-1',
        registryFingerprint: 'fingerprint-1',
        dominantBucket: 'bucket-1',
        sourceBuckets: { 'bucket-1': 1 },
        traceWindowSize: 'not-a-number',
        traceRecent: [{ source: 'test' }],
      },
    };
    await fs.writeFile(
      path.join(stateDir, 'bncr-bridge-state.json'),
      JSON.stringify(state),
      'utf8',
    );

    await bridge.startService({ stateDir }, false);

    assert.deepEqual(Array.from(bridge.outbox.keys()), ['persisted-good-outbox']);
    const loadedOutbox = bridge.outbox.get('persisted-good-outbox');
    assert.equal(loadedOutbox.retryCount, 2);
    assert.equal(loadedOutbox.createdAt, nowTs - 10_000);
    assert.equal(loadedOutbox.nextAttemptAt, nowTs - 5_000);
    assert.equal(loadedOutbox.lastAttemptAt, undefined);
    assert.deepEqual(loadedOutbox.route, {
      platform: 'tgBot',
      groupId: '-1001',
      userId: '10001',
    });
    assert.deepEqual(
      bridge.deadLetter.map((entry) => entry.messageId),
      ['persisted-good-dead'],
    );
    assert.equal(Number.isFinite(bridge.deadLetter[0].createdAt), true);
    assert.equal(bridge.deadLetter[0].retryCount, 0);
    assert.equal(Number.isFinite(bridge.deadLetter[0].nextAttemptAt), true);
    assert.equal(bridge.deadLetter[0].lastAttemptAt, undefined);
    assert.equal(bridge.sessionRoutes.size, 1);
    assert.equal(Number.isFinite(Array.from(bridge.sessionRoutes.values())[0].updatedAt), true);
    assert.equal(bridge.lastSessionByAccount.get('Primary')?.scope, 'Bncr:tgBot:-1001:10001');
    assert.equal(bridge.lastActivityByAccount.get('Primary'), nowTs - 1_000);
    assert.equal(bridge.lastInboundByAccount.get('Primary'), nowTs - 2_000);
    assert.equal(bridge.lastOutboundByAccount.get('Primary'), nowTs - 3_000);
    const diagnostics = bridge.buildExtendedDiagnostics('Primary');
    assert.equal(diagnostics.register.lastDriftSnapshot.capturedAt, 0);
    assert.equal(diagnostics.register.lastDriftSnapshot.registerCount, null);
    assert.equal(diagnostics.register.lastDriftSnapshot.apiGeneration, 2);
    assert.equal(diagnostics.register.lastDriftSnapshot.postWarmupRegisterCount, 3);
    assert.equal(diagnostics.register.lastDriftSnapshot.traceWindowSize, 0);
  } finally {
    cleanupBridge(bridge);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

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

async function assertResolvesWithin(promise, ms, label) {
  await Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not resolve`)), ms)),
  ]);
}

function createAccountStatusCtx(accountId = 'Primary') {
  let status = {};
  return {
    accountId,
    getStatus() {
      return status;
    },
    setStatus(next) {
      status = next;
    },
  };
}

function createCountingAbortSignal() {
  const listeners = new Set();
  return {
    signal: {
      aborted: false,
      addEventListener(event, listener) {
        if (event === 'abort') listeners.add(listener);
      },
      removeEventListener(event, listener) {
        if (event === 'abort') listeners.delete(listener);
      },
    },
    listenerCount() {
      return listeners.size;
    },
    abort() {
      this.signal.aborted = true;
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

test('channelStopAccount removes status worker abort listener during cleanup', async () => {
  const bridge = createBridge();
  try {
    const abort = createCountingAbortSignal();
    const ctx = {
      ...createAccountStatusCtx('Primary'),
      abortSignal: abort.signal,
    };
    const started = bridge.channelStartAccount(ctx);
    assert.equal(abort.listenerCount(), 1);

    await bridge.channelStopAccount(ctx);

    assert.equal(abort.listenerCount(), 0);
    abort.abort();
    assert.equal(abort.listenerCount(), 0);
    await assertResolvesWithin(started, 50, 'channelStartAccount after abort listener cleanup');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channelStopAccount resolves a running status worker instead of only clearing its interval', async () => {
  const bridge = createBridge();
  try {
    const ctx = createAccountStatusCtx('Primary');
    const started = bridge.channelStartAccount(ctx);
    assert.equal(bridge.channelAccountWorkers.size, 1);

    await bridge.channelStopAccount(ctx);

    assert.equal(bridge.channelAccountWorkers.size, 0);
    await assertResolvesWithin(started, 50, 'channelStartAccount after channelStopAccount');
  } finally {
    cleanupBridge(bridge);
  }
});

test('channelStartAccount start-replace resolves the previous status worker', async () => {
  const bridge = createBridge();
  try {
    const firstCtx = createAccountStatusCtx('Primary');
    const firstStarted = bridge.channelStartAccount(firstCtx);
    assert.equal(bridge.channelAccountWorkers.size, 1);

    const secondCtx = createAccountStatusCtx('Primary');
    const secondStarted = bridge.channelStartAccount(secondCtx);

    await assertResolvesWithin(
      firstStarted,
      50,
      'previous channelStartAccount after start-replace',
    );
    assert.equal(bridge.channelAccountWorkers.size, 1);

    await bridge.channelStopAccount(secondCtx);
    await assertResolvesWithin(secondStarted, 50, 'replacement channelStartAccount after stop');
    assert.equal(bridge.channelAccountWorkers.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('stopService clears and resolves running status workers', async () => {
  const bridge = createBridge();
  try {
    const ctx = createAccountStatusCtx('Primary');
    const started = bridge.channelStartAccount(ctx);
    assert.equal(bridge.channelAccountWorkers.size, 1);

    await bridge.stopService();

    assert.equal(bridge.channelAccountWorkers.size, 0);
    await assertResolvesWithin(started, 50, 'channelStartAccount after stopService');
  } finally {
    cleanupBridge(bridge);
  }
});

test('log dedupe state prunes expired and oversized keys', () => {
  const bridge = createBridge();
  const originalNow = Date.now;
  const fakeNow = originalNow() + 10_000_000;
  Date.now = () => fakeNow;

  try {
    bridge.logDedupeState.set('expired', { at: fakeNow - 700_000, sig: 'old' });
    for (let i = 0; i < 1_005; i += 1) {
      bridge.logDedupeState.set(`key-${i}`, { at: fakeNow - 1_000 + i, sig: `sig-${i}` });
    }

    const emitted = bridge.shouldEmitDedupLog('fresh', 'sig-fresh');

    assert.equal(emitted, true);
    assert.equal(bridge.logDedupeState.has('expired'), false);
    assert.equal(bridge.logDedupeState.has('fresh'), true);
    assert.ok(bridge.logDedupeState.size <= 1000);
  } finally {
    Date.now = originalNow;
    cleanupBridge(bridge);
  }
});
