import assert from 'node:assert/strict';
import test from 'node:test';

import { createDynamicChannelPlugin } from '../../src/bootstrap/channel-plugin-runtime.ts';

function createBridge(label) {
  return {
    label,
    channelSendTextCalls: [],
    channelSendMediaCalls: [],
    startCalls: [],
    stopCalls: [],
    runtimeSnapshots: new Map(),
    channelSendText(ctx) {
      this.channelSendTextCalls.push(ctx);
      return { via: `text:${label}`, ctx };
    },
    channelSendMedia(ctx) {
      this.channelSendMediaCalls.push(ctx);
      return { via: `media:${label}`, ctx };
    },
    getChannelSummary(defaultAccountId) {
      return { via: `summary:${label}`, defaultAccountId };
    },
    getAccountRuntimeSnapshot(accountId) {
      const key = accountId || 'Primary';
      const snapshot = this.runtimeSnapshots.get(key) || {
        connected: label === 'b',
        running: true,
        pending: 0,
        deadLetter: 0,
        diagnostics: { via: label, accountId: key },
      };
      return snapshot;
    },
    channelStartAccount(ctx) {
      this.startCalls.push(ctx);
      return { via: `start:${label}`, ctx };
    },
    channelStopAccount(ctx) {
      this.stopCalls.push(ctx);
      return { via: `stop:${label}`, ctx };
    },
  };
}

test('createDynamicChannelPlugin proxies outbound status and gateway calls through current bridge', async () => {
  const bridgeA = createBridge('a');
  const bridgeB = createBridge('b');
  let currentBridge = bridgeA;

  const loaded = {
    createBncrChannelPlugin() {
      return {
        outbound: {
          async sendText() {
            return { via: 'base-text' };
          },
          async sendMedia() {
            return { via: 'base-media' };
          },
        },
        status: {
          async buildChannelSummary({ defaultAccountId }) {
            return { via: 'base-summary', defaultAccountId };
          },
          async buildAccountSnapshot({ account, runtime }) {
            return {
              accountId: account?.accountId || 'Primary',
              runtime,
            };
          },
          resolveAccountState({ runtime }) {
            return runtime?.connected ? 'linked' : 'configured';
          },
        },
        gateway: {
          startAccount(ctx) {
            return { via: 'base-start', ctx };
          },
          stopAccount(ctx) {
            return { via: 'base-stop', ctx };
          },
        },
      };
    },
  };

  const plugin = createDynamicChannelPlugin({
    loaded,
    getCurrentBridge: () => currentBridge,
  });

  const firstText = await plugin.outbound.sendText({ text: 'hello-a' });
  const firstSummary = await plugin.status.buildChannelSummary({ defaultAccountId: undefined });
  const firstSnapshot = await plugin.status.buildAccountSnapshot({
    account: { accountId: 'Primary' },
  });
  const firstState = plugin.status.resolveAccountState({
    enabled: true,
    configured: true,
    account: { accountId: 'Primary' },
    cfg: { accounts: [{ id: 'Primary', enable: true }] },
  });
  const firstStart = await plugin.gateway.startAccount({ accountId: 'Primary' });
  const firstStop = await plugin.gateway.stopAccount({ accountId: 'Primary' });

  currentBridge = bridgeB;

  const secondMedia = await plugin.outbound.sendMedia({ mediaUrl: '/tmp/demo.png' });
  const secondSummary = await plugin.status.buildChannelSummary({ defaultAccountId: 'Primary' });
  const secondSnapshot = await plugin.status.buildAccountSnapshot({
    account: { accountId: 'Primary' },
  });
  const secondState = plugin.status.resolveAccountState({
    enabled: true,
    configured: true,
    account: { accountId: 'Primary' },
    cfg: { accounts: [{ id: 'Primary', enable: true }] },
  });

  assert.equal(firstText.via, 'text:a');
  assert.deepEqual(firstSummary, { via: 'summary:a', defaultAccountId: 'Primary' });
  assert.equal(firstSnapshot.runtime.diagnostics.via, 'a');
  assert.equal(firstState, 'configured');
  assert.equal(firstStart.via, 'start:a');
  assert.equal(firstStop.via, 'stop:a');

  assert.equal(secondMedia.via, 'media:b');
  assert.deepEqual(secondSummary, { via: 'summary:b', defaultAccountId: 'Primary' });
  assert.equal(secondSnapshot.runtime.diagnostics.via, 'b');
  assert.equal(secondState, 'linked');
});

test('createDynamicChannelPlugin activates lifecycle only for gateway starts', async () => {
  const bridgeA = createBridge('a');
  const bridgeB = createBridge('b');
  let currentBridge = bridgeA;
  let startResolveCalls = 0;
  let stopAllowed = true;
  const loaded = {
    createBncrChannelPlugin() {
      return {
        outbound: {
          async sendText() {
            return { via: 'base-text' };
          },
          async sendMedia() {
            return { via: 'base-media' };
          },
        },
        status: {
          async buildChannelSummary() {
            return { via: 'base-summary' };
          },
          async buildAccountSnapshot({ account, runtime }) {
            return { accountId: account?.accountId || 'Primary', runtime };
          },
          resolveAccountState() {
            return 'configured';
          },
        },
        gateway: {
          startAccount() {
            return { via: 'base-start' };
          },
          stopAccount() {
            return { via: 'base-stop' };
          },
        },
      };
    },
  };

  const plugin = createDynamicChannelPlugin({
    loaded,
    getCurrentBridge: () => currentBridge,
    resolveBridgeForStart: async () => {
      startResolveCalls += 1;
      return bridgeB;
    },
    resolveBridgeForStop: () => (stopAllowed ? currentBridge : null),
  });

  assert.equal((await plugin.outbound.sendText({ text: 'hello' })).via, 'text:a');
  assert.deepEqual(await plugin.status.buildChannelSummary({}), {
    via: 'summary:a',
    defaultAccountId: 'Primary',
  });
  assert.equal(startResolveCalls, 0);

  assert.equal((await plugin.gateway.startAccount({ accountId: 'Primary' })).via, 'start:b');
  assert.equal(startResolveCalls, 1);
  assert.equal((await plugin.gateway.stopAccount({ accountId: 'Primary' })).via, 'stop:a');

  currentBridge = bridgeB;
  stopAllowed = false;
  assert.equal(await plugin.gateway.stopAccount({ accountId: 'Primary' }), undefined);
  assert.equal(bridgeB.stopCalls.length, 0);

  assert.deepEqual(await plugin.status.buildChannelSummary({}), {
    via: 'summary:b',
    defaultAccountId: 'Primary',
  });
  assert.equal(startResolveCalls, 1);
});

test('createDynamicChannelPlugin suppresses a start that loses lifecycle ownership after resolution', async () => {
  const bridge = createBridge('a');
  let current = true;
  const loaded = {
    createBncrChannelPlugin() {
      return {
        outbound: {},
        status: {},
        gateway: {
          startAccount() {},
          stopAccount() {},
        },
      };
    },
  };
  const plugin = createDynamicChannelPlugin({
    loaded,
    getCurrentBridge: () => bridge,
    resolveBridgeForStart: async () => {
      current = false;
      return bridge;
    },
    isBridgeForStartCurrent: () => current,
  });

  assert.equal(await plugin.gateway.startAccount({ accountId: 'Primary' }), undefined);
  assert.equal(bridge.startCalls.length, 0);
});

test('createDynamicChannelPlugin reports a current bridge start attempt immediately', async () => {
  const bridge = createBridge('a');
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  bridge.channelStartAccount = (ctx) => {
    bridge.startCalls.push(ctx);
    return startGate;
  };
  const loaded = {
    createBncrChannelPlugin() {
      return {
        outbound: {},
        status: {},
        gateway: {
          startAccount() {},
          stopAccount() {},
        },
      };
    },
  };
  let observed = 0;
  const plugin = createDynamicChannelPlugin({
    loaded,
    getCurrentBridge: () => bridge,
    onBridgeStartObserved: () => {
      observed += 1;
    },
  });

  const starting = plugin.gateway.startAccount({ accountId: 'Primary' });
  await Promise.resolve();
  assert.equal(observed, 1);
  assert.equal(bridge.startCalls.length, 1);

  releaseStart();
  await starting;
});

test('createDynamicChannelPlugin keeps startup successful when observation fails', async () => {
  const bridge = createBridge('a');
  const loaded = {
    createBncrChannelPlugin() {
      return {
        outbound: {},
        status: {},
        gateway: {
          startAccount() {},
          stopAccount() {},
        },
      };
    },
  };
  const plugin = createDynamicChannelPlugin({
    loaded,
    getCurrentBridge: () => bridge,
    onBridgeStartObserved: () => {
      throw new Error('observation boom');
    },
  });

  await assert.doesNotReject(plugin.gateway.startAccount({ accountId: 'Primary' }));
  assert.equal(bridge.startCalls.length, 1);
});

test('createDynamicChannelPlugin suppresses a stop that loses lifecycle ownership after resolution', async () => {
  const bridge = createBridge('a');
  let current = true;
  const loaded = {
    createBncrChannelPlugin() {
      return {
        outbound: {},
        status: {},
        gateway: {
          startAccount() {},
          stopAccount() {},
        },
      };
    },
  };
  const plugin = createDynamicChannelPlugin({
    loaded,
    getCurrentBridge: () => bridge,
    resolveBridgeForStop: async () => {
      current = false;
      return bridge;
    },
    isBridgeForStopCurrent: () => current,
  });

  assert.equal(await plugin.gateway.stopAccount({ accountId: 'Primary' }), undefined);
  assert.equal(bridge.stopCalls.length, 0);
});
