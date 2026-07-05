import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBridgeDrainTriggers,
  buildBridgeLifecycleMarkers,
  buildBridgeStatusProjectionRuntime,
  buildChannelSendTargetRuntime,
  buildInboundSurfaceActivityRuntime,
  buildInboundSurfaceConnectionRuntime,
  createBridgeSupportRuntime,
} from '../../src/plugin/bridge-surface-helpers.ts';

test('bridge status projection runtime injects channel root and preserves bridge facades', () => {
  const calls = [];
  const runtime = buildBridgeStatusProjectionRuntime({
    buildAccountQueueCounters: (accountId) => ({ accountId, pending: 1 }),
    buildExtendedDiagnostics: (accountId, options) => ({ accountId, options }),
    buildRuntimeFlags: (accountId) => ({ accountId, running: true }),
    buildRuntimeStatusInput: (accountId, overrides) => ({
      accountId,
      source: 'base',
      ...overrides,
    }),
    getAccountRuntimeSnapshot: (accountId, input) => ({ accountId, input }),
    buildIntegratedDiagnostics: (accountId, input) => ({ accountId, input, mode: 'integrated' }),
    buildDownlinkHealth: (accountId) => ({ accountId, ok: true }),
    resolveChannelRoot: () => '/plugin/root',
  });

  assert.deepEqual(runtime.buildAccountQueueCounters('Primary'), {
    accountId: 'Primary',
    pending: 1,
  });
  assert.deepEqual(runtime.buildExtendedDiagnostics('Primary', { detail: true }), {
    accountId: 'Primary',
    options: { detail: true },
  });
  assert.deepEqual(runtime.buildRuntimeFlags('Primary'), { accountId: 'Primary', running: true });
  assert.deepEqual(runtime.buildRuntimeStatusInput('Primary', { running: false, hello: 'world' }), {
    accountId: 'Primary',
    source: 'base',
    running: false,
    hello: 'world',
    channelRoot: '/plugin/root',
  });
  assert.deepEqual(runtime.getAccountRuntimeSnapshot('Primary', { live: true }), {
    accountId: 'Primary',
    input: { live: true },
  });
  assert.deepEqual(runtime.buildIntegratedDiagnostics('Primary', { live: true }), {
    accountId: 'Primary',
    input: { live: true },
    mode: 'integrated',
  });
  assert.deepEqual(runtime.buildDownlinkHealth('Primary'), { accountId: 'Primary', ok: true });
  assert.equal(calls.length, 0);
});

test('bridge drain and lifecycle helper groups preserve flush and marker delegation', () => {
  const drainCalls = [];
  const markers = [];
  const triggers = buildBridgeDrainTriggers({
    flushPushQueueBestEffort: (args) => {
      drainCalls.push(args);
    },
  });
  const lifecycle = buildBridgeLifecycleMarkers({
    markLastActivityAt: () => markers.push('activity'),
    markLastAckAt: () => markers.push('ack'),
  });

  triggers.flushOnConnect('Primary');
  triggers.flushOnActivity('Primary');
  lifecycle.markLastActivityAt();
  lifecycle.markLastAckAt();

  assert.deepEqual(drainCalls, [
    { accountId: 'Primary', trigger: 'connect', reason: 'ws-online' },
    { accountId: 'Primary', trigger: 'activity', reason: 'activity-heartbeat' },
  ]);
  assert.deepEqual(markers, ['activity', 'ack']);
});

test('inbound surface helper groups preserve activity and connection delegation', () => {
  const calls = [];
  const activityRuntime = buildInboundSurfaceActivityRuntime({
    markInboundGlobalActivity: () => calls.push(['markInboundGlobalActivity']),
    incrementInboundEvents: (accountId) => calls.push(['incrementInboundEvents', accountId]),
    setLastInboundByAccount: (accountId, at) =>
      calls.push(['setLastInboundByAccount', accountId, at]),
    markActivity: (accountId, at) => calls.push(['markActivity', accountId, at]),
  });
  const connectionRuntime = buildInboundSurfaceConnectionRuntime({
    shouldIgnoreStaleEvent: (args) => args.kind === 'activity',
    observeLease: (kind, payload) => ({ kind, payload, stale: false }),
    matchesTransferOwner: (args) => args.connId === 'conn-1',
    refreshAcceptedFileTransferLiveState: (args) =>
      calls.push(['refreshAcceptedFileTransferLiveState', args]),
    refreshLiveConnectionState: (args) => calls.push(['refreshLiveConnectionState', args]),
    isOnline: (accountId) => accountId === 'Primary',
    hasRecentInboundReachability: (accountId) => accountId === 'Primary',
    getActiveConnectionKey: (accountId) => `${accountId}:conn-1`,
    buildActiveConnectionDebugList: (accountId) => [{ accountId, connId: 'conn-1' }],
  });

  activityRuntime.markLastInboundAt('Primary');
  activityRuntime.setInboundActivity('Primary', 123);
  connectionRuntime.refreshAcceptedFileTransferLiveState({ transferId: 't-1' });
  connectionRuntime.refreshLiveConnectionState({ connId: 'conn-1' });

  assert.equal(connectionRuntime.shouldIgnoreStaleEvent({ kind: 'activity' }), true);
  assert.deepEqual(connectionRuntime.observeLease('activity', { epoch: 1 }), {
    kind: 'activity',
    payload: { epoch: 1 },
    stale: false,
  });
  assert.equal(connectionRuntime.matchesTransferOwner({ connId: 'conn-1' }), true);
  assert.equal(connectionRuntime.isOnline('Primary'), true);
  assert.equal(connectionRuntime.hasRecentInboundReachability('Primary'), true);
  assert.equal(connectionRuntime.getActiveConnectionKey('Primary'), 'Primary:conn-1');
  assert.deepEqual(connectionRuntime.buildActiveConnectionDebugList('Primary'), [
    { accountId: 'Primary', connId: 'conn-1' },
  ]);
  assert.deepEqual(calls, [
    ['markInboundGlobalActivity'],
    ['incrementInboundEvents', 'Primary'],
    ['setLastInboundByAccount', 'Primary', 123],
    ['markActivity', 'Primary', 123],
    ['refreshAcceptedFileTransferLiveState', { transferId: 't-1' }],
    ['refreshLiveConnectionState', { connId: 'conn-1' }],
  ]);
});

test('channel send target runtime preserves target resolution route memory and enqueue delegation', async () => {
  const calls = [];
  const runtime = buildChannelSendTargetRuntime({
    resolveVerifiedTarget: (to, accountId) => ({ to, accountId }),
    rememberSessionRoute: (sessionKey, accountId, route) =>
      calls.push(['rememberSessionRoute', sessionKey, accountId, route]),
    enqueueFromReply: async (args) => {
      calls.push(['enqueueFromReply', args]);
    },
  });

  assert.deepEqual(runtime.resolveVerifiedTarget('Bncr:tgBot:0:10001', 'Primary'), {
    to: 'Bncr:tgBot:0:10001',
    accountId: 'Primary',
  });
  runtime.rememberSessionRoute('session-1', 'Primary', { userId: '10001' });
  await runtime.enqueueFromReply({ accountId: 'Primary', payload: { text: 'hello' } });

  assert.deepEqual(calls, [
    ['rememberSessionRoute', 'session-1', 'Primary', { userId: '10001' }],
    ['enqueueFromReply', { accountId: 'Primary', payload: { text: 'hello' } }],
  ]);
});

test('bridge support runtime centralizes save scheduling debug flag and canonical agent fallback helpers', async () => {
  let saveTimer = null;
  let flushed = 0;
  let verbose = false;
  let canonical = null;
  const logs = [];
  const warnings = [];
  const runtime = createBridgeSupportRuntime({
    isStopped: () => false,
    hasSaveTimer: () => Boolean(saveTimer),
    setSaveTimer: (timer) => {
      saveTimer = timer;
    },
    flushState: async () => {
      flushed += 1;
    },
    normalizeAccountId: (accountId) => String(accountId || '').trim(),
    getCounterValue: (map, accountId) => map.get(accountId) || 0,
    getRuntimeConfig: () => ({ channels: { bncr: { debug: { verbose: true } } } }),
    channelId: 'bncr',
    readCurrentCanonicalAgentId: () => canonical,
    resolveAgentRoute: ({ accountId }) =>
      accountId === 'Primary' ? { agentId: 'orion' } : { agentId: '' },
    readCachedCanonicalAgentId: () => canonical,
    writeCachedCanonicalAgentId: (agentId) => {
      canonical = agentId;
    },
    logInfo: (scope, message) => logs.push([scope, message]),
    logWarn: (scope, message) => warnings.push([scope, message]),
    readDebugVerbose: () => verbose,
    writeDebugVerbose: (value) => {
      verbose = value;
    },
  });

  const counters = new Map();
  runtime.incrementCounter(counters, 'Primary');
  assert.equal(runtime.getCounter(counters, 'Primary'), 1);
  await runtime.refreshDebugFlagFromConfig({ forceLog: true });
  assert.equal(verbose, true);
  runtime.scheduleSave();
  assert.ok(saveTimer);
  clearTimeout(saveTimer);
  saveTimer = null;
  runtime.initializeCanonicalAgentId({});
  assert.equal(canonical, 'orion');
  canonical = null;
  assert.equal(runtime.ensureCanonicalAgentId({ cfg: {}, accountId: 'Other' }), 'main');
  assert.equal(flushed, 0);
  assert.equal(logs.length > 0, true);
  assert.equal(warnings.length, 1);
});
