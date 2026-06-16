import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrInboundSurfaceHandlersGroup } from '../../src/plugin/inbound-surface-handlers-group.ts';

test('inbound surface handlers group exposes file and message inbound handler surfaces', () => {
  const group = createBncrInboundSurfaceHandlersGroup({
    getApi: () => ({
      runtime: { channel: { media: { saveMediaBuffer: async () => ({ path: '/tmp/a' }) } } },
    }),
    channelId: 'bncr',
    bridgeId: 'bridge-1',
    pluginRoot: '/tmp/bncr',
    asString: (value, fallback = '') =>
      typeof value === 'string' ? value : value == null ? fallback : String(value),
    now: () => 100,
    normalizeAccountId: (value) => value,
    finiteNonNegativeNumberOrNull: (value) =>
      Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null,
    syncDebugFlag: async () => {},
    shouldIgnoreStaleEvent: () => false,
    observeLease: () => ({ stale: false }),
    matchesTransferOwner: () => true,
    refreshAcceptedFileTransferLiveState() {},
    refreshLiveConnectionState() {},
    logInfo() {},
    logWarn() {},
    logError() {},
    buildInboundResponsePayload: (args) => args,
    buildInboundAcceptedLifecycleDebugInfo: () => ({}),
    isOnline: () => true,
    hasRecentInboundReachability: () => true,
    getActiveConnectionKey: () => 'Primary:client-1',
    buildActiveConnectionDebugList: () => [],
    markLastInboundAt() {},
    ensureCanonicalAgentId: () => 'orion',
    prepareInboundAcceptance: async () => ({ ok: false, status: false, payload: { ok: false } }),
    logInboundSummary() {},
    flushPushQueueBestEffort() {},
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
    fileRecvTransfers: new Map(),
    inboundFileTransferMaxBytes: 1024,
    inboundFileTransferMaxChunks: 8,
  });

  assert.equal(typeof group.fileInboundHandlers.handleFileInit, 'function');
  assert.equal(typeof group.fileInboundHandlers.handleFileChunk, 'function');
  assert.equal(typeof group.inboundHandlers.handleInbound, 'function');
});
