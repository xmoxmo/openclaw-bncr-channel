import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReplyEnqueuePlan,
  normalizeReplyPayload,
} from '../../src/messaging/outbound/reply-enqueue.ts';

const helpers = { asString: String };

test('buildReplyEnqueuePlan returns text-only when payload has no media', () => {
  const payload = normalizeReplyPayload({ text: 'hello' }, helpers);

  assert.deepEqual(buildReplyEnqueuePlan(payload), { kind: 'text-only' });
});

test('buildReplyEnqueuePlan keeps short single-media payload as media-only', () => {
  const payload = normalizeReplyPayload(
    {
      text: 'caption',
      mediaUrl: '/tmp/demo.png',
    },
    helpers,
  );

  assert.deepEqual(buildReplyEnqueuePlan(payload), { kind: 'media-only', clearText: false });
});

test('buildReplyEnqueuePlan splits long single-media text and multi-media payloads', () => {
  const longSingleMedia = normalizeReplyPayload(
    {
      text: 'x'.repeat(1021),
      mediaUrl: '/tmp/demo.png',
    },
    helpers,
  );
  const multiMedia = normalizeReplyPayload(
    {
      text: 'caption',
      mediaUrls: ['/tmp/one.png', '/tmp/two.png'],
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
