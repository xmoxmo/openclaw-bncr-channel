import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridgeExtendedDiagnosticsFacade } from '../../src/plugin/bridge-extended-diagnostics-facade.ts';

test('bridge extended-diagnostics facade assembles register connection outbound and dead-letter snapshots', () => {
  const facade = createBncrBridgeExtendedDiagnosticsFacade({
    normalizeAccountId: (accountId) => String(accountId || '').trim(),
    buildIntegratedDiagnostics: (accountId) => ({
      accountId,
      pending: 1,
      deadLetter: 0,
      health: { pending: 1, deadLetter: 0 },
      regression: { totalKnownRoutes: 0, ok: true },
    }),
    buildOutboxDiagnostics: () => ({ pending: 1, dueNow: 0, nextDelayMs: null }),
    buildRuntimeAckObservability: () => ({ currentTimeoutMs: 30000 }),
    getCounter: (map, accountId) => map.get(accountId) || 0,
    prePushGuardSkipCountByAccount: new Map([['Primary', 2]]),
    lastPrePushGuardSkipAtByAccount: new Map([['Primary', 3]]),
    lastPrePushGuardSkipReasonByAccount: new Map([['Primary', 'no-gateway-context']]),
    hasGatewayContext: () => true,
    buildRuntimeSurfaceDiagnostics: () => ({
      runtime: { config: true, media: false },
      channel: { inbound: false, media: false, reply: false, routing: false, session: false },
      channelMedia: { readRemoteMediaBuffer: false, saveMediaBuffer: false },
      contract: { 'runtime.config.current|get': true },
      missing: [],
    }),
    getRegisterState: () => ({
      bridgeId: 'bridge-1',
      gatewayPid: 1,
      pluginVersion: '0.0.1',
      pluginSource: 'index.ts',
      lastApiInstanceId: 'api-1',
      lastRegistryFingerprint: 'fp-1',
      registerCount: 1,
      firstRegisterAt: 1,
      lastRegisterAt: 2,
      lastApiRebindAt: 3,
      apiGeneration: 1,
      registerTraceRecent: [],
      lastDriftSnapshot: null,
    }),
    buildRegisterTraceSummary: () => ({ total: 0 }),
    activeConnectionCount: () => 1,
    getConnectionState: () => ({
      lastGatewayContextAt: 4,
      primaryLeaseId: 'lease-1',
      connectionEpoch: 2,
      acceptedConnections: 1,
      lastConnectAt: 5,
      lastDisconnectAt: null,
      lastActivityAtGlobal: 6,
      lastInboundAtGlobal: 7,
      lastAckAtGlobal: 8,
      recentConnections: new Map(),
    }),
    getOutboundState: () => ({
      outboundEnqueueCountByAccount: new Map([['Primary', 4]]),
      lastOutboundEnqueueAtByAccount: new Map([['Primary', 9]]),
    }),
    buildDeadLetterDiagnostics: () => ({ total: 0, all: 0, top: '-', topReasons: [] }),
    bridgeVersion: 2,
    staleCounters: {
      staleConnect: 0,
      staleInbound: 0,
      staleActivity: 0,
      staleAck: 0,
      staleFileInit: 0,
      staleFileChunk: 0,
      staleFileComplete: 0,
      staleFileAbort: 0,
      lastStaleAt: null,
    },
    now: () => 10,
  });

  const diagnostics = facade.buildExtendedDiagnostics('Primary');
  assert.equal(diagnostics?.connection?.active, 1);
  assert.equal(diagnostics?.register?.bridgeId, 'bridge-1');
  assert.equal(diagnostics?.outbound?.prePushGuardSkipCount, 2);
  assert.equal(diagnostics?.runtimeSurface?.contract?.['runtime.config.current|get'], true);
});

test('bridge extended-diagnostics facade preserves provided runtimeStatusInput and integratedDiagnostics', () => {
  const calls = [];
  const facade = createBncrBridgeExtendedDiagnosticsFacade({
    normalizeAccountId: (accountId) => String(accountId || '').trim(),
    buildIntegratedDiagnostics: (accountId, runtimeStatusInput) => {
      calls.push(['buildIntegratedDiagnostics', accountId, runtimeStatusInput]);
      return {
        health: {
          connected: true,
          pending: 1,
          pendingAdmissions: 0,
          deadLetter: 0,
          activeConnections: 0,
          connectEvents: 0,
          inboundEvents: 0,
          activityEvents: 0,
          ackEvents: 0,
          uptimeSec: 1,
        },
        regression: {
          pluginFilesPresent: true,
          pluginIndexExists: true,
          pluginChannelExists: true,
          totalKnownRoutes: 0,
          invalidOutboxSessionKeys: 0,
          legacyAccountResidue: 0,
          ok: true,
        },
        marker: runtimeStatusInput?.channelRoot || 'built',
      };
    },
    buildOutboxDiagnostics: () => ({ pending: 0, dueNow: 0, nextDelayMs: null }),
    buildRuntimeAckObservability: () => ({ currentTimeoutMs: 30000 }),
    getCounter: () => 0,
    prePushGuardSkipCountByAccount: new Map(),
    lastPrePushGuardSkipAtByAccount: new Map(),
    lastPrePushGuardSkipReasonByAccount: new Map(),
    hasGatewayContext: () => false,
    buildRuntimeSurfaceDiagnostics: () => ({
      runtime: {},
      channel: {},
      channelMedia: {},
      contract: {},
      missing: [],
    }),
    getRegisterState: () => ({
      bridgeId: 'bridge-1',
      gatewayPid: 1,
      pluginVersion: '0.0.1',
      pluginSource: 'index.ts',
      lastApiInstanceId: 'api-1',
      lastRegistryFingerprint: 'fp-1',
      registerCount: 1,
      firstRegisterAt: 1,
      lastRegisterAt: 2,
      lastApiRebindAt: 3,
      apiGeneration: 1,
      registerTraceRecent: [],
      lastDriftSnapshot: null,
    }),
    buildRegisterTraceSummary: () => ({ total: 0 }),
    activeConnectionCount: () => 0,
    getConnectionState: () => ({
      lastGatewayContextAt: null,
      primaryLeaseId: null,
      connectionEpoch: 0,
      acceptedConnections: 0,
      lastConnectAt: null,
      lastDisconnectAt: null,
      lastActivityAtGlobal: null,
      lastInboundAtGlobal: null,
      lastAckAtGlobal: null,
      recentConnections: new Map(),
    }),
    getOutboundState: () => ({
      outboundEnqueueCountByAccount: new Map(),
      lastOutboundEnqueueAtByAccount: new Map(),
    }),
    buildDeadLetterDiagnostics: () => ({
      total: 0,
      allAccountsTotal: 0,
      sinceStart: 0,
      cappedAt: 100,
      oldestAt: null,
      newestAt: null,
      topReasons: [],
    }),
    bridgeVersion: 2,
    staleCounters: {
      staleConnect: 0,
      staleInbound: 0,
      staleActivity: 0,
      staleAck: 0,
      staleFileInit: 0,
      staleFileChunk: 0,
      staleFileComplete: 0,
      staleFileAbort: 0,
      lastStaleAt: null,
    },
    now: () => 10,
  });

  const providedDiagnostics = {
    health: {
      connected: true,
      pending: 9,
      pendingAdmissions: 0,
      deadLetter: 0,
      activeConnections: 0,
      connectEvents: 0,
      inboundEvents: 0,
      activityEvents: 0,
      ackEvents: 0,
      uptimeSec: 9,
    },
    regression: {
      pluginFilesPresent: true,
      pluginIndexExists: true,
      pluginChannelExists: true,
      totalKnownRoutes: 0,
      invalidOutboxSessionKeys: 0,
      legacyAccountResidue: 0,
      ok: true,
    },
    marker: 'provided',
  };

  const diagnostics = facade.buildExtendedDiagnostics('Primary', {
    runtimeStatusInput: { accountId: 'Primary', channelRoot: '/plugin/root' },
    integratedDiagnostics: providedDiagnostics,
  });

  assert.equal(calls.length, 0);
  assert.equal(diagnostics?.health?.pending, 9);
});
