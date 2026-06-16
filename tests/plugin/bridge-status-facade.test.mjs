import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBncrAckDiagnosticsRuntime,
  buildBncrStatusProjectionRuntime,
  createBncrBridgeStatusFacade,
} from '../../src/plugin/bridge-status-facade.ts';

test('bridge status facade preserves runtime projection outputs and default runtime snapshot input', () => {
  const calls = [];
  const facade = createBncrBridgeStatusFacade({
    statusProjection: buildBncrStatusProjectionRuntime({
      buildRuntimeStatusInput(accountId, overrides) {
        calls.push(['buildRuntimeStatusInput', accountId, overrides]);
        return { accountId, ...overrides };
      },
      buildStatusMeta(accountId) {
        return { accountId, kind: 'meta' };
      },
      getAccountRuntimeSnapshot(accountId, runtimeStatusInput) {
        return { accountId, runtimeStatusInput };
      },
      buildStatusHeadline(accountId) {
        return `headline:${accountId}`;
      },
      getStatusHeadline(accountId) {
        return `status:${accountId}`;
      },
      getChannelSummary(defaultAccountId) {
        return { defaultAccountId };
      },
    }),
    ackDiagnostics: buildBncrAckDiagnosticsRuntime({
      buildRuntimeAckObservability(accountId) {
        return { accountId, kind: 'ack-observability' };
      },
      buildRuntimeAckStrategy(ackObservability) {
        return { kind: 'ack-strategy', ackObservability };
      },
    }),
  });

  assert.deepEqual(facade.buildRuntimeStatusInput('Primary', { running: false }), {
    accountId: 'Primary',
    running: false,
  });
  assert.deepEqual(facade.buildStatusMeta('Primary'), { accountId: 'Primary', kind: 'meta' });
  assert.deepEqual(facade.getAccountRuntimeSnapshot('Primary'), {
    accountId: 'Primary',
    runtimeStatusInput: { accountId: 'Primary', running: true },
  });
  assert.equal(facade.buildStatusHeadline('Primary'), 'headline:Primary');
  assert.equal(facade.getStatusHeadline('Primary'), 'status:Primary');
  assert.deepEqual(facade.getChannelSummary('Primary'), { defaultAccountId: 'Primary' });
  assert.deepEqual(facade.buildRuntimeAckObservability('Primary'), {
    accountId: 'Primary',
    kind: 'ack-observability',
  });
  assert.deepEqual(facade.buildRuntimeAckStrategy({ accountId: 'Primary' }), {
    kind: 'ack-strategy',
    ackObservability: { accountId: 'Primary' },
  });

  assert.deepEqual(calls, [
    ['buildRuntimeStatusInput', 'Primary', { running: false }],
    ['buildRuntimeStatusInput', 'Primary', { running: true }],
  ]);
});
