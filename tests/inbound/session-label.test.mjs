import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBncrInboundSessionIdentityPatch } from '../../src/messaging/inbound/session-label.ts';

test('buildBncrInboundSessionIdentityPatch keeps shared group route fields on the group target', () => {
  const patch = buildBncrInboundSessionIdentityPatch({
    channelId: 'bncr',
    accountId: 'Primary',
    chatType: 'group',
    displayTo: 'Bncr:tgBot:-1001:10001',
    senderId: 'client-1',
  });

  assert.equal(patch.label, 'Bncr:tgBot:Group:-1001');
  assert.equal(patch.displayName, 'Bncr:tgBot:Group:-1001');
  assert.equal(patch.channel, 'bncr');
  assert.equal(patch.chatType, 'group');
  assert.equal(patch.groupId, 'tgbot:-1001');
  assert.deepEqual(patch.origin, {
    label: 'Bncr:tgBot:Group:-1001',
    provider: 'bncr',
    surface: 'bncr',
    chatType: 'group',
    from: 'client-1',
    to: 'Bncr:tgBot:-1001:0',
    accountId: 'Primary',
  });
  assert.deepEqual(patch.deliveryContext, {
    channel: 'bncr',
    to: 'Bncr:tgBot:-1001:0',
    accountId: 'Primary',
  });
  assert.deepEqual(patch.route, {
    channel: 'bncr',
    accountId: 'Primary',
    target: { to: 'Bncr:tgBot:-1001:0' },
  });
  assert.equal(patch.lastTo, 'Bncr:tgBot:-1001:0');
});

test('buildBncrInboundSessionIdentityPatch keeps direct route fields on the direct target', () => {
  const patch = buildBncrInboundSessionIdentityPatch({
    channelId: 'bncr',
    accountId: 'Primary',
    chatType: 'direct',
    displayTo: 'Bncr:tgBot:0:10001',
    senderId: 'client-1',
  });

  assert.equal(patch.label, 'Bncr:tgBot:User:10001');
  assert.equal(patch.displayName, 'Bncr:tgBot:User:10001');
  assert.equal('groupId' in patch, false);
  assert.deepEqual(patch.origin, {
    label: 'Bncr:tgBot:User:10001',
    provider: 'bncr',
    surface: 'bncr',
    chatType: 'direct',
    from: 'client-1',
    to: 'Bncr:tgBot:0:10001',
    accountId: 'Primary',
  });
  assert.deepEqual(patch.deliveryContext, {
    channel: 'bncr',
    to: 'Bncr:tgBot:0:10001',
    accountId: 'Primary',
  });
  assert.deepEqual(patch.route, {
    channel: 'bncr',
    accountId: 'Primary',
    target: { to: 'Bncr:tgBot:0:10001' },
  });
  assert.equal(patch.lastTo, 'Bncr:tgBot:0:10001');
});
