import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBncrHookChannelContext } from '../../src/messaging/inbound/hook-context.ts';

test('hook channel context carries the full identity space for group chats', () => {
  const context = buildBncrHookChannelContext({
    channelId: 'bncr',
    platform: 'GolemPlus',
    peer: { kind: 'group', id: '56154027594' },
    groupName: '清欢渡群',
    senderId: '10001',
    senderName: 'xmo',
    userId: '10001',
    userName: 'xmo_wx',
  });

  assert.deepEqual(context, {
    chat: {
      id: '56154027594',
      platform: 'bncr/GolemPlus',
      kind: 'group',
      title: '清欢渡群',
    },
    sender: {
      id: '10001',
      name: 'xmo',
      userId: '10001',
      username: 'xmo_wx',
    },
  });
});

test('hook channel context omits title for direct chats', () => {
  const context = buildBncrHookChannelContext({
    channelId: 'bncr',
    platform: 'GewePlus',
    peer: { kind: 'direct', id: 'kvictor' },
    groupName: 'ignored',
    senderId: 'kvictor',
    senderName: 'kvictor',
  });

  assert.equal(context?.chat.kind, 'direct');
  assert.equal('title' in (context?.chat ?? {}), false);
  assert.equal('userId' in (context?.sender ?? {}), false);
  assert.equal('username' in (context?.sender ?? {}), false);
});

test('hook channel context omits blank group title and blank sender name', () => {
  const context = buildBncrHookChannelContext({
    channelId: 'bncr',
    platform: 'tgBot',
    peer: { kind: 'group', id: '-1001' },
    groupName: '   ',
    senderId: '10001',
    senderName: '',
  });

  assert.deepEqual(context, {
    chat: { id: '-1001', platform: 'bncr/tgBot', kind: 'group' },
    sender: { id: '10001' },
  });
});

test('hook channel context is omitted when the backend or peer id is missing', () => {
  const base = {
    channelId: 'bncr',
    platform: 'tgBot',
    peer: { kind: 'group', id: '-1001' },
    senderId: '10001',
  };

  assert.equal(buildBncrHookChannelContext({ ...base, platform: '' }), undefined);
  assert.equal(buildBncrHookChannelContext({ ...base, platform: '  ' }), undefined);
  assert.equal(
    buildBncrHookChannelContext({ ...base, peer: { kind: 'group', id: '' } }),
    undefined,
  );
  assert.equal(buildBncrHookChannelContext({ ...base, senderId: ' ' }), undefined);
  assert.equal(buildBncrHookChannelContext({ ...base, channelId: '' }), undefined);
});

test('hook channel context never carries authorization flags', () => {
  const context = buildBncrHookChannelContext({
    channelId: 'bncr',
    platform: 'tgBot',
    peer: { kind: 'group', id: '-1001' },
    senderId: '10001',
    senderName: 'owner-user',
  });

  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes('isOwner'), false);
  assert.equal(serialized.includes('isAdmin'), false);
  assert.equal(serialized.includes('isAuthorizedSender'), false);
  assert.equal(serialized.includes('role'), false);
});
