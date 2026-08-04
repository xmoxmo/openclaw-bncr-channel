import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrChannelPluginBridgeGroup } from '../../src/plugin/channel-plugin-bridge-group.ts';

function createBridge() {
  const calls = [];
  const bridge = {
    channelMessageSendText(ctx) {
      calls.push(['channelMessageSendText', ctx]);
      return 'text';
    },
    channelMessageSendMedia(ctx) {
      calls.push(['channelMessageSendMedia', ctx]);
      return 'media';
    },
    channelMessageSendPayload(ctx) {
      calls.push(['channelMessageSendPayload', ctx]);
      return 'payload';
    },
    channelSendText(ctx) {
      calls.push(['channelSendText', ctx]);
      return 'sendText';
    },
    channelSendMedia(ctx) {
      calls.push(['channelSendMedia', ctx]);
      return 'sendMedia';
    },
    ensureCanonicalAgentId(args) {
      calls.push(['ensureCanonicalAgentId', args]);
      return 'orion';
    },
    resolveRouteBySession(raw, accountId) {
      calls.push(['resolveRouteBySession', raw, accountId]);
      return { userId: '10001' };
    },
    getChannelSummary(defaultAccountId) {
      calls.push(['getChannelSummary', defaultAccountId]);
      return { defaultAccountId };
    },
    getAccountRuntimeSnapshot(accountId) {
      calls.push(['getAccountRuntimeSnapshot', accountId]);
      return { accountId, connected: true };
    },
    getStatusHeadline(accountId) {
      calls.push(['getStatusHeadline', accountId]);
      return `headline:${accountId}`;
    },
    resolveVerifiedTarget(to, accountId) {
      calls.push(['resolveVerifiedTarget', to, accountId]);
      return { to, accountId };
    },
    rememberSessionRoute(sessionKey, accountId, route) {
      calls.push(['rememberSessionRoute', sessionKey, accountId, route]);
    },
    async enqueueFromReply(args) {
      calls.push(['enqueueFromReply', args]);
    },
    channelStartAccount(ctx) {
      calls.push(['channelStartAccount', ctx]);
    },
    channelStopAccount(ctx) {
      calls.push(['channelStopAccount', ctx]);
    },
    async handleDiagnostics({ params, respond }) {
      calls.push(['handleDiagnostics', params]);
      respond(true, { ok: true, accountId: params.accountId });
    },
    async handleDeadLetterInspect({ params, respond }) {
      calls.push(['handleDeadLetterInspect', params]);
      respond(true, { ok: true, accountId: params.accountId });
    },
    async handleDeadLetterPrune({ params, respond }) {
      calls.push(['handleDeadLetterPrune', params]);
      respond(true, { ok: true, accountId: params.accountId });
    },
    async callClientRpc(method, args, accountId) {
      calls.push(['callClientRpc', method, args, accountId]);
      return { ok: true, method, result: { accountId, echoed: args } };
    },
  };
  return { bridge, calls };
}

test('bridge group injects channel peer and default-account fallbacks correctly', async () => {
  const { bridge, calls } = createBridge();
  const group = createBncrChannelPluginBridgeGroup({
    channelId: 'bncr',
    defaultAccountId: 'Primary',
    getBridge: () => bridge,
  });

  assert.equal(group.getMessageSendBridge().channelMessageSendText({ hello: true }), 'text');
  assert.equal(group.getOutboundBridge().channelSendMedia({ world: true }), 'sendMedia');
  assert.equal(
    group.getMessagingBridge().ensureCanonicalAgentId({ cfg: {}, accountId: 'AccountA' }),
    'orion',
  );
  assert.deepEqual(group.getStatusBridge().getAccountRuntimeSnapshot(), {
    accountId: 'Primary',
    connected: true,
  });
  assert.equal(group.getStatusBridge().getStatusHeadline(), 'headline:Primary');
  assert.deepEqual(group.getToolActionBridge().resolveVerifiedTarget('to', 'Primary'), {
    to: 'to',
    accountId: 'Primary',
  });
  await group
    .getToolActionBridge()
    .enqueueFromReply({ accountId: 'Primary', sessionKey: 's', route: {}, payload: {} });
  group.getGatewayBridge().channelStartAccount({ accountId: 'Primary' });

  assert.deepEqual(calls[2], [
    'ensureCanonicalAgentId',
    {
      cfg: {},
      accountId: 'AccountA',
      channelId: 'bncr',
      peer: { kind: 'direct', id: 'AccountA' },
    },
  ]);
  assert.deepEqual(calls[3], ['getAccountRuntimeSnapshot', 'Primary']);
  assert.deepEqual(calls[4], ['getStatusHeadline', 'Primary']);
});

test('bridge group forwards every surface through the current bridge instance', async () => {
  const { bridge, calls } = createBridge();
  const group = createBncrChannelPluginBridgeGroup({
    channelId: 'bncr',
    defaultAccountId: 'Primary',
    getBridge: () => bridge,
  });

  assert.equal(group.getMessageSendBridge().channelMessageSendPayload({ id: 1 }), 'payload');
  assert.equal(group.getOutboundBridge().channelSendText({ id: 2 }), 'sendText');
  assert.deepEqual(group.getMessagingBridge().resolveRouteBySession('session-1', 'Primary'), {
    userId: '10001',
  });
  group.getGatewayBridge().channelStopAccount({ accountId: 'Primary' });

  assert.deepEqual(calls[0], ['channelMessageSendPayload', { id: 1 }]);
  assert.deepEqual(calls[1], ['channelSendText', { id: 2 }]);
});

test('bridge group routes bridge calls through client RPC', async () => {
  const { bridge, calls } = createBridge();
  const group = createBncrChannelPluginBridgeGroup({
    channelId: 'bncr',
    defaultAccountId: 'Primary',
    getBridge: () => bridge,
  });

  const result = await group.getBridgeCallBridge().call('client.ping', { echo: true }, 'Primary');

  assert.deepEqual(result, {
    ok: true,
    method: 'client.ping',
    result: { accountId: 'Primary', echoed: { echo: true } },
  });
  assert.deepEqual(calls[0], ['callClientRpc', 'client.ping', { echo: true }, 'Primary']);
});

test('bridge group routes local diagnostics methods through plugin handlers', async () => {
  const { bridge, calls } = createBridge();
  const group = createBncrChannelPluginBridgeGroup({
    channelId: 'bncr',
    defaultAccountId: 'Primary',
    getBridge: () => bridge,
  });

  const result = await group
    .getBridgeCallBridge()
    .call('bncr.diagnostics', { accountId: 'Primary' });

  assert.deepEqual(result, {
    ok: true,
    method: 'bncr.diagnostics',
    result: { ok: true, accountId: 'Primary' },
  });
  assert.deepEqual(calls[0], ['handleDiagnostics', { accountId: 'Primary' }]);
});

test('bridge call forwards any dynamic method and rejects empty method', async () => {
  const { bridge } = createBridge();
  const group = createBncrChannelPluginBridgeGroup({
    channelId: 'bncr',
    defaultAccountId: 'Primary',
    getBridge: () => bridge,
  });

  const result = await group.getBridgeCallBridge().call('bncr.client.newMethod', { a: 1 });
  assert.equal(result.method, 'bncr.client.newMethod');

  await assert.rejects(() => group.getBridgeCallBridge().call('', {}), /bridge method is required/);
});
