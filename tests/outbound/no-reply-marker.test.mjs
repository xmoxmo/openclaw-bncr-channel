import assert from 'node:assert/strict';
import test from 'node:test';

import { isNoReplyMarkerText } from '../../src/core/no-reply-marker.ts';

const MARKER = 'NO_REPLY FROM AGENT';

/* Default: the whole reply body is exactly the marker. */
test('[NoReply] exact marker is suppressed', () => {
  assert.equal(isNoReplyMarkerText(MARKER), true);
});

test('[NoReply] case insensitive', () => {
  assert.equal(isNoReplyMarkerText('no_reply from agent'), true);
  assert.equal(isNoReplyMarkerText('No_Reply From Agent'), true);
});

test('[NoReply] surrounding whitespace and edge decoration are ignored', () => {
  assert.equal(isNoReplyMarkerText('  NO_REPLY FROM AGENT  '), true);
  assert.equal(isNoReplyMarkerText('NO_REPLY FROM AGENT.'), true);
  assert.equal(isNoReplyMarkerText('「NO_REPLY FROM AGENT」'), true);
  assert.equal(isNoReplyMarkerText('**NO_REPLY FROM AGENT**'), true);
});

test('[NoReply] internal whitespace runs and full-width spaces are tolerated', () => {
  assert.equal(isNoReplyMarkerText('NO_REPLY  FROM  AGENT'), true);
  assert.equal(isNoReplyMarkerText('NO_REPLY\u3000FROM\u3000AGENT'), true);
});

/* Variant 1: a standalone line on any line. */
test('[NoReply] standalone marker line anywhere is suppressed', () => {
  assert.equal(isNoReplyMarkerText('好的\nNO_REPLY FROM AGENT\n再见'), true);
  assert.equal(isNoReplyMarkerText('好的\n「NO_REPLY FROM AGENT」\n再见'), true);
});

/* Variant 2: whole reply head match. */
test('[NoReply] whole reply head match', () => {
  assert.equal(isNoReplyMarkerText('NO_REPLY FROM AGENT\n后面的内容'), true);
  assert.equal(isNoReplyMarkerText('NO_REPLY FROM AGENT，稍等'), true);
});

/* Variant 3: whole reply tail match. */
test('[NoReply] whole reply tail match', () => {
  assert.equal(isNoReplyMarkerText('前面的内容\nNO_REPLY FROM AGENT'), true);
  assert.equal(isNoReplyMarkerText('我先看看 NO_REPLY FROM AGENT'), true);
});

/* Embedded inside a middle line is ordinary text. */
test('[NoReply] marker embedded in a middle line is not suppressed', () => {
  assert.equal(isNoReplyMarkerText('好的\n我写了 NO_REPLY FROM AGENT 在这里\n再见'), false);
  assert.equal(isNoReplyMarkerText('好的 NO_REPLY FROM AGENT 再见'), false);
});

/* Bare NO_REPLY is the host's own invalid token, not this marker. */
test('[NoReply] bare NO_REPLY is not this marker', () => {
  assert.equal(isNoReplyMarkerText('NO_REPLY'), false);
  assert.equal(isNoReplyMarkerText('NO_REPLY\n后面的内容'), false);
});

test('[NoReply] ordinary text is not suppressed', () => {
  assert.equal(isNoReplyMarkerText('你好，在的'), false);
  assert.equal(isNoReplyMarkerText(''), false);
  assert.equal(isNoReplyMarkerText('   \n  '), false);
  assert.equal(isNoReplyMarkerText(null), false);
  assert.equal(isNoReplyMarkerText(undefined), false);
});

test('[NoReply] marker lookalikes are not suppressed', () => {
  assert.equal(isNoReplyMarkerText('NO_REPLY FROM AGENTX'), false);
  assert.equal(isNoReplyMarkerText('NO_REPLY FROM AGENTS'), false);
  assert.equal(isNoReplyMarkerText('XNO_REPLY FROM AGENT'), false);
  assert.equal(isNoReplyMarkerText('NO_REPLY FROM_AGENT'), false);
});
