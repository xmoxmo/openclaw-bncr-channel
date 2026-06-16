import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrDiagnosticsHandlers } from '../../src/plugin/diagnostics-handlers.ts';

function createRuntime() {
  const calls = { replace: [], save: 0, logSummary: [] };
  const dead = [
    {
      accountId: 'Primary',
      messageId: 'd1',
      createdAt: 1,
      lastError: 'fatal-a',
      sessionKey: 'session-1',
      route: { platform: 'tgBot', groupId: '0', userId: '10001' },
      payload: { text: 'a' },
      retryCount: 0,
      nextAttemptAt: 1,
    },
    {
      accountId: 'Primary',
      messageId: 'd2',
      createdAt: 2,
      lastError: 'fatal-b',
      sessionKey: 'session-2',
      route: { platform: 'tgBot', groupId: '0', userId: '10002' },
      payload: { text: 'b' },
      retryCount: 0,
      nextAttemptAt: 2,
    },
  ];
  return {
    runtime: {
      getApi: () => ({ runtime: { config: { current: () => ({ channels: { bncr: {} } }) } } }),
      channelId: 'bncr',
      asString: (value, fallback = '') =>
        typeof value === 'string' ? value : value == null ? fallback : String(value),
      now: () => 100,
      countInvalidOutboxSessionKeys: () => 1,
      countLegacyAccountResidue: () => 2,
      buildRuntimeStatusInput: (accountId, overrides) => ({
        accountId,
        running: overrides.running,
        channelRoot: '/tmp/bncr',
      }),
      getAccountRuntimeSnapshot: () => ({ connected: true }),
      buildIntegratedDiagnostics: () => ({ health: { ok: true } }),
      buildExtendedDiagnostics: () => ({ extended: true }),
      buildDownlinkHealth: () => ({ status: 'ok' }),
      buildRuntimeFlags: () => ({ debugVerbose: false }),
      activeConnectionCount: () => 1,
      getMessageAckWaiterCount: () => 2,
      getFileAckWaiterCount: () => 3,
      filterDeadLetterEntries: ({ accountId, reason }) =>
        dead.filter(
          (entry) => entry.accountId === accountId && (!reason || entry.lastError === reason),
        ),
      listDeadLetterEntries: () => dead.slice(),
      buildDeadLetterDiagnostics: () => ({
        total: dead.length,
        allAccountsTotal: dead.length,
        sinceStart: dead.length,
        cappedAt: 10,
        topReasons: [],
      }),
      replaceDeadLetterEntries(next) {
        calls.replace.push(next);
      },
      scheduleSave() {
        calls.save += 1;
      },
      logDeadLetterSummary(accountId, args) {
        calls.logSummary.push([accountId, args]);
      },
    },
    calls,
  };
}

test('diagnostics handlers build diagnostics payload and destructive prune path', async () => {
  const { runtime, calls } = createRuntime();
  const handlers = createBncrDiagnosticsHandlers(runtime);
  const responses = [];

  await handlers.handleDiagnostics({
    params: { accountId: 'Primary' },
    respond: (ok, payload) => responses.push([ok, payload]),
  });
  await handlers.handleDeadLetterPrune({
    params: { accountId: 'Primary', reason: 'fatal-a', dryRun: false },
    respond: (ok, payload) => responses.push([ok, payload]),
  });

  assert.equal(responses[0][0], true);
  assert.equal(responses[0][1].accountId, 'Primary');
  assert.equal(responses[1][1].pruned, 1);
  assert.equal(calls.replace.length, 1);
  assert.equal(calls.save, 1);
  assert.deepEqual(calls.logSummary[0], ['Primary', { force: true, source: 'prune' }]);
});
