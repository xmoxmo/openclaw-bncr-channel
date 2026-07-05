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

test('countLegacyAccountResidue counts mismatched account residue across runtime indexes', () => {
  assert.equal(
    countLegacyAccountResidue({
      accountId: 'Primary',
      outboxEntries: [entry(), entry({ accountId: 'Other' })],
      deadLetterEntries: [entry({ accountId: 'Legacy' })],
      sessionRoutes: [{ accountId: 'Primary' }, { accountId: 'Stale' }, {}],
      lastSessionAccountIds: ['Primary', 'Other'],
      lastActivityAccountIds: ['default', 'Other'],
      lastInboundAccountIds: ['', 'Primary'],
      lastOutboundAccountIds: ['primary', 'Another'],
    }),
    6,
  );
});
