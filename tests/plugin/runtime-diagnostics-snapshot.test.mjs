import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBncrDeadLetterSummaryMessage } from '../../src/plugin/runtime-diagnostics-payload-builders.ts';
import {
  createBncrDeadLetterDiagnosticsHelpers,
  createBncrDiagnosticsSelectionHelpers,
  createBncrExtendedDiagnosticsAssembler,
} from '../../src/plugin/runtime-diagnostics-snapshot.ts';

test('diagnostics selection helpers expose account-scoped pending dead-letter and connection views', () => {
  const helpers = createBncrDiagnosticsSelectionHelpers({
    normalizeAccountId: (accountId) => String(accountId || '').trim(),
    outboxValues: () => [
      { accountId: 'Primary', messageId: 'm1' },
      { accountId: 'Other', messageId: 'm2' },
    ],
    getDeadLetterEntries: () => [
      { accountId: 'Primary', messageId: 'd1' },
      { accountId: 'Other', messageId: 'd2' },
    ],
    connectionsValues: () => [
      { accountId: 'Primary', connId: 'c1', clientId: 'client-1', connectedAt: 1, lastSeenAt: 2 },
      { accountId: 'Other', connId: 'c2', clientId: 'client-2', connectedAt: 3, lastSeenAt: 4 },
    ],
  });

  assert.deepEqual(
    helpers.getAccountPendingOutboxEntries('Primary').map((entry) => entry.messageId),
    ['m1'],
  );
  assert.deepEqual(
    helpers.getAccountDeadLetterEntries('Primary').map((entry) => entry.messageId),
    ['d1'],
  );
  assert.deepEqual(helpers.buildActiveConnectionDebugList('Primary'), [
    { accountId: 'Primary', connId: 'c1', clientId: 'client-1', connectedAt: 1, lastSeenAt: 2 },
  ]);
});

test('dead-letter diagnostics helpers build summaries and choose force/dedup logging path', () => {
  const logInfo = [];
  const logInfoDedup = [];
  const helpers = createBncrDeadLetterDiagnosticsHelpers({
    normalizeAccountId: (accountId) => String(accountId || '').trim(),
    getDeadLetterEntries: () => [{ accountId: 'Primary', createdAt: 1, lastError: 'fatal-a' }],
    maxDeadLetterEntries: 10,
    getCounter: (map, accountId) => map.get(accountId) || 0,
    deadLetterSinceStartByAccount: new Map([['Primary', 2]]),
    getAccountDeadLetterEntries: () => [
      { accountId: 'Primary', createdAt: 1, lastError: 'fatal-a' },
    ],
    logInfo(scope, message) {
      logInfo.push([scope, message]);
    },
    logInfoDedup(scope, message, options) {
      logInfoDedup.push([scope, message, options]);
    },
  });

  const summary = helpers.buildDeadLetterDiagnostics('Primary');
  assert.equal(summary.total, 1);
  assert.equal(summary.sinceStart, 2);
  assert.match(
    buildBncrDeadLetterSummaryMessage({ accountId: 'Primary', summary }),
    /Primary\|total=1/,
  );

  helpers.logDeadLetterSummary('Primary');
  helpers.logDeadLetterSummary('Primary', { force: true, source: 'prune' });

  assert.equal(logInfoDedup.length, 1);
  assert.equal(logInfo.length, 1);
  assert.match(logInfo[0][1], /source=prune/);
});

test('extended diagnostics assembler composes register outbound connection and stale fields', () => {
  const assemble = createBncrExtendedDiagnosticsAssembler({
    normalizeAccountId: (accountId) => String(accountId || '').trim(),
    buildIntegratedDiagnostics: () => ({ health: { ok: true } }),
    buildOutboxDiagnostics: () => ({ pending: 1, deadLetter: 0, activeConnectionCount: 1 }),
    buildRuntimeAckObservability: () => ({ recentAckTimeoutCount: 1 }),
    getCounter: (map, accountId) => map.get(accountId) || 0,
    prePushGuardSkipCountByAccount: new Map([['Primary', 3]]),
    lastPrePushGuardSkipAtByAccount: new Map([['Primary', 4]]),
    lastPrePushGuardSkipReasonByAccount: new Map([['Primary', 'no-context']]),
    hasGatewayContext: () => true,
    buildRuntimeSurfaceDiagnostics: () => ({
      contract: {},
      missing: [],
      runtime: { config: true, media: true },
      channel: { inbound: true, media: true, reply: true, routing: true, session: true },
      channelMedia: { readRemoteMediaBuffer: true, saveMediaBuffer: true },
    }),
    getRegisterRuntime: () => ({
      bridgeId: 'bridge-1',
      gatewayPid: 123,
      pluginVersion: '0.3.6',
      pluginSource: '/tmp/index.ts',
      lastApiInstanceId: 'api-1',
      lastRegistryFingerprint: 'svc:chn:mth',
      registerCount: 9,
      firstRegisterAt: 1,
      lastRegisterAt: 2,
      lastApiRebindAt: 3,
      apiGeneration: 4,
      registerTraceRecent: [],
      lastDriftSnapshot: null,
    }),
    buildRegisterTraceSummary: () => ({ total: 1, recent: 1, warm: true, stackBuckets: {} }),
    activeConnectionCount: () => 2,
    getConnectionRuntime: () => ({
      lastGatewayContextAt: 5,
      primaryLeaseId: 'lease-1',
      connectionEpoch: 6,
      acceptedConnections: 7,
      lastConnectAt: 8,
      lastDisconnectAt: 9,
      lastActivityAtGlobal: 10,
      lastInboundAtGlobal: 11,
      lastAckAtGlobal: 12,
      recentConnections: new Map([
        ['lease-1', { epoch: 6, connectedAt: 8, lastActivityAt: 10, isPrimary: true }],
      ]),
    }),
    getOutboundRuntime: () => ({
      outboundEnqueueCountByAccount: new Map([['Primary', 13]]),
      lastOutboundEnqueueAtByAccount: new Map([['Primary', 14]]),
    }),
    buildDeadLetterDiagnostics: () => ({
      total: 0,
      allAccountsTotal: 0,
      sinceStart: 0,
      cappedAt: 10,
      topReasons: [],
    }),
    bridgeVersion: 2,
    staleCounters: {
      staleConnect: 1,
      staleInbound: 2,
      staleActivity: 3,
      staleAck: 4,
      staleFileInit: 5,
      staleFileChunk: 6,
      staleFileComplete: 7,
      staleFileAbort: 8,
      lastStaleAt: 15,
    },
    now: () => 16,
  });

  const diagnostics = assemble('Primary');

  assert.equal(diagnostics.register.bridgeId, 'bridge-1');
  assert.equal(diagnostics.connection.primaryLeaseId, 'lease-1');
  assert.equal(diagnostics.outbound.enqueueCount, 13);
  assert.equal(diagnostics.outbound.prePushGuardSkipCount, 3);
  assert.equal(diagnostics.protocol.bridgeVersion, 2);
  assert.equal(diagnostics.stale.staleFileAbort, 8);
});
