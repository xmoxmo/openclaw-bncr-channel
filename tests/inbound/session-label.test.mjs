import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBncrInboundSessionIdentityPatch } from '../../src/messaging/inbound/session-label.ts';

test('buildBncrInboundSessionIdentityPatch locks bncr session identity fields to canonical target', () => {
  const patch = buildBncrInboundSessionIdentityPatch({
    channelId: 'bncr',
    accountId: 'Primary',
    chatType: 'direct',
    displayTo: 'Bncr:tgBot:-1001:10001',
    senderId: 'client-1',
  });

  assert.equal(patch.label, 'Bncr:tgBot:-1001:10001');
  assert.equal(patch.channel, 'bncr');
  assert.equal(patch.chatType, 'direct');
  assert.deepEqual(patch.origin, {
    label: 'Bncr:tgBot:-1001:10001',
    provider: 'bncr',
    surface: 'bncr',
    chatType: 'direct',
    from: 'client-1',
    to: 'Bncr:tgBot:-1001:10001',
    accountId: 'Primary',
  });
  assert.deepEqual(patch.deliveryContext, {
    channel: 'bncr',
    to: 'Bncr:tgBot:-1001:10001',
    accountId: 'Primary',
  });
  assert.deepEqual(patch.route, {
    channel: 'bncr',
    accountId: 'Primary',
    target: { to: 'Bncr:tgBot:-1001:10001' },
  });
  assert.equal(patch.lastTo, 'Bncr:tgBot:-1001:10001');
});
