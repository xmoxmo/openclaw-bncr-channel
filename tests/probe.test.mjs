import assert from 'node:assert/strict';
import test from 'node:test';

import { probeBncrAccount } from '../src/core/probe.ts';

test('probeBncrAccount reports healthy connected account', () => {
  const probe = probeBncrAccount({
    accountId: 'Primary',
    connected: true,
    pending: 0,
    deadLetter: 0,
    activeConnections: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
    lastActivityAt: 123,
    structure: {
      coreComplete: true,
      inboundComplete: true,
      outboundComplete: true,
    },
  });

  assert.equal(probe.ok, true);
  assert.equal(probe.level, 'ok');
  assert.equal(probe.summary, 'healthy');
  assert.deepEqual(probe.details, {
    accountId: 'Primary',
    connected: true,
    pending: 0,
    deadLetter: 0,
    activeConnections: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
    lastActivityAt: 123,
    structure: {
      coreComplete: true,
      inboundComplete: true,
      outboundComplete: true,
    },
  });
});

test('probeBncrAccount keeps warning-level issues in deterministic summary order', () => {
  const probe = probeBncrAccount({
    accountId: 'Primary',
    connected: true,
    pending: 21,
    deadLetter: 1,
    activeConnections: 4,
    invalidOutboxSessionKeys: 2,
    legacyAccountResidue: 3,
  });

  assert.equal(probe.ok, false);
  assert.equal(probe.level, 'warn');
  assert.equal(
    probe.summary,
    'pending-high, dead-letter, too-many-connections, invalid-session-keys, legacy-account-residue',
  );
  assert.equal(probe.details.lastActivityAt, null);
  assert.equal(probe.details.structure, null);
});

test('probeBncrAccount escalates disconnected dead-letter or invalid-route state to error', () => {
  const deadLetterProbe = probeBncrAccount({
    accountId: 'Primary',
    connected: false,
    pending: 0,
    deadLetter: 1,
    activeConnections: 0,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
  });
  const invalidRouteProbe = probeBncrAccount({
    accountId: 'Primary',
    connected: false,
    pending: 0,
    deadLetter: 0,
    activeConnections: 0,
    invalidOutboxSessionKeys: 1,
    legacyAccountResidue: 0,
  });
  const disconnectedOnlyProbe = probeBncrAccount({
    accountId: 'Primary',
    connected: false,
    pending: 0,
    deadLetter: 0,
    activeConnections: 0,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
  });

  assert.equal(deadLetterProbe.level, 'error');
  assert.equal(invalidRouteProbe.level, 'error');
  assert.equal(disconnectedOnlyProbe.level, 'warn');
});

test('probeBncrAccount normalizes invalid diagnostic counters before evaluating issues', () => {
  const probe = probeBncrAccount({
    accountId: 'Primary',
    connected: true,
    pending: Number.NaN,
    deadLetter: Number.NEGATIVE_INFINITY,
    activeConnections: Number.POSITIVE_INFINITY,
    invalidOutboxSessionKeys: -1,
    legacyAccountResidue: 'not-a-number',
  });

  assert.equal(probe.ok, true);
  assert.equal(probe.level, 'ok');
  assert.equal(probe.summary, 'healthy');
  assert.deepEqual(
    {
      pending: probe.details.pending,
      deadLetter: probe.details.deadLetter,
      activeConnections: probe.details.activeConnections,
      invalidOutboxSessionKeys: probe.details.invalidOutboxSessionKeys,
      legacyAccountResidue: probe.details.legacyAccountResidue,
    },
    {
      pending: 0,
      deadLetter: 0,
      activeConnections: 0,
      invalidOutboxSessionKeys: 0,
      legacyAccountResidue: 0,
    },
  );
});

test('probeBncrAccount preserves zero activity timestamp but drops non-finite values', () => {
  const zeroProbe = probeBncrAccount({
    accountId: 'Primary',
    connected: true,
    pending: 0,
    deadLetter: 0,
    activeConnections: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
    lastActivityAt: 0,
  });
  const invalidProbe = probeBncrAccount({
    accountId: 'Primary',
    connected: true,
    pending: 0,
    deadLetter: 0,
    activeConnections: 1,
    invalidOutboxSessionKeys: 0,
    legacyAccountResidue: 0,
    lastActivityAt: Number.POSITIVE_INFINITY,
  });

  assert.equal(zeroProbe.details.lastActivityAt, 0);
  assert.equal(invalidProbe.details.lastActivityAt, null);
});
