import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrChannelPluginSurfaceGroup } from '../../src/plugin/channel-plugin-surface-group.ts';

function createRuntime(overrides = {}) {
  return {
    channelId: 'bncr',
    getMessageSendBridge: () => ({
      channelMessageSendText() {},
      channelMessageSendMedia() {},
      channelMessageSendPayload() {},
    }),
    getOutboundBridge: () => ({
      channelSendText() {},
      channelSendMedia() {},
    }),
    getMessagingBridge: () => ({
      canonicalAgentId: undefined,
      ensureCanonicalAgentId() {
        return 'orion';
      },
      resolveRouteBySession() {
        return null;
      },
    }),
    getStatusBridge: () => ({
      getChannelSummary() {
        return {};
      },
      getAccountRuntimeSnapshot(accountId) {
        return { accountId, connected: accountId === 'Primary' };
      },
      getStatusHeadline() {
        return 'ok';
      },
    }),
    getToolActionBridge: () => ({
      resolveVerifiedTarget() {
        return { route: { platform: 'tgBot', userId: '10001' } };
      },
      rememberSessionRoute() {},
      async enqueueFromReply() {},
    }),
    getGatewayBridge: () => ({
      channelStartAccount() {},
      channelStopAccount() {},
    }),
    channelMeta: {
      id: 'bncr',
      label: 'bncr',
      selectionLabel: 'bncr',
      docsPath: '/docs',
      blurb: 'test',
    },
    channelCapabilities: {
      chatTypes: ['direct', 'group'],
      media: true,
      reply: true,
      nativeCommands: true,
    },
    gatewayMethods: [],
    configSurface: {},
    setupSurface: {},
    extractToolSend(args, action) {
      if (args.to && action === 'sendMessage') return { to: args.to, message: args.message };
      return null;
    },
    openClawJsonResult(payload) {
      return payload;
    },
    ...overrides,
  };
}

test('describeMessageTool returns null when no enabled account and no connected runtime', () => {
  const { messageActions } = createBncrChannelPluginSurfaceGroup(
    createRuntime({
      getStatusBridge: () => ({
        getChannelSummary() {
          return {};
        },
        getAccountRuntimeSnapshot() {
          return { connected: false };
        },
        getStatusHeadline() {
          return 'down';
        },
      }),
    }),
  );

  assert.equal(messageActions.describeMessageTool({ cfg: { channels: { bncr: {} } } }), null);
});

test('supportsAction only accepts send and extractToolSend normalizes invalid args to null', () => {
  const { messageActions } = createBncrChannelPluginSurfaceGroup(createRuntime());

  assert.equal(messageActions.supportsAction({ action: 'send' }), true);
  assert.equal(messageActions.supportsAction({ action: 'delete' }), false);
  assert.equal(messageActions.extractToolSend({ args: null }), null);
  assert.deepEqual(
    messageActions.extractToolSend({ args: { to: 'Bncr:tgBot:10001', message: 'hi' } }),
    {
      to: 'Bncr:tgBot:10001',
      message: 'hi',
    },
  );
});

test('handleAction rejects unsupported action before send path', async () => {
  const { messageActions } = createBncrChannelPluginSurfaceGroup(createRuntime());

  await assert.rejects(
    () => messageActions.handleAction({ action: 'delete', params: {}, accountId: 'Primary' }),
    /Action delete is not supported/,
  );
});

test('plugin surface exposes stable messaging status gateway and message send surfaces', async () => {
  const { plugin } = createBncrChannelPluginSurfaceGroup(createRuntime());

  assert.equal(plugin.id, 'bncr');
  assert.equal(typeof plugin.message.send.text, 'function');
  assert.equal(typeof plugin.message.send.media, 'function');
  assert.equal(typeof plugin.message.send.payload, 'function');
  assert.equal(typeof plugin.messaging.parseExplicitTarget, 'function');
  assert.equal(typeof plugin.messaging.resolveOutboundSessionRoute, 'function');
  assert.equal(typeof plugin.status.buildAccountSnapshot, 'function');
  assert.equal(typeof plugin.gateway.startAccount, 'function');
  assert.equal(typeof plugin.gateway.stopAccount, 'function');
});
