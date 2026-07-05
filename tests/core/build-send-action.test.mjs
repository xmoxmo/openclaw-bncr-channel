import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBncrMessageAction } from '../../src/messaging/outbound/build-send-action.ts';

test('buildBncrMessageAction keeps mediaUrls voice sends on media path', () => {
  const built = buildBncrMessageAction({
    accountId: 'Primary',
    to: 'Bncr:tgBot:-1001:0',
    caption: 'voice album',
    mediaUrls: ['/tmp/voice-1.ogg', '/tmp/voice-2.ogg'],
    asVoice: true,
  });

  assert.equal(built.channel, 'bncr');
  assert.equal(built.action, 'send');
  assert.equal(built.accountId, 'Primary');
  assert.equal(built.params.to, 'Bncr:tgBot:-1001:0');
  assert.equal(built.params.caption, 'voice album');
  assert.deepEqual(built.params.mediaUrls, ['/tmp/voice-1.ogg', '/tmp/voice-2.ogg']);
  assert.equal(built.params.asVoice, true);
  assert.equal('message' in built.params, false);
});
