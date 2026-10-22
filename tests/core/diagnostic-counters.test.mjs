import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countInvalidOutboxSessionKeys,
  countLegacyAccountResidue,
} from '../../src/core/diagnostic-counters.ts';

function entry(overrides = {}) {
  return {
    messageId: 'mid',
    accountId: 'Primary',
    sessionKey: 'agent:main:bncr:group:74673a31',
    route: { platform: 'tg', groupId: '1', userId: '2' },
    payload: {},
    createdAt: 1,
    retryCount: 0,
    nextAttemptAt: 0,
    ...overrides,
  };
}

test('countInvalidOutboxSessionKeys counts only malformed session keys for requested account', () => {
  assert.equal(
    countInvalidOutboxSessionKeys({
      accountId: 'Primary',
      outboxEntries: [
        entry(),
        entry({ messageId: 'bad', sessionKey: 'not-a-bncr-session' }),
        entry({ messageId: 'other', accountId: 'Other', sessionKey: 'not-a-bncr-session' }),
      ],
    }),
    1,
  );
});

test('countInvalidOutboxSessionKeys normalizes equivalent account ids before filtering', () => {
  assert.equal(
    countInvalidOutboxSessionKeys({
      accountId: 'default',
      outboxEntries: [
        entry({ messageId: 'bad-primary-lower', accountId: 'primary', sessionKey: 'bad-session' }),
        entry({ messageId: 'bad-default', accountId: 'default', sessionKey: 'also-bad' }),
        entry({ messageId: 'other', accountId: 'Other', sessionKey: 'not-a-bncr-session' }),
      ],
    }),
    2,
  );
});

test('countLegacyAccountResidue counts mismatched residue on delivery/routing truth only', () => {
  assert.equal(
    countLegacyAccountResidue({
      accountId: 'Primary',
      outboxEntries: [entry(), entry({ accountId: 'Other' })],
      deadLetterEntries: [entry({ accountId: 'Legacy' })],
      sessionRoutes: [{ accountId: 'Primary' }, { accountId: 'Stale' }, {}],
    }),
    3,
  );
});

test('countLegacyAccountResidue treats alias account ids as matched, not residue', () => {
  assert.equal(
    countLegacyAccountResidue({
      accountId: 'Primary',
      outboxEntries: [entry({ accountId: 'default' }), entry({ accountId: 'primary' })],
      deadLetterEntries: [entry({ accountId: 'Default' })],
      sessionRoutes: [{ accountId: 'primary' }, { accountId: 'orion' }],
    }),
    1,
  );
});
