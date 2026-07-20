import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIntegratedDiagnostics } from '../../src/core/status.ts';

test('buildIntegratedDiagnostics keeps uptime finite for invalid startedAt', () => {
  const diagnostics = buildIntegratedDiagnostics({
    accountId: 'Primary',
    connected: true,
    pending: 0,
    deadLetter: 0,
    activeConnections: 1,
    connectEvents: 1,
    inboundEvents: 1,
    activityEvents: 1,
    ackEvents: 1,
    startedAt: 'not-a-number',
    sessionRoutesCount: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
  });

  assert.equal(Number.isFinite(diagnostics.health.uptimeSec), true);
  assert.equal(diagnostics.health.uptimeSec, 0);
});

test('buildIntegratedDiagnostics normalizes invalid counters at diagnostics boundary', () => {
  const diagnostics = buildIntegratedDiagnostics({
    accountId: 'Primary',
    connected: true,
    pending: 'not-a-number',
    deadLetter: Number.NaN,
    activeConnections: Number.POSITIVE_INFINITY,
    connectEvents: 'bad-connect',
    inboundEvents: 'bad-inbound',
    activityEvents: 'bad-activity',
    ackEvents: 'bad-ack',
    startedAt: Date.now(),
    sessionRoutesCount: Number.NEGATIVE_INFINITY,
    invalidOutboxSessionKeys: 'bad-invalid-keys',
    legacyAccountResidue: Number.NaN,
  });

  assert.equal(diagnostics.health.pending, 0);
  assert.equal(diagnostics.health.deadLetter, 0);
  assert.equal(diagnostics.health.activeConnections, 0);
  assert.equal(diagnostics.health.connectEvents, 0);
  assert.equal(diagnostics.health.inboundEvents, 0);
  assert.equal(diagnostics.health.activityEvents, 0);
  assert.equal(diagnostics.health.ackEvents, 0);
  assert.equal(diagnostics.regression.totalKnownRoutes, 0);
  assert.equal(diagnostics.regression.invalidOutboxSessionKeys, 0);
  assert.equal(diagnostics.regression.legacyAccountResidue, 0);
  assert.equal(diagnostics.regression.ok, true);
});

test('buildIntegratedDiagnostics clamps negative diagnostic counters to zero', () => {
  const runtimeInput = {
    accountId: 'Primary',
    connected: true,
    pending: -1,
    deadLetter: -2,
    activeConnections: -3,
    connectEvents: -4,
    inboundEvents: -5,
    activityEvents: -6,
    ackEvents: -7,
    startedAt: Date.now(),
    sessionRoutesCount: -8,
    invalidOutboxSessionKeys: -9,
    legacyAccountResidue: -10,
  };

  const diagnostics = buildIntegratedDiagnostics(runtimeInput);
  assert.equal(diagnostics.health.pending, 0);
  assert.equal(diagnostics.health.deadLetter, 0);
  assert.equal(diagnostics.health.activeConnections, 0);
  assert.equal(diagnostics.health.connectEvents, 0);
  assert.equal(diagnostics.health.inboundEvents, 0);
  assert.equal(diagnostics.health.activityEvents, 0);
  assert.equal(diagnostics.health.ackEvents, 0);
  assert.equal(diagnostics.regression.totalKnownRoutes, 0);
  assert.equal(diagnostics.regression.invalidOutboxSessionKeys, 0);
  assert.equal(diagnostics.regression.legacyAccountResidue, 0);
});
