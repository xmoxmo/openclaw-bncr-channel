import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridgeCallBridge } from '../../src/plugin/bridge-call.ts';

function makeRecentOutboundBridge() {
  const entries = Array.from({ length: 60 }, (_, index) => ({
    messageId: `recent-${index + 1}`,
    accountId: 'Primary',
    sessionKey: 'session-1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    text: `recent ${index + 1}`,
    createdAt: index + 1,
    status: 'acked',
  }));
  return {
    listRecentOutbound: (sessionKey) => (sessionKey === 'session-1' ? entries : []),
    listRecentOutboundByAccount: (accountId) => (accountId === 'Primary' ? entries : []),
  };
}

test('bridge call returns all recent outbound entries without a limit', async () => {
  const bridge = createBncrBridgeCallBridge({
    defaultAccountId: 'Primary',
    getStatusBridge: () => ({
      getChannelSummary: async () => ({}),
      getAccountRuntimeSnapshot: () => ({}),
      getStatusHeadline: () => '',
    }),
    getDiagnosticsBridge: () => ({
      diagnostics: async () => ({}),
      deadLetterInspect: async () => ({}),
      deadLetterPrune: async () => ({}),
    }),
    getRecentOutboundBridge: makeRecentOutboundBridge,
    callClientRpc: async () => {
      throw new Error('unexpected client RPC call');
    },
  });

  const result = await bridge.call('bncr.outbound.recent', {
    sessionKey: 'session-1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.total, 60);
  assert.equal(result.result.entries.length, 60);
  assert.equal(result.result.entries[0].messageId, 'recent-1');
  assert.equal(result.result.entries[59].messageId, 'recent-60');
});

test('bridge call honors an explicit recent outbound query limit', async () => {
  const bridge = createBncrBridgeCallBridge({
    defaultAccountId: 'Primary',
    getStatusBridge: () => ({
      getChannelSummary: async () => ({}),
      getAccountRuntimeSnapshot: () => ({}),
      getStatusHeadline: () => '',
    }),
    getDiagnosticsBridge: () => ({
      diagnostics: async () => ({}),
      deadLetterInspect: async () => ({}),
      deadLetterPrune: async () => ({}),
    }),
    getRecentOutboundBridge: makeRecentOutboundBridge,
    callClientRpc: async () => {
      throw new Error('unexpected client RPC call');
    },
  });

  const result = await bridge.call('bncr.outbound.recent', {
    sessionKey: 'session-1',
    limit: 3,
  });

  assert.equal(result.result.limit, 3);
  assert.equal(result.result.total, 60);
  assert.equal(result.result.entries.length, 3);
  assert.deepEqual(
    result.result.entries.map((entry) => entry.messageId),
    ['recent-1', 'recent-2', 'recent-3'],
  );
});
