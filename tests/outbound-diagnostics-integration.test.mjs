import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge, makeEntry } from './helpers/bncr-bridge.mjs';
import { withConsoleCapture } from './helpers/console-capture.mjs';

function summarizeDeadLetterTestEntries(entries) {
  return entries.map((entry) => ({
    accountId: entry.accountId,
    messageId: entry.messageId,
    createdAt: entry.createdAt,
  }));
}

test('diagnostics exposes outbound enqueue and pre-push guard context observability', async () => {
  const bridge = createBridge();
  const scheduled = [];

  try {
    const entry = makeEntry('msg-diagnostics-pre-push-context', 'diagnostics context gap');
    bridge.gatewayContext = null;
    bridge.sleepMs = async () => {};
    bridge.schedulePushDrain = (delayMs = 0) => {
      scheduled.push(delayMs);
    };

    bridge.enqueueOutbound(entry);

    const diagnostics = bridge.buildExtendedDiagnostics('Primary');
    assert.equal(diagnostics.connection.hasGatewayContext, false);
    assert.equal(diagnostics.connection.lastGatewayContextAt, null);
    assert.equal(diagnostics.outbound.pending, 1);
    assert.equal(diagnostics.outbound.enqueueCount, 1);
    assert.equal(typeof diagnostics.outbound.lastEnqueueAt, 'number');
    assert.equal(diagnostics.outbound.prePushGuardSkipCount, 1);
    assert.equal(diagnostics.outbound.lastPrePushGuardSkipReason, 'no-gateway-context');
    assert.equal(typeof diagnostics.outbound.lastPrePushGuardSkipAt, 'number');
    assert.equal(diagnostics.outbound.incident.active, true);
    assert.equal(diagnostics.outbound.incident.type, 'no-gateway-context');
    assert.equal(diagnostics.outbound.incident.severity, 'critical');
    assert.equal(
      diagnostics.outbound.incident.recommendedAction,
      'check-channel-message-runtime-context',
    );
    assert.equal(diagnostics.outbound.incident.pending, 1);
    assert.equal(diagnostics.outbound.incident.hasGatewayContext, false);
    assert.equal(diagnostics.outbound.incident.activeOutboundConnection, false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('diagnostics separates current outbox summary from historical deadLetter summary', async () => {
  const bridge = createBridge();

  try {
    const nowTs = Date.now();
    bridge.connections.set('Primary:client-a', {
      accountId: 'Primary',
      connId: 'conn-a',
      clientId: 'client-a',
      connectedAt: nowTs - 10_000,
      lastSeenAt: nowTs - 1_000,
      outboundReadyUntil: nowTs + 60_000,
      preferredForOutboundUntil: nowTs + 60_000,
      pushFailureScore: 0,
    });

    const pendingOld = makeEntry('msg-summary-old', 'summary old');
    pendingOld.createdAt = 2_000;
    pendingOld.lastAttemptAt = 2_500;
    pendingOld.lastPushAt = 2_800;
    pendingOld.lastError = 'push-retry';
    const pendingNew = makeEntry('msg-summary-new', 'summary new');
    pendingNew.createdAt = 4_000;
    pendingNew.lastAttemptAt = 4_500;
    pendingNew.lastPushAt = 4_800;
    pendingNew.lastError = 'push-ack-timeout';
    const otherPending = makeEntry('msg-summary-other', 'summary other');
    otherPending.accountId = 'Other';
    bridge.outbox.set(pendingOld.messageId, pendingOld);
    bridge.outbox.set(pendingNew.messageId, pendingNew);
    bridge.outbox.set(otherPending.messageId, otherPending);

    const historicalDead = makeEntry('dead-summary-history', 'historical dead');
    historicalDead.createdAt = 1_000;
    historicalDead.lastError = 'push-retry';
    bridge.deadLetter.push(historicalDead);

    for (const [messageId, createdAt, reason] of [
      ['dead-summary-a', 3_000, 'push-retry'],
      ['dead-summary-b', 5_000, 'push-ack-timeout'],
      ['dead-summary-c', 6_000, 'push-retry'],
    ]) {
      const entry = makeEntry(messageId, messageId);
      entry.createdAt = createdAt;
      bridge.moveToDeadLetter(entry, reason);
    }

    const diagnostics = bridge.buildExtendedDiagnostics('Primary');
    assert.equal(diagnostics.outbound.pending, 2);
    assert.equal(diagnostics.outbound.pendingAllAccounts, 3);
    assert.equal(diagnostics.outbound.oldestPendingAt, 2_000);
    assert.equal(diagnostics.outbound.newestPendingAt, 4_000);
    assert.equal(diagnostics.outbound.lastAttemptAt, 4_500);
    assert.equal(diagnostics.outbound.lastPushAt, 4_800);
    assert.equal(diagnostics.outbound.lastPushError, 'push-ack-timeout');
    assert.equal(diagnostics.outbound.activeOutboundConnection, true);
    assert.equal(diagnostics.outbound.activeOutboundConnectionCount, 1);
    assert.equal(diagnostics.deadLetterSummary.total, 4);
    assert.equal(diagnostics.deadLetterSummary.allAccountsTotal, 4);
    assert.equal(diagnostics.deadLetterSummary.sinceStart, 3);
    assert.equal(diagnostics.deadLetterSummary.oldestAt, 1_000);
    assert.equal(diagnostics.deadLetterSummary.newestAt, 6_000);
    assert.deepEqual(diagnostics.deadLetterSummary.topReasons, [
      { reason: 'push-retry', count: 3 },
      { reason: 'push-ack-timeout', count: 1 },
    ]);
  } finally {
    cleanupBridge(bridge);
  }
});

test('deadLetter inspect and prune default to safe dry-run behavior', async () => {
  const bridge = createBridge();

  try {
    const keep = makeEntry('dead-keep', 'keep me');
    keep.createdAt = 1_000;
    keep.lastError = 'push-retry';
    const pruneA = makeEntry('dead-prune-a', 'prune a');
    pruneA.createdAt = 2_000;
    pruneA.lastError = 'push-ack-timeout';
    const pruneB = makeEntry('dead-prune-b', 'prune b');
    pruneB.createdAt = 3_000;
    pruneB.lastError = 'push-ack-timeout';
    const sameAccountSameMessageId = makeEntry('dead-prune-a', 'same account same message id');
    sameAccountSameMessageId.createdAt = 3_500;
    sameAccountSameMessageId.lastError = 'push-ack-timeout';
    const other = makeEntry('dead-other-account', 'other account');
    other.accountId = 'Other';
    other.createdAt = 1_500;
    other.lastError = 'push-ack-timeout';
    const otherSameMessageId = makeEntry('dead-prune-a', 'other account same message id');
    otherSameMessageId.accountId = 'Other';
    otherSameMessageId.createdAt = 2_500;
    otherSameMessageId.lastError = 'push-ack-timeout';
    bridge.deadLetter.push(
      keep,
      pruneA,
      pruneB,
      sameAccountSameMessageId,
      other,
      otherSameMessageId,
    );

    const inspectCalls = [];
    await bridge.handleDeadLetterInspect({
      params: { accountId: 'Primary', reason: 'push-ack-timeout', limit: 1 },
      respond: (...args) => inspectCalls.push(args),
    });
    assert.equal(inspectCalls[0][0], true);
    assert.equal(inspectCalls[0][1].total, 3);
    assert.equal(inspectCalls[0][1].entries.length, 1);
    assert.equal(inspectCalls[0][1].entries[0].messageId, 'dead-prune-a');
    assert.equal(inspectCalls[0][1].entries[0].createdAt, 3_500);

    const deepOffsetInspectCalls = [];
    await bridge.handleDeadLetterInspect({
      params: { accountId: 'Primary', reason: 'push-ack-timeout', limit: 1, offset: 101 },
      respond: (...args) => deepOffsetInspectCalls.push(args),
    });
    assert.equal(deepOffsetInspectCalls[0][0], true);
    assert.equal(deepOffsetInspectCalls[0][1].offset, 101);
    assert.deepEqual(deepOffsetInspectCalls[0][1].entries, []);

    const dryRunCalls = [];
    await bridge.handleDeadLetterPrune({
      params: { accountId: 'Primary', reason: 'push-ack-timeout', limit: 1 },
      respond: (...args) => dryRunCalls.push(args),
    });
    assert.equal(dryRunCalls[0][1].dryRun, true);
    assert.equal(dryRunCalls[0][1].matched, 3);
    assert.equal(dryRunCalls[0][1].wouldPrune, 1);
    assert.equal(dryRunCalls[0][1].pruned, 0);
    assert.deepEqual(summarizeDeadLetterTestEntries(bridge.deadLetter), [
      { accountId: 'Primary', messageId: 'dead-keep', createdAt: 1_000 },
      { accountId: 'Primary', messageId: 'dead-prune-a', createdAt: 2_000 },
      { accountId: 'Primary', messageId: 'dead-prune-b', createdAt: 3_000 },
      { accountId: 'Primary', messageId: 'dead-prune-a', createdAt: 3_500 },
      { accountId: 'Other', messageId: 'dead-other-account', createdAt: 1_500 },
      { accountId: 'Other', messageId: 'dead-prune-a', createdAt: 2_500 },
    ]);

    const unsafePruneCalls = [];
    await bridge.handleDeadLetterPrune({
      params: { accountId: 'Primary', dryRun: false },
      respond: (...args) => unsafePruneCalls.push(args),
    });
    assert.equal(unsafePruneCalls[0][0], false);
    assert.equal(unsafePruneCalls[0][1].ok, false);
    assert.equal(unsafePruneCalls[0][1].error, 'deadLetter-prune-requires-filter');
    assert.deepEqual(summarizeDeadLetterTestEntries(bridge.deadLetter), [
      { accountId: 'Primary', messageId: 'dead-keep', createdAt: 1_000 },
      { accountId: 'Primary', messageId: 'dead-prune-a', createdAt: 2_000 },
      { accountId: 'Primary', messageId: 'dead-prune-b', createdAt: 3_000 },
      { accountId: 'Primary', messageId: 'dead-prune-a', createdAt: 3_500 },
      { accountId: 'Other', messageId: 'dead-other-account', createdAt: 1_500 },
      { accountId: 'Other', messageId: 'dead-prune-a', createdAt: 2_500 },
    ]);

    const whitespaceOlderThanPruneCalls = [];
    await bridge.handleDeadLetterPrune({
      params: { accountId: 'Primary', olderThan: '   ', dryRun: false },
      respond: (...args) => whitespaceOlderThanPruneCalls.push(args),
    });
    assert.equal(whitespaceOlderThanPruneCalls[0][0], false);
    assert.equal(whitespaceOlderThanPruneCalls[0][1].ok, false);
    assert.equal(whitespaceOlderThanPruneCalls[0][1].error, 'deadLetter-prune-requires-filter');
    assert.deepEqual(summarizeDeadLetterTestEntries(bridge.deadLetter), [
      { accountId: 'Primary', messageId: 'dead-keep', createdAt: 1_000 },
      { accountId: 'Primary', messageId: 'dead-prune-a', createdAt: 2_000 },
      { accountId: 'Primary', messageId: 'dead-prune-b', createdAt: 3_000 },
      { accountId: 'Primary', messageId: 'dead-prune-a', createdAt: 3_500 },
      { accountId: 'Other', messageId: 'dead-other-account', createdAt: 1_500 },
      { accountId: 'Other', messageId: 'dead-prune-a', createdAt: 2_500 },
    ]);

    const pruneCalls = [];
    await bridge.handleDeadLetterPrune({
      params: { accountId: 'Primary', reason: 'push-ack-timeout', limit: 1, dryRun: false },
      respond: (...args) => pruneCalls.push(args),
    });
    assert.equal(pruneCalls[0][1].dryRun, false);
    assert.equal(pruneCalls[0][1].matched, 3);
    assert.equal(pruneCalls[0][1].wouldPrune, 1);
    assert.equal(pruneCalls[0][1].pruned, 1);
    assert.deepEqual(summarizeDeadLetterTestEntries(bridge.deadLetter), [
      { accountId: 'Primary', messageId: 'dead-keep', createdAt: 1_000 },
      { accountId: 'Primary', messageId: 'dead-prune-b', createdAt: 3_000 },
      { accountId: 'Primary', messageId: 'dead-prune-a', createdAt: 3_500 },
      { accountId: 'Other', messageId: 'dead-other-account', createdAt: 1_500 },
      { accountId: 'Other', messageId: 'dead-prune-a', createdAt: 2_500 },
    ]);
    assert.equal(bridge.outbox.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});

test('deadLetter summary logs are throttled on move and forced after real prune', async () => {
  const bridge = createBridge();

  try {
    await withConsoleCapture('log', async ({ log: logs }) => {
      bridge.moveToDeadLetter(makeEntry('dead-log-a', 'dead log a'), 'push-ack-timeout');
      bridge.moveToDeadLetter(makeEntry('dead-log-b', 'dead log b'), 'push-ack-timeout');

      const moveLogs = logs.filter((line) => line.includes('[bncr] deadLetter summary'));
      assert.equal(moveLogs.length, 1);
      assert.match(moveLogs[0], /Primary\|total=1\|/);
      assert.match(moveLogs[0], /source=move/);

      await bridge.handleDeadLetterPrune({
        params: { accountId: 'Primary', reason: 'push-ack-timeout', dryRun: false, limit: 1 },
        respond() {},
      });

      const summaryLogs = logs.filter((line) => line.includes('[bncr] deadLetter summary'));
      assert.equal(summaryLogs.length, 2);
      assert.match(summaryLogs[1], /Primary\|total=1\|/);
      assert.match(summaryLogs[1], /source=prune/);
    });
  } finally {
    cleanupBridge(bridge);
  }
});

test('rememberGatewayContext exposes current gateway context state in diagnostics', async () => {
  const bridge = createBridge();

  try {
    bridge.rememberGatewayContext({ broadcastToConnIds() {} });

    const diagnostics = bridge.buildExtendedDiagnostics('Primary');
    assert.equal(diagnostics.connection.hasGatewayContext, true);
    assert.equal(typeof diagnostics.connection.lastGatewayContextAt, 'number');
    assert.equal(diagnostics.outbound.hasGatewayContext, true);
    assert.equal(
      diagnostics.outbound.lastGatewayContextAt,
      diagnostics.connection.lastGatewayContextAt,
    );
  } finally {
    cleanupBridge(bridge);
  }
});
