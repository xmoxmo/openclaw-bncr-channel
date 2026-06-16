import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridgeDiagnosticsFacade } from '../../src/plugin/bridge-diagnostics-facade.ts';

test('bridge diagnostics facade delegates status projections consistently', () => {
  const calls = [];
  const facade = createBncrBridgeDiagnosticsFacade({
    buildRuntimeFlags(accountId) {
      calls.push(['flags', accountId]);
      return { accountId, enabled: true };
    },
    buildAccountQueueCounters(accountId) {
      calls.push(['queue', accountId]);
      return { accountId, pending: 1 };
    },
    buildIntegratedDiagnostics(accountId, runtimeStatusInput) {
      calls.push(['integrated', accountId, runtimeStatusInput]);
      return { accountId, runtimeStatusInput };
    },
    buildDownlinkHealth(accountId) {
      calls.push(['downlink', accountId]);
      return { accountId, health: 'ok' };
    },
  });

  assert.deepEqual(facade.buildRuntimeFlags('a1'), { accountId: 'a1', enabled: true });
  assert.deepEqual(facade.buildAccountQueueCounters('a1'), { accountId: 'a1', pending: 1 });
  assert.deepEqual(facade.buildIntegratedDiagnostics('a1', { running: true }), {
    accountId: 'a1',
    runtimeStatusInput: { running: true },
  });
  assert.deepEqual(facade.buildDownlinkHealth('a1'), { accountId: 'a1', health: 'ok' });
  assert.deepEqual(calls, [
    ['flags', 'a1'],
    ['queue', 'a1'],
    ['integrated', 'a1', { running: true }],
    ['downlink', 'a1'],
  ]);
});
