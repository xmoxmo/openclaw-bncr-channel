import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrOutboxPushRouteRuntimeGroup } from '../../src/plugin/outbox-push-route-runtime-group.ts';

test('outbox push-route runtime group composes routing and push helpers', () => {
  const pushes = [];
  const successes = [];
  const connections = new Map([
    [
      'Primary:client-1',
      {
        accountId: 'Primary',
        connId: 'conn-1',
        clientId: 'client-1',
        connectedAt: 1,
        lastSeenAt: 100,
        outboundReadyUntil: 200,
        preferredForOutboundUntil: 200,
      },
    ],
  ]);
  const group = createBncrOutboxPushRouteRuntimeGroup({
    bridgeId: 'bridge-1',
    pushEvent: 'push',
    now: () => 100,
    connectTtlMs: 60_000,
    finiteNumberOr: (value, fallback) =>
      Number.isFinite(Number(value)) ? Number(value) : fallback,
    outboxSize: () => 1,
    gatewayBroadcastToConnIds(event, payload, connIds) {
      pushes.push([event, payload, [...connIds]]);
    },
    recordOutboxPushSuccess(args) {
      successes.push(args);
    },
    recordOutboxPushFailure() {},
    recordOutboxPrePushFailure() {},
    recordPrePushGuardSkip() {},
    moveToDeadLetter() {},
    activeConnectionCount: () => 1,
    connections,
    connectionsValues: () => connections.values(),
    activeConnectionByAccount: new Map([['Primary', 'Primary:client-1']]),
    resolveRecentInboundConnIds: () => new Set(['conn-1']),
    connectionKey: (accountId, clientId) => `${accountId}:${clientId}`,
    isRetryableFileTransferError: () => true,
    logInfo() {},
    buildActiveConnectionDebugList: () => [],
  });
  const owner = group.outboxRoute.resolveOutboxPushOwner('Primary');
  const connIds = group.outboxRoute.resolvePushConnIds('Primary');
  group.outboxPush.pushTextSuccessPath({
    entry: {
      messageId: 'msg-1',
      accountId: 'Primary',
      sessionKey: 'session-1',
      route: { platform: 'tgBot', groupId: '0', userId: '10001' },
      payload: { text: 'hello' },
      createdAt: 1,
      retryCount: 0,
      nextAttemptAt: 1,
    },
    owner,
    connIds,
    recentInboundReachable: true,
    routeReason: 'preferred',
    ownerConnId: 'conn-1',
  });

  assert.equal(owner?.connId, 'conn-1');
  assert.deepEqual([...connIds], ['conn-1']);
  assert.equal(pushes.length, 1);
  assert.equal(successes.length, 1);
});
