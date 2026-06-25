import assert from 'node:assert/strict';
import test from 'node:test';
import { createBncrOutboxDrainFailure } from '../../src/plugin/outbox-drain-failure.ts';

function makeEntry(overrides = {}) {
  return {
    messageId: 'msg-1',
    accountId: 'Bncr:tgBot:0:user',
    sessionKey: 'agent:orion:bncr:direct:abc',
    route: { platform: 'tgBot', groupId: '0', userId: 'user' },
    payload: { text: 'hello' },
    createdAt: 1_000,
    retryCount: 0,
    nextAttemptAt: 1_000,
    lastError: undefined,
    ...overrides,
  };
}

function createFailureHandler(mocks = {}) {
  const outbox = new Map();
  const calls = { logWarn: [], logInfo: [], scheduleSave: false };

  const handler = createBncrOutboxDrainFailure({
    backoffMs: () => 10_000,
    outbox,
    resolveAccountIdForSession: (sessionKey) => {
      calls.resolveSession = sessionKey;
      return 'resolveResult' in mocks ? mocks.resolveResult : 'Primary';
    },
    logInfo: (scope, message, options) => {
      calls.logInfo.push({ scope, message, options });
    },
    logWarn: (scope, message, options) => {
      calls.logWarn.push({ scope, message, options });
    },
    isPrePushGuardDeferral: (entry) =>
      entry.lastError === 'no active bncr client' ||
      entry.lastError === 'gateway context unavailable',
    moveToDeadLetter: () => {},
    scheduleSave: () => {
      calls.scheduleSave = true;
    },
    outboxDrainSchedule: { scheduleAccountWait: () => null },
    maxRetry: 10,
    prePushGuardRetryDelayMs: 5_000,
    ...mocks.runtime,
  });

  return { handler, outbox, calls };
}

test('correction fixes bad accountId from session route on retry', () => {
  const { handler, outbox, calls } = createFailureHandler();
  const entry = makeEntry({ retryCount: 1, lastError: 'no active bncr client' });
  outbox.set(entry.messageId, entry);

  const result = handler({
    accountId: 'Bncr:tgBot:0:user',
    entry,
    localNextDelay: null,
    attemptedAt: 2_000,
    updateMinOutboxDelay: () => null,
  });

  assert.equal(entry.accountId, 'Primary');
  assert.equal(entry.retryCount, 0);
  assert.equal(entry.lastError, undefined);
  assert.equal(result.action, 'continue');

  assert.equal(calls.logWarn.length, 1);
  assert.ok(calls.logWarn[0].message.includes('Bncr:tgBot:0:user→Primary'));

  assert.equal(calls.logInfo.length, 1);
  assert.equal(calls.logInfo[0].options?.debugOnly, true);
  const parsed = JSON.parse(calls.logInfo[0].message);
  assert.equal(parsed.event, 'account-corrected');
  assert.equal(parsed.messageId, 'msg-1');
  assert.equal(parsed.oldAccountId, 'Bncr:tgBot:0:user');
  assert.equal(parsed.corrected, 'Primary');
  assert.equal(parsed.retryCount, 1);
  assert.equal(parsed.lastError, 'no active bncr client');

  assert.equal(calls.scheduleSave, true);
  assert.equal(outbox.get('msg-1').accountId, 'Primary');
});

test('does not correct when retryCount is 0', () => {
  const { handler, outbox, calls } = createFailureHandler();
  const entry = makeEntry({ retryCount: 0, lastError: 'no active bncr client' });
  outbox.set(entry.messageId, entry);

  handler({
    accountId: 'Bncr:tgBot:0:user',
    entry,
    localNextDelay: null,
    attemptedAt: 2_000,
    updateMinOutboxDelay: () => null,
  });

  assert.equal(entry.accountId, 'Bncr:tgBot:0:user');
  assert.equal(entry.retryCount, 0);
  assert.equal(calls.logWarn.length, 0);
  assert.equal(calls.scheduleSave, false);
});

test('does not correct when accountId already matches session route', () => {
  const { handler, outbox, calls } = createFailureHandler();
  const entry = makeEntry({
    accountId: 'Primary',
    retryCount: 1,
    lastError: 'no active bncr client',
  });
  outbox.set(entry.messageId, entry);

  handler({
    accountId: 'Primary',
    entry,
    localNextDelay: null,
    attemptedAt: 2_000,
    updateMinOutboxDelay: () => null,
  });

  assert.equal(entry.accountId, 'Primary');
  assert.equal(calls.logWarn.length, 0);
});

test('does not correct when session route returns null', () => {
  const { handler, outbox, calls } = createFailureHandler({
    resolveResult: null,
  });
  const entry = makeEntry({ retryCount: 1, lastError: 'no active bncr client' });
  outbox.set(entry.messageId, entry);

  handler({
    accountId: 'Bncr:tgBot:0:user',
    entry,
    localNextDelay: null,
    attemptedAt: 2_000,
    updateMinOutboxDelay: () => null,
  });

  assert.equal(entry.accountId, 'Bncr:tgBot:0:user');
  assert.equal(calls.logWarn.length, 0);
});

test('does not correct when lastError is not pre-push guard deferral', () => {
  const { handler, outbox, calls } = createFailureHandler();
  const entry = makeEntry({ retryCount: 1, lastError: 'push-failure' });
  outbox.set(entry.messageId, entry);

  handler({
    accountId: 'Bncr:tgBot:0:user',
    entry,
    localNextDelay: null,
    attemptedAt: 2_000,
    updateMinOutboxDelay: () => null,
  });

  assert.equal(entry.accountId, 'Bncr:tgBot:0:user');
  assert.equal(calls.logWarn.length, 0);
});
