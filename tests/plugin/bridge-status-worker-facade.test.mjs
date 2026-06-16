import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridgeStatusWorkerFacade } from '../../src/plugin/bridge-status-worker-facade.ts';

test('bridge status-worker facade builds worker hooks from bridge-owned maps and delegates logs', () => {
  const calls = { info: [], dedup: [] };
  const workers = new Map();
  const facade = createBncrBridgeStatusWorkerFacade({
    workers,
    bridgeId: 'bridge-1',
    isOnline: (accountId) => accountId === 'Primary',
    hasRecentInboundReachability: () => true,
    lastActivityByAccount: new Map([['Primary', 30]]),
    lastInboundByAccount: new Map([['Primary', 20]]),
    lastOutboundByAccount: new Map([['Primary', 10]]),
    getActiveConnectionKey: () => 'Primary:conn-1',
    connectionsValues: () =>
      [
        { accountId: 'Primary', connId: 'conn-1', clientId: 'c1', connectedAt: 1, lastSeenAt: 2 },
      ].values(),
    buildStatusMeta: (accountId) => ({ accountId, kind: 'meta' }),
    logInfo: (...args) => calls.info.push(args),
    logInfoDedup: (...args) => calls.dedup.push(args),
  });

  assert.equal(facade.bridgeId, 'bridge-1');
  assert.equal(facade.workers, workers);
  assert.equal(facade.hooks.isOnline('Primary'), true);
  assert.equal(facade.hooks.hasRecentInboundReachability('Primary'), true);
  assert.equal(facade.hooks.getLastActivityAt('Primary', { lastEventAt: 5 }), 30);
  assert.equal(facade.hooks.getActiveConnectionKey('Primary'), 'Primary:conn-1');
  assert.deepEqual(facade.hooks.getActiveConnections('Primary'), [
    {
      connId: 'conn-1',
      clientId: 'c1',
      inboundOnly: false,
      outboundReady: false,
      preferredForOutbound: false,
    },
  ]);
  assert.deepEqual(facade.hooks.buildStatusMeta('Primary'), { accountId: 'Primary', kind: 'meta' });

  facade.hooks.logInfo('health', 'tick', { debugOnly: true });
  facade.hooks.logInfoDedup('health', 'tick', { key: 'k', sig: 's' });

  assert.equal(calls.info.length, 1);
  assert.equal(calls.dedup.length, 1);
});
