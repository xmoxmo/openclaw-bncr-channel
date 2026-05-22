import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMediaTextFallback,
  normalizeMessageText,
  normalizeReplyToId,
} from '../src/messaging/outbound/media-dedupe.ts';

test('media dedupe fallback returns checkmark when text/reply target are effectively same', () => {
  const result = buildMediaTextFallback({
    currentText: normalizeMessageText('hello'),
    previousText: normalizeMessageText('hello'),
    currentReplyToId: normalizeReplyToId('123'),
    previousReplyToId: normalizeReplyToId('123'),
  });

  assert.deepEqual(result, {
    text: '✅已发送',
    reason: 'same-text-sent-checkmark',
  });
});

test('media dedupe fallback downgrades to latest text when reply target is same but text changed', () => {
  const result = buildMediaTextFallback({
    currentText: normalizeMessageText('new text'),
    previousText: normalizeMessageText('old text'),
    currentReplyToId: normalizeReplyToId('123'),
    previousReplyToId: normalizeReplyToId('123'),
  });

  assert.deepEqual(result, {
    text: 'new text',
    reason: 'text-changed-downgrade',
  });
});

test('media dedupe fallback returns null when reply target differs', () => {
  const result = buildMediaTextFallback({
    currentText: normalizeMessageText('hello'),
    previousText: normalizeMessageText('hello'),
    currentReplyToId: normalizeReplyToId('123'),
    previousReplyToId: normalizeReplyToId('456'),
  });

  assert.equal(result, null);
});
