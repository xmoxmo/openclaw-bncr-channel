import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupBridge, createBridge, makeEntry } from '../helpers/bncr-bridge.mjs';

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

test('ack-timeout reroute matrix preserves fast-reroute, route reset, and dead-letter boundaries', async () => {
  const bridge = createBridge();
  try {
    const nowTs = Date.now();
    bridge.gatewayContext = { broadcastToConnIds() {} };
    for (const [clientId, connId] of [
      ['client-a', 'conn-a'],
      ['client-b', 'conn-b'],
    ]) {
      bridge.connections.set(`Primary:${clientId}`, {
        accountId: 'Primary',
        connId,
        clientId,
        connectedAt: nowTs - 5_000,
        lastSeenAt: nowTs - 500,
        outboundReadyUntil: nowTs + 60_000,
        preferredForOutboundUntil: nowTs + 60_000,
        inboundOnly: false,
      });
    }
    bridge.activeConnectionByAccount.set('Primary', 'Primary:client-a');
    bridge.isOnline = () => true;
    bridge.isOutboundAckRequired = () => true;
    bridge.waitForMessageAck = async () => 'timeout';

    const fast = makeEntry('matrix-fast', 'matrix fast');
    fast.lastPushConnId = 'conn-a';
    fast.lastPushClientId = 'client-a';
    bridge.outbox.set(fast.messageId, fast);
    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'matrix-fast' });
    assert.equal(bridge.outbox.get('matrix-fast')?.fastReroutePending, true);

    const reset = makeEntry('matrix-reset', 'matrix reset');
    reset.lastPushConnId = 'conn-b';
    reset.lastPushClientId = 'client-b';
    reset.routeAttemptConnIds = ['conn-a'];
    reset.fastReroutePending = true;
    bridge.outbox.set(reset.messageId, reset);
    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'matrix-reset' });
    assert.deepEqual(bridge.outbox.get('matrix-reset')?.routeAttemptConnIds, []);
    assert.equal(bridge.outbox.get('matrix-reset')?.routeAttemptRound, 1);

    bridge.outbox.clear();

    const dead = makeEntry('matrix-dead', 'matrix dead');
    dead.retryCount = 99;
    dead.lastPushConnId = 'conn-a';
    dead.lastPushClientId = 'client-a';
    bridge.outbox.set(dead.messageId, dead);
    await bridge.flushPushQueue({ accountId: 'Primary', trigger: 'test', reason: 'matrix-dead' });
    assert.equal(bridge.outbox.has('matrix-dead'), false);
    assert.ok(bridge.deadLetter.some((entry) => entry.messageId === 'matrix-dead'));
  } finally {
    cleanupBridge(bridge);
  }
});
