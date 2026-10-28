import assert from 'node:assert/strict';
import test from 'node:test';

import { isSilentReplyText } from 'openclaw/plugin-sdk/reply-runtime';

/*
 * Premise canary for the plugin-side NO_REPLY FROM AGENT interception.
 *
 * The host treats a bare "NO_REPLY" as an empty/invalid reply, so the agent uses
 * the longer marker "NO_REPLY FROM AGENT". The host must keep emitting that
 * marker as an ordinary deliverable reply (never swallow it), otherwise the
 * plugin would never receive it. If a future host starts silencing the marker,
 * the assertions below flip and fail, signalling that the premise changed.
 */

test('[HostSilentReply] bare NO_REPLY is silent on the host', () => {
  assert.equal(isSilentReplyText('NO_REPLY'), true);
  assert.equal(isSilentReplyText('no_reply'), true);
  assert.equal(isSilentReplyText('NO_REPLY.'), true);
});

test('[HostSilentReply] NO_REPLY FROM AGENT marker is NOT silent on the host', () => {
  // These must reach the plugin as a deliverable reply, not be swallowed by the host.
  assert.equal(isSilentReplyText('NO_REPLY FROM AGENT'), false);
  assert.equal(isSilentReplyText('no_reply from agent'), false);
  assert.equal(isSilentReplyText('好的\nNO_REPLY FROM AGENT\n再见'), false);
  assert.equal(isSilentReplyText('NO_REPLY FROM AGENT，稍等'), false);
  assert.equal(isSilentReplyText('前面的内容\nNO_REPLY FROM AGENT'), false);
  // Bare NO_REPLY with surrounding words is also not silent.
  assert.equal(isSilentReplyText('AGENT SAYS NO_REPLY'), false);
  assert.equal(isSilentReplyText('好的 NO_REPLY 再见'), false);
});
