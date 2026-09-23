import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBncrBridgeCleanupDebugInfo,
  cleanupBncrBridgeRuntime,
  shutdownBncrBridgeService,
  startBncrBridgeService,
  stopBncrBridgeService,
} from '../../src/plugin/bridge-lifecycle.ts';

test('bridge lifecycle cleanup debug info keeps stable bounded fields', () => {
  assert.deepEqual(
    buildBncrBridgeCleanupDebugInfo({
      bridgeId: 'bridge-1',
      reason: 'shutdown',
      messageAckWaiters: 1,
      fileAckWaiters: 2,
      earlyFileAcks: 3,
      outbox: 4,
      runningDrainAccounts: 5,
      channelAccountWorkers: 6,
      hasSaveTimer: true,
      hasPushTimer: false,
    }),
    {
      bridge: 'bridge-1',
      reason: 'shutdown',
      messageAckWaiters: 1,
      fileAckWaiters: 2,
      earlyFileAcks: 3,
      outbox: 4,
      runningDrainAccounts: 5,
      channelAccountWorkers: 6,
      hasSaveTimer: true,
      hasPushTimer: false,
    },
  );
});

test('bridge lifecycle service helpers preserve startup stop and shutdown sequencing', async () => {
  const calls = [];
  let stopped = true;
  let statePath = null;
  let debugVerbose = false;

  const runtime = {
    bridgeId: 'bridge-1',
    setStopped(value) {
      stopped = value;
      calls.push(['setStopped', value]);
    },
    setStatePath(value) {
      statePath = value;
      calls.push(['setStatePath', value]);
    },
    getRuntimeConfig() {
      calls.push(['getRuntimeConfig']);
      return { channels: { bncr: { enabled: true } } };
    },
    initializeCanonicalAgentId(cfg) {
      calls.push(['initializeCanonicalAgentId', cfg.channels.bncr.enabled]);
    },
    logWarn(scope, message) {
      calls.push(['logWarn', scope, message]);
    },
    async loadState() {
      calls.push(['loadState']);
    },
    setDebugFlag(value) {
      debugVerbose = value;
      calls.push(['setDebugFlag', value]);
    },
    async refreshDebugFlagFromConfig(options) {
      calls.push(['refreshDebugFlagFromConfig', options.forceLog]);
    },
    buildIntegratedDiagnostics() {
      calls.push(['buildIntegratedDiagnostics']);
      return {
        regression: { totalKnownRoutes: 7, ok: true },
        health: { pending: 1, deadLetter: 2 },
      };
    },
    logInfo(scope, message) {
      calls.push(['logInfo', scope, message]);
    },
    getChannelConfigRoot(cfg) {
      return cfg.channels.bncr;
    },
    resumeOutboxDrain() {
      calls.push(['resumeOutboxDrain']);
    },
  };

  assert.equal(await startBncrBridgeService(runtime, { stateDir: '/tmp/bncr-state' }, true), true);
  assert.equal(stopped, false);
  assert.equal(debugVerbose, true);
  assert.match(statePath, /bncr-bridge-state\.json$/);
  const loadStateIndex = calls.findIndex(([name]) => name === 'loadState');
  const setRunningIndex = calls.findIndex(
    ([name, value]) => name === 'setStopped' && value === false,
  );
  const resumeDrainIndex = calls.findIndex(([name]) => name === 'resumeOutboxDrain');
  assert.ok(loadStateIndex >= 0);
  assert.ok(setRunningIndex > loadStateIndex);
  assert.ok(resumeDrainIndex > setRunningIndex);

  const cleanupCalls = [];
  await stopBncrBridgeService({
    cleanupRuntime(reason) {
      cleanupCalls.push(reason);
    },
    async flushState() {
      cleanupCalls.push('flush');
    },
    logInfo(scope, message) {
      cleanupCalls.push([scope, message]);
    },
  });
  assert.deepEqual(cleanupCalls, ['service stopped', 'flush', ['debug', 'service stopped']]);

  const shutdownCalls = [];
  shutdownBncrBridgeService({
    cleanupRuntime(reason) {
      shutdownCalls.push(reason);
    },
  });
  assert.deepEqual(shutdownCalls, ['shutdown']);
});

test('bridge lifecycle stale start does not clear stopped or resume outbox drain', async () => {
  let current = true;
  let stopped = true;
  let resumed = false;
  let releaseLoad;
  let notifyLoadEntered;
  const loadGate = new Promise((resolve) => {
    releaseLoad = resolve;
  });
  const loadEntered = new Promise((resolve) => {
    notifyLoadEntered = resolve;
  });
  const runtime = {
    bridgeId: 'bridge-stale-start',
    setStopped(value) {
      stopped = value;
    },
    setStatePath() {},
    getRuntimeConfig() {
      return { channels: { bncr: { enabled: true } } };
    },
    initializeCanonicalAgentId() {},
    logWarn() {},
    async loadState() {
      notifyLoadEntered();
      await loadGate;
    },
    setDebugFlag() {},
    async refreshDebugFlagFromConfig() {},
    buildIntegratedDiagnostics() {
      return {
        regression: { totalKnownRoutes: 0, ok: true },
        health: { pending: 0, deadLetter: 0 },
      };
    },
    logInfo() {},
    getChannelConfigRoot(cfg) {
      return cfg.channels.bncr;
    },
    resumeOutboxDrain() {
      resumed = true;
    },
    isStartCurrent() {
      return current;
    },
  };

  const starting = startBncrBridgeService(runtime, { stateDir: '/tmp/bncr-state' }, false);
  await loadEntered;
  current = false;
  releaseLoad();

  assert.equal(await starting, false);
  assert.equal(stopped, true);
  assert.equal(resumed, false);
});

test('bridge lifecycle start failure restores stopped and does not resume outbox drain', async () => {
  const calls = [];
  let stopped = false;
  let resumed = false;
  const runtime = {
    bridgeId: 'bridge-failed',
    setStopped(value) {
      stopped = value;
      calls.push(['setStopped', value]);
    },
    setStatePath() {},
    getRuntimeConfig() {
      return { channels: { bncr: { enabled: true } } };
    },
    initializeCanonicalAgentId() {},
    logWarn() {},
    async loadState() {},
    setDebugFlag() {},
    async refreshDebugFlagFromConfig() {},
    buildIntegratedDiagnostics() {
      throw new Error('diagnostics failed');
    },
    logInfo() {},
    getChannelConfigRoot(cfg) {
      return cfg.channels.bncr;
    },
    resumeOutboxDrain() {
      resumed = true;
    },
  };

  await assert.rejects(
    startBncrBridgeService(runtime, { stateDir: '/tmp/bncr-state' }, false),
    /diagnostics failed/,
  );

  assert.equal(stopped, true);
  assert.equal(resumed, false);
  assert.deepEqual(
    calls.filter(([name]) => name === 'setStopped'),
    [
      ['setStopped', false],
      ['setStopped', true],
    ],
  );
});

test('bridge lifecycle service runs sqlite cutover when maintenance env is set', async () => {
  const originalCutoverEnv = process.env.BNCR_SQLITE_CUTOVER;
  process.env.BNCR_SQLITE_CUTOVER = '1';
  const calls = [];
  let statePath = null;
  const runtime = {
    bridgeId: 'bridge-sqlite',
    setStopped() {},
    setStatePath(value) {
      statePath = value;
    },
    getRuntimeConfig() {
      return { channels: { bncr: { enabled: true } } };
    },
    initializeCanonicalAgentId() {},
    logWarn() {},
    async loadState() {
      calls.push(['loadState']);
    },
    async cutoverToSqlite() {
      calls.push(['cutoverToSqlite']);
      return { backupPath: '/tmp/state.pre-sqlite.json', storeMode: 'sqlite' };
    },
    setDebugFlag() {},
    async refreshDebugFlagFromConfig() {},
    buildIntegratedDiagnostics() {
      return {
        regression: { totalKnownRoutes: 0, ok: true },
        health: { pending: 0, deadLetter: 0 },
      };
    },
    logInfo(scope, message) {
      calls.push(['logInfo', scope, message]);
    },
    getChannelConfigRoot(cfg) {
      return cfg.channels.bncr;
    },
  };

  try {
    await startBncrBridgeService(runtime, { stateDir: '/tmp/bncr-state' }, false);
  } finally {
    if (originalCutoverEnv === undefined) delete process.env.BNCR_SQLITE_CUTOVER;
    else process.env.BNCR_SQLITE_CUTOVER = originalCutoverEnv;
  }

  assert.deepEqual(calls.slice(0, 3), [
    ['loadState'],
    ['cutoverToSqlite'],
    ['logInfo', 'sqlite', 'cutover completed backup=/tmp/state.pre-sqlite.json storeMode=sqlite'],
  ]);
  assert.equal(
    calls.some((call) => call[0] === 'logInfo' && call[1] === 'startup'),
    true,
  );
  assert.match(statePath, /bncr-bridge-state\.json$/);
});

test('bridge lifecycle cleanup clears timers waiters and workers through one boundary', () => {
  const calls = [];
  cleanupBncrBridgeRuntime(
    {
      bridgeId: 'bridge-1',
      logInfo(scope, message) {
        calls.push([scope, message]);
      },
      setStopped(value) {
        calls.push(['setStopped', value]);
      },
      clearAllChannelAccountWorkers(reason) {
        calls.push(['clearWorkers', reason]);
      },
      getMessageAckWaiterCount: () => 1,
      getFileAckWaiterCount: () => 2,
      getEarlyFileAckCount: () => 3,
      getOutboxCount: () => 4,
      getRunningDrainAccountCount: () => 5,
      getChannelAccountWorkerCount: () => 6,
      hasSaveTimer: () => true,
      hasPushTimer: () => true,
      clearSaveTimer() {
        calls.push(['clearSaveTimer']);
      },
      clearPushTimer() {
        calls.push(['clearPushTimer']);
      },
      clearAllMessageAckWaiters(result) {
        calls.push(['clearMessageAckWaiters', result]);
      },
      clearAllFileAckWaiters(reason) {
        calls.push(['clearFileAckWaiters', reason]);
      },
    },
    'shutdown',
  );

  assert.deepEqual(calls.slice(1), [
    ['setStopped', true],
    ['clearWorkers', 'shutdown'],
    ['clearSaveTimer'],
    ['clearPushTimer'],
    ['clearMessageAckWaiters', 'timeout'],
    ['clearFileAckWaiters', 'shutdown'],
  ]);
});
