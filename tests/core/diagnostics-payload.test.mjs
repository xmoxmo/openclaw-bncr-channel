import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDiagnosticsPayload } from '../../src/core/diagnostics.ts';

test('buildDiagnosticsPayload treats invalid runtime counters as zero for probe', () => {
  const payload = buildDiagnosticsPayload({
    cfg: {},
    channelId: 'bncr',
    accountId: 'Primary',
    runtime: {
      connected: true,
      meta: {
        pending: 'not-a-number',
        deadLetter: 'not-a-number',
      },
    },
    diagnostics: {},
    downlinkHealth: {},
    runtimeFlags: {},
    waiters: { messageAck: 0, fileAck: 0 },
    activeConnections: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
    now: Date.now(),
  });

  assert.equal(payload.probe.details.pending, 0);
  assert.equal(payload.probe.details.deadLetter, 0);
  assert.equal(payload.probe.ok, true);
});

test('buildDiagnosticsPayload clamps invalid probe boundary counters', () => {
  const payload = buildDiagnosticsPayload({
    cfg: {},
    channelId: 'bncr',
    accountId: 'Primary',
    runtime: {
      connected: true,
      meta: {
        pending: -1,
        deadLetter: Number.NEGATIVE_INFINITY,
      },
    },
    diagnostics: {},
    downlinkHealth: {},
    runtimeFlags: {},
    waiters: { messageAck: 0, fileAck: 0 },
    activeConnections: Number.POSITIVE_INFINITY,
    invalidOutboxSessionKeys: -2,
    legacyAccountResidue: Number.NaN,
    now: Date.now(),
  });

  assert.equal(payload.probe.details.pending, 0);
  assert.equal(payload.probe.details.deadLetter, 0);
  assert.equal(payload.probe.details.activeConnections, 0);
  assert.equal(payload.probe.details.invalidOutboxSessionKeys, 0);
  assert.equal(payload.probe.details.legacyAccountResidue, 0);
  assert.equal(payload.probe.ok, true);
});
