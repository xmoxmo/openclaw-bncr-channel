import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridgeFileTransferPushFacade } from '../../src/plugin/bridge-file-transfer-push-facade.ts';

test('bridge file-transfer push facade preserves success broadcast and failure delegation', async () => {
  const calls = { broadcast: [], route: [], success: [], ok: [], fail: [], guard: [] };
  const facade = createBncrBridgeFileTransferPushFacade({
    pushEvent: 'plugin.bncr.push',
    getGatewayContext: () => ({
      broadcastToConnIds(event, payload, connIds) {
        calls.broadcast.push([event, payload, [...connIds]]);
      },
    }),
    transferMediaToBncrClient: async () => ({
      mode: 'chunk',
      fileName: 'a.bin',
      path: '/tmp/a.bin',
    }),
    buildFileTransferOutboundFrame: ({ mediaUrl }) => ({ mediaUrl, mode: 'chunk' }),
    logOutboxRouteSelect(args) {
      calls.route.push(args);
    },
    recordOutboxPushSuccess(args) {
      calls.success.push(args);
    },
    logOutboxPushOkSummary(messageId) {
      calls.ok.push(['summary', messageId]);
    },
    logOutboxPushOk(args) {
      calls.ok.push(['detail', args]);
    },
    handleFileTransferPushFailure(args) {
      calls.fail.push(args);
    },
    handleFileTransferPushGuardFailure(args) {
      calls.guard.push(args);
    },
  });

  const entry = {
    messageId: 'm1',
    accountId: 'Primary',
    sessionKey: 's1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: 'hello' },
    retryCount: 0,
    nextAttemptAt: 1,
    createdAt: 1,
  };

  await facade.pushFileTransferSuccessPath({
    entry,
    meta: { mediaUrl: 'https://example.com/a.bin' },
    owner: { connId: 'conn-1', clientId: 'client-1', accountId: 'Primary' },
    connIds: ['conn-1'],
    recentInboundReachable: true,
    routeReason: 'preferred',
    mediaUrl: 'https://example.com/a.bin',
  });

  facade.handleFileTransferPushFailure({ entry, error: new Error('x') });
  facade.handleFileTransferPushGuardFailure({
    entry,
    guard: { reason: 'no-gateway-context', lastError: 'gateway context unavailable' },
  });

  assert.equal(calls.broadcast.length, 1);
  assert.equal(calls.route.length, 1);
  assert.equal(calls.success.length, 1);
  assert.equal(calls.ok.length, 2);
  assert.equal(calls.fail.length, 1);
  assert.equal(calls.guard.length, 1);
});
