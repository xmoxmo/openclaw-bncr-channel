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
    getBridgeCallBridge: () => ({
      async call(method, args) {
        return { ok: true, method, args };
      },
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

test('supportsAction accepts send/delete/unsend and extractToolSend normalizes invalid args to null', () => {
  const { messageActions } = createBncrChannelPluginSurfaceGroup(createRuntime());

  assert.equal(messageActions.supportsAction({ action: 'send' }), true);
  assert.equal(messageActions.supportsAction({ action: 'delete' }), true);
  assert.equal(messageActions.supportsAction({ action: 'unsend' }), true);
  assert.equal(messageActions.supportsAction({ action: 'edit' }), false);
  assert.equal(messageActions.extractToolSend({ args: null }), null);
  assert.deepEqual(
    messageActions.extractToolSend({ args: { to: 'Bncr:tgBot:0:10001', message: 'hi' } }),
    {
      to: 'Bncr:tgBot:0:10001',
      message: 'hi',
    },
  );
});

test('describeMessageTool exposes current-channel schema for structured outbound params', () => {
  const { messageActions } = createBncrChannelPluginSurfaceGroup(createRuntime());

  const discovery = messageActions.describeMessageTool({
    cfg: { channels: { bncr: {} } },
  });

  assert.ok(discovery);
  assert.deepEqual(discovery.actions, ['send', 'delete', 'unsend']);
  assert.deepEqual(discovery.schema?.visibility, 'current-channel');
  assert.deepEqual(Object.keys(discovery.schema?.properties ?? {}).sort(), [
    'bridgeMethod',
    'downloadMedia',
    'extra',
    'type',
  ]);
  assert.equal(discovery.schema?.properties?.bridgeMethod.type, 'string');
  assert.equal(discovery.schema?.properties?.extra.type, 'object');
  assert.equal(typeof discovery.schema?.properties?.extra.patternProperties, 'object');
  assert.equal(discovery.schema?.properties?.type.type, 'string');
  assert.equal(discovery.schema?.properties?.downloadMedia.type, 'boolean');
});

test('handleAction forwards structured extra/type/downloadMedia into outbound bridge', async () => {
  const calls = [];
  const { messageActions } = createBncrChannelPluginSurfaceGroup(
    createRuntime({
      getOutboundBridge: () => ({
        channelSendText: async (ctx) => {
          calls.push(ctx);
          return { ok: true, messageId: 'm1' };
        },
        channelSendMedia: async () => {},
      }),
    }),
  );

  const result = await messageActions.handleAction({
    action: 'send',
    accountId: 'Primary',
    params: {
      to: 'Bncr:tgBot:0:10001',
      message: 'hello',
      extra: { customBadge: 'VIP' },
      type: 'appmsg',
      downloadMedia: true,
    },
  });

  assert.deepEqual(result, { ok: true, messageId: 'm1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'hello');
  assert.deepEqual(calls[0].extra, { customBadge: 'VIP' });
  assert.equal(calls[0].type, 'appmsg');
  assert.equal(calls[0].downloadMedia, true);
});

test('handleAction bridgeMethod calls the bridge with extra args without sending', async () => {
  const calls = [];
  const { messageActions } = createBncrChannelPluginSurfaceGroup(
    createRuntime({
      getOutboundBridge: () => ({
        channelSendText: async (ctx) => {
          calls.push(['send', ctx]);
          return { ok: true, messageId: 'm1' };
        },
        channelSendMedia: async () => {},
      }),
      getBridgeCallBridge: () => ({
        async call(method, args) {
          calls.push(['bridge', method, args]);
          return { ok: true, method, result: { accountId: args.accountId } };
        },
      }),
    }),
  );

  const result = await messageActions.handleAction({
    action: 'send',
    params: {
      bridgeMethod: 'bncr.status.account',
      extra: { accountId: 'Primary' },
    },
  });

  assert.deepEqual(result, {
    ok: true,
    method: 'bncr.status.account',
    result: { accountId: 'Primary' },
  });
  assert.deepEqual(calls, [['bridge', 'bncr.status.account', { accountId: 'Primary' }]]);
});

test('handleAction bridgeMethod forwards generic adapter calls without per-method registration', async () => {
  const calls = [];
  const { messageActions } = createBncrChannelPluginSurfaceGroup(
    createRuntime({
      getBridgeCallBridge: () => ({
        async call(method, args) {
          calls.push([method, args]);
          return { ok: true, method, result: { handled: true } };
        },
      }),
    }),
  );

  const result = await messageActions.handleAction({
    action: 'send',
    params: {
      bridgeMethod: 'bncr.client.adapters.call',
      extra: {
        from: 'GewePlus',
        method: 'inlinemask',
        msgInfo: { groupId: '-1001', userId: '0' },
        info: { groupId: '-1001', userId: '0', msg: 'hello' },
      },
    },
  });

  assert.deepEqual(result, {
    ok: true,
    method: 'bncr.client.adapters.call',
    result: { handled: true },
  });
  assert.deepEqual(calls, [
    [
      'bncr.client.adapters.call',
      {
        from: 'GewePlus',
        method: 'inlinemask',
        msgInfo: { groupId: '-1001', userId: '0' },
        info: { groupId: '-1001', userId: '0', msg: 'hello' },
        accountId: 'Primary',
      },
    ],
  ]);
});

test('handleAction bridgeMethod forwards contactinfo adapter calls for avatar lookup', async () => {
  const calls = [];
  const { messageActions } = createBncrChannelPluginSurfaceGroup(
    createRuntime({
      getBridgeCallBridge: () => ({
        async call(method, args) {
          calls.push([method, args]);
          return {
            ok: true,
            method,
            result: {
              ok: true,
              method: 'contactinfo',
              from: 'GolemPlus',
              result: [
                {
                  uname: 'wxid_xxx',
                  nname: 'Xiaomo',
                  bhead: 'https://example.invalid/big.png',
                  shead: 'https://example.invalid/small.png',
                },
              ],
            },
          };
        },
      }),
    }),
  );

  const result = await messageActions.handleAction({
    action: 'send',
    params: {
      bridgeMethod: 'bncr.client.adapters.call',
      extra: {
        from: 'GolemPlus',
        method: 'contactinfo',
        info: {
          userId: 'wxid_xxx',
          groupId: '12345',
        },
      },
    },
  });

  assert.deepEqual(result, {
    ok: true,
    method: 'bncr.client.adapters.call',
    result: {
      ok: true,
      method: 'contactinfo',
      from: 'GolemPlus',
      result: [
        {
          uname: 'wxid_xxx',
          nname: 'Xiaomo',
          bhead: 'https://example.invalid/big.png',
          shead: 'https://example.invalid/small.png',
        },
      ],
    },
  });
  assert.deepEqual(calls, [
    [
      'bncr.client.adapters.call',
      {
        from: 'GolemPlus',
        method: 'contactinfo',
        info: {
          userId: 'wxid_xxx',
          groupId: '12345',
        },
        accountId: 'Primary',
      },
    ],
  ]);
});

test('handleAction rejects unknown bridge methods without entering send path', async () => {
  let sendCalled = false;
  const { messageActions } = createBncrChannelPluginSurfaceGroup(
    createRuntime({
      getOutboundBridge: () => ({
        channelSendText: async () => {
          sendCalled = true;
          return { ok: true, messageId: 'm1' };
        },
        channelSendMedia: async () => {},
      }),
      getBridgeCallBridge: () => ({
        async call(method) {
          throw new Error(`Unsupported bncr bridge method "${method}".`);
        },
      }),
    }),
  );

  await assert.rejects(
    () =>
      messageActions.handleAction({
        action: 'send',
        params: { bridgeMethod: 'bncr.not-real' },
      }),
    /Unsupported bncr bridge method/,
  );
  assert.equal(sendCalled, false);
});

test('handleAction delete calls generic adapter bridge with delMsg', async () => {
  const calls = [];
  const { messageActions } = createBncrChannelPluginSurfaceGroup(
    createRuntime({
      getToolActionBridge: () => ({
        resolveVerifiedTarget(to, accountId) {
          calls.push(['resolveVerifiedTarget', to, accountId]);
          return {
            route: { platform: 'GewePlus', groupId: '-1001', userId: '0' },
          };
        },
        rememberSessionRoute() {},
        async enqueueFromReply() {},
      }),
      getBridgeCallBridge: () => ({
        async call(method, args) {
          calls.push(['bridge', method, args]);
          return { ok: true, method, result: { deleted: true } };
        },
      }),
    }),
  );

  const result = await messageActions.handleAction({
    action: 'delete',
    params: {
      to: 'Bncr:GewePlus:-1001:0',
      messageId: 'openclaw-message-1',
    },
    accountId: 'Primary',
  });

  assert.deepEqual(result, {
    ok: true,
    method: 'bncr.client.adapters.call',
    result: { deleted: true },
  });
  assert.deepEqual(calls[0], ['resolveVerifiedTarget', 'Bncr:GewePlus:-1001:0', 'Primary']);
  assert.deepEqual(calls[1], [
    'bridge',
    'bncr.client.adapters.call',
    {
      msgInfo: { groupId: '-1001', userId: '0' },
      from: 'GewePlus',
      method: 'delMsg',
      messageId: 'openclaw-message-1',
    },
  ]);
});

test('handleAction unsend supports snake_case message_id', async () => {
  const calls = [];
  const { messageActions } = createBncrChannelPluginSurfaceGroup(
    createRuntime({
      getToolActionBridge: () => ({
        resolveVerifiedTarget() {
          return { route: { platform: 'tgBot', groupId: '0', userId: '10001' } };
        },
        rememberSessionRoute() {},
        async enqueueFromReply() {},
      }),
      getBridgeCallBridge: () => ({
        async call(method, args) {
          calls.push([method, args]);
          return { ok: true, method };
        },
      }),
    }),
  );

  await messageActions.handleAction({
    action: 'unsend',
    params: { to: 'Bncr:tgBot:0:10001', message_id: 'm-42' },
    accountId: 'Primary',
  });

  assert.equal(calls[0][1].messageId, 'm-42');
  assert.equal(calls[0][1].method, 'delMsg');
});

test('handleAction rejects unsupported action before send path', async () => {
  const { messageActions } = createBncrChannelPluginSurfaceGroup(createRuntime());

  await assert.rejects(
    () => messageActions.handleAction({ action: 'edit', params: {}, accountId: 'Primary' }),
    /Action edit is not supported/,
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
