import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridgeConnectionFacade } from '../../src/plugin/bridge-connection-facade.ts';

test('bridge connection facade preserves route reachability adoption and gateway bookkeeping delegation', () => {
  const calls = { remember: [], markActivity: [], refresh: [], refreshFile: [] };
  const facade = createBncrBridgeConnectionFacade({
    now: () => 100,
    asString: (value, fallback = '') =>
      typeof value === 'string' ? value : value == null ? fallback : String(value),
    normalizeAccountId: (accountId) => String(accountId || '').trim(),
    connectionState: {
      hasRecentInboundReachability: () => true,
      resolveRecentInboundConnIds: () => new Set(['conn-1']),
      isRecentlyReachableConn: (_accountId, connId) => connId === 'conn-1',
      isRevalidatedAttemptedConn: (entry, connId) =>
        entry.messageId === 'm1' && connId === 'conn-1',
      tryAdoptTransferOwner(args) {
        return args.connId === 'conn-1';
      },
      refreshLiveConnectionState(args) {
        calls.refresh.push(args);
      },
      refreshAcceptedFileTransferLiveState(args) {
        calls.refreshFile.push(args);
      },
    },
    outboxRoute: {
      resolveOutboxPushOwner: () => ({
        connId: 'conn-1',
        clientId: 'client-1',
        accountId: 'Primary',
      }),
      resolvePushConnIds: () => new Set(['conn-1']),
    },
    rememberGatewayContext(context) {
      calls.remember.push(context);
    },
    markActivity(accountId, at) {
      calls.markActivity.push([accountId, at]);
    },
  });

  assert.equal(facade.resolveOutboxPushOwner('Primary')?.connId, 'conn-1');
  assert.deepEqual([...facade.resolvePushConnIds('Primary')], ['conn-1']);
  assert.equal(facade.hasRecentInboundReachability('Primary'), true);
  assert.equal(facade.isRecentlyReachableConn('Primary', 'conn-1'), true);
  assert.equal(facade.isRevalidatedAttemptedConn({ messageId: 'm1' }, 'conn-1'), true);
  assert.equal(
    facade.tryAdoptTransferOwner({ accountId: 'Primary', transfer: undefined, connId: 'conn-1' }),
    true,
  );
  assert.equal(facade.isRetryableFileTransferError(new Error('chunk ack timeout')), true);
  assert.equal(facade.isRetryableFileTransferError(new Error('permission denied')), false);

  facade.rememberGatewayContext({ test: true });
  facade.refreshLiveConnectionState({
    accountId: 'Primary',
    connId: 'conn-1',
    outboundReady: true,
    preferredForOutbound: true,
    inboundOnly: false,
    context: { test: true },
  });
  facade.refreshAcceptedFileTransferLiveState({
    accountId: 'Primary',
    connId: 'conn-1',
    context: { test: true },
  });
  facade.markActivity('Primary');

  assert.equal(calls.remember.length, 1);
  assert.equal(calls.refresh.length, 1);
  assert.equal(calls.refreshFile.length, 1);
  assert.deepEqual(calls.markActivity, [['Primary', 100]]);
});
