import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReplyEnqueuePlan,
  normalizeReplyPayload,
} from '../../src/messaging/outbound/reply-enqueue.ts';

const helpers = { asString: String };

test('buildReplyEnqueuePlan returns text-only when payload has no media', async () => {
  const payload = await normalizeReplyPayload({ text: 'hello' }, helpers);

  assert.deepEqual(buildReplyEnqueuePlan(payload), { kind: 'text-only' });
});

test('buildReplyEnqueuePlan keeps short single-media payload as media-only', async () => {
  const payload = await normalizeReplyPayload(
    {
      text: 'caption',
      mediaUrl: 'tests/media/demo.png',
    },
    helpers,
  );

  assert.deepEqual(buildReplyEnqueuePlan(payload), { kind: 'media-only', clearText: false });
});

test('buildReplyEnqueuePlan splits long single-media text and multi-media payloads', async () => {
  const longSingleMedia = await normalizeReplyPayload(
    {
      text: 'x'.repeat(1021),
      mediaUrl: 'tests/media/demo.png',
    },
    helpers,
  );
  const multiMedia = await normalizeReplyPayload(
    {
      text: 'caption',
      mediaUrls: ['tests/media/one.png', 'tests/media/two.png'],
    },
    helpers,
  );

  assert.deepEqual(buildReplyEnqueuePlan(longSingleMedia), {
    kind: 'text-and-media',
    clearText: true,
  });
  assert.deepEqual(buildReplyEnqueuePlan(multiMedia), {
    kind: 'text-and-media',
    clearText: true,
  });
});

test('normalizeReplyPayload preserves extra as a shallow copy', async () => {
  const extra = { parse_mode: 'Markdown', silent: true };
  const payload = await normalizeReplyPayload(
    {
      text: 'hello',
      mediaUrl: 'tests/media/demo.png',
      extra,
    },
    helpers,
  );

  assert.deepEqual(payload.extra, extra);
  assert.notEqual(payload.extra, extra);

  extra.parse_mode = 'HTML';
  assert.equal(payload.extra.parse_mode, 'Markdown');
});
