import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeadLetterDiagnostics,
  formatDeadLetterTopReasons,
  parseDeadLetterLimit,
  parseDeadLetterOffset,
  parseDeadLetterOlderThan,
  summarizeDeadLetterEntry,
} from '../src/core/dead-letter-diagnostics.ts';

test('buildDeadLetterDiagnostics summarizes account-scoped entries', () => {
  assert.deepEqual(
    buildDeadLetterDiagnostics({
      entries: [
        {
          messageId: 'a',
          accountId: 'Primary',
          route: {},
          payload: {},
          createdAt: 30,
          retryCount: 0,
          lastError: 'b',
        },
        {
          messageId: 'b',
          accountId: 'Primary',
          route: {},
          payload: {},
          createdAt: 10,
          retryCount: 0,
          lastError: 'a',
        },
        {
          messageId: 'c',
          accountId: 'Primary',
          route: {},
          payload: {},
          createdAt: 'bad',
          retryCount: 0,
          lastError: 'b',
        },
        {
          messageId: 'd',
          accountId: 'Primary',
          route: {},
          payload: {},
          createdAt: 20,
          retryCount: 0,
          lastError: ' ',
        },
      ],
      allAccountsTotal: 9,
      sinceStart: 4,
      cappedAt: 100,
    }),
    {
      total: 4,
      allAccountsTotal: 9,
      sinceStart: 4,
      cappedAt: 100,
      oldestAt: 10,
      newestAt: 30,
      topReasons: [
        { reason: 'b', count: 2 },
        { reason: 'a', count: 1 },
        { reason: 'unknown', count: 1 },
      ],
    },
  );
});

test('formatDeadLetterTopReasons renders compact reason counts', () => {
  assert.equal(formatDeadLetterTopReasons([]), '-');
  assert.equal(
    formatDeadLetterTopReasons([
      { reason: 'push-ack-timeout', count: 2 },
      { reason: 'push-retry', count: 1 },
    ]),
    'push-ack-timeout:2,push-retry:1',
  );
});

test('parseDeadLetterLimit clamps numeric input and falls back for invalid values', () => {
  assert.equal(parseDeadLetterLimit(undefined, 20), 20);
  assert.equal(parseDeadLetterLimit('bad', 20), 20);
  assert.equal(parseDeadLetterLimit(-5, 20), 0);
  assert.equal(parseDeadLetterLimit(5.9, 20), 5);
  assert.equal(parseDeadLetterLimit(500, 20), 100);
});

test('parseDeadLetterOffset allows deep pagination without limit clamping', () => {
  assert.equal(parseDeadLetterOffset(undefined, 0), 0);
  assert.equal(parseDeadLetterOffset('bad', 0), 0);
  assert.equal(parseDeadLetterOffset(-5, 0), 0);
  assert.equal(parseDeadLetterOffset(5.9, 0), 5);
  assert.equal(parseDeadLetterOffset(500, 0), 500);
});

test('parseDeadLetterOlderThan accepts numbers and date strings', () => {
  assert.equal(parseDeadLetterOlderThan(undefined), null);
  assert.equal(parseDeadLetterOlderThan(null), null);
  assert.equal(parseDeadLetterOlderThan(''), null);
  assert.equal(parseDeadLetterOlderThan('   '), null);
  assert.equal(parseDeadLetterOlderThan(1234), 1234);
  assert.equal(parseDeadLetterOlderThan('1234'), 1234);
  assert.equal(parseDeadLetterOlderThan('not-a-date'), null);
  assert.equal(
    parseDeadLetterOlderThan('2026-06-06T00:00:00.000Z'),
    Date.parse('2026-06-06T00:00:00.000Z'),
  );
});

test('summarizeDeadLetterEntry formats stable inspect output without mutating entry', () => {
  const entry = {
    messageId: 'dead-1',
    accountId: 'Primary',
    sessionKey: 'agent:main:bncr:direct:74673a313a32',
    route: { platform: 'tg', groupId: '1', userId: '2' },
    payload: {
      _meta: { kind: 'message', text: ' hello\nworld this text is intentionally long ' },
    },
    createdAt: 'bad-created-at',
    retryCount: 'bad-retry-count',
    nextAttemptAt: 0,
    lastError: 'push-ack-timeout',
  };

  assert.deepEqual(summarizeDeadLetterEntry(entry), {
    messageId: 'dead-1',
    accountId: 'Primary',
    sessionKey: 'agent:main:bncr:direct:74673a313a32',
    route: 'Bncr:tg:1:2',
    kind: 'message',
    createdAt: null,
    retryCount: 0,
    lastError: 'push-ack-timeout',
    textPreview: 'hello world this text is…',
  });
  assert.equal(entry.payload._meta.text.includes('\n'), true);
});
