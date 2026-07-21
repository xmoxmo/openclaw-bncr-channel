import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOutboxEntry } from '../../src/core/outbox-entry-builders.ts';

function makeId() {
  let i = 0;
  return () => `id-${++i}`;
}

const now = () => 1000000;
const norm = (a) => a || 'Primary';

const baseRoute = { platform: 'tgBot', groupId: '0', userId: '10001' };

/* ===================================================================
 * Text outbox — extra fields scattered into payload.message, extra key absent
 * =================================================================== */
test('[outbox] text entry scatters extra into message, no extra key', () => {
  const entry = buildOutboxEntry({
    createMessageId: makeId(),
    now,
    normalizeAccountId: norm,
    pushEvent: 'plugin.bncr.push',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:group:xxx',
    route: baseRoute,
    msg: 'hello',
    kind: 'final',
    replyToId: 'reply-1',
    replyTargetPolicy: 'agent-default',
    extra: { customBadge: 'VIP', priority: 5 },
  });

  const msg = entry.payload.message;
  // Scattered fields exist at top level of message
  assert.equal(msg.customBadge, 'VIP');
  assert.equal(msg.priority, 5);
  // No `extra` key in message
  assert.equal(msg.extra, undefined);
  // Core fields preserved
  assert.equal(msg.msg, 'hello');
  assert.equal(msg.type, 'text');
});

test('[outbox] text entry with no extra keeps message clean', () => {
  const entry = buildOutboxEntry({
    createMessageId: makeId(),
    now,
    normalizeAccountId: norm,
    pushEvent: 'plugin.bncr.push',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:group:xxx',
    route: baseRoute,
    msg: 'hi',
    kind: undefined,
    replyToId: undefined,
    replyTargetPolicy: 'agent-default',
  });

  assert.equal(entry.payload.message.msg, 'hi');
  assert.equal(entry.payload.message.extra, undefined);
  assert.equal(Object.keys(entry.payload.message).includes('extra'), false);
});

test('[outbox] text entry extra type field overrides default type', () => {
  const entry = buildOutboxEntry({
    createMessageId: makeId(),
    now,
    normalizeAccountId: norm,
    pushEvent: 'plugin.bncr.push',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:group:xxx',
    route: baseRoute,
    msg: '<appmsg/>',
    kind: 'final',
    replyToId: undefined,
    replyTargetPolicy: 'agent-default',
    extra: { type: 'appmsg', msg: '<appmsg>custom</appmsg>' },
  });

  // extra scatter overrides the default type:'text'
  assert.equal(entry.payload.message.type, 'appmsg');
  assert.equal(entry.payload.message.msg, '<appmsg>custom</appmsg>');
});

/* ===================================================================
 * Media outbox — extra fields scattered into message, extra key absent
 * =================================================================== */
test('[outbox] media entry scatters extra into message, no extra key', () => {
  const entry = buildOutboxEntry({
    createMessageId: makeId(),
    now,
    normalizeAccountId: norm,
    pushEvent: 'plugin.bncr.push',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:group:xxx',
    route: baseRoute,
    mediaUrl: '/tmp/photo.jpg',
    transferMode: 'media',
    msg: 'see this',
    asVoice: false,
    audioAsVoice: false,
    type: 'image',
    downloadMedia: false,
    kind: 'final',
    replyToId: undefined,
    replyTargetPolicy: 'agent-default',
    extra: { forceDocument: true, gifPlayback: false },
  });

  const message = entry.payload.message;
  // Scattered fields exist at top level of message
  assert.equal(message.forceDocument, true);
  assert.equal(message.gifPlayback, false);
  // No `extra` key in message
  assert.equal(message.extra, undefined);
  // Core message fields preserved
  assert.equal(message.mediaUrl, '/tmp/photo.jpg');
  assert.equal(message.transferMode, 'media');
});

test('[outbox] media entry with no extra keeps message clean', () => {
  const entry = buildOutboxEntry({
    createMessageId: makeId(),
    now,
    normalizeAccountId: norm,
    pushEvent: 'plugin.bncr.push',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:group:xxx',
    route: baseRoute,
    mediaUrl: '/tmp/vid.mp4',
    transferMode: 'media',
    msg: '',
    asVoice: false,
    audioAsVoice: false,
    type: undefined,
    downloadMedia: undefined,
    kind: 'block',
    replyToId: undefined,
    replyTargetPolicy: 'agent-default',
  });

  assert.equal(entry.payload.message.mediaUrl, '/tmp/vid.mp4');
  assert.equal(entry.payload.message.transferMode, 'media');
});

test('[outbox] media entry with empty extra (empty object) keeps message clean', () => {
  const entry = buildOutboxEntry({
    createMessageId: makeId(),
    now,
    normalizeAccountId: norm,
    pushEvent: 'plugin.bncr.push',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:group:xxx',
    route: baseRoute,
    mediaUrl: '/tmp/a.pdf',
    transferMode: 'media',
    msg: '',
    asVoice: false,
    audioAsVoice: false,
    type: 'file',
    downloadMedia: true,
    kind: undefined,
    replyToId: undefined,
    replyTargetPolicy: 'agent-default',
    extra: {}, // empty extra -> won't be spread (falsy)
  });

  assert.equal(entry.payload.message.mediaUrl, '/tmp/a.pdf');
  assert.equal(entry.payload.message.transferMode, 'media');
});

test('[outbox] media entry type not set defaults to undefined (not file) for downstream inference', () => {
  const entry = buildOutboxEntry({
    createMessageId: makeId(),
    now,
    normalizeAccountId: norm,
    pushEvent: 'plugin.bncr.push',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:group:xxx',
    route: baseRoute,
    mediaUrl: '/tmp/photo.jpg',
    transferMode: 'media',
    msg: 'caption',
    asVoice: false,
    audioAsVoice: false,
    // type intentionally omitted — downstream adapter infers from extension
    downloadMedia: undefined,
    kind: undefined,
    replyToId: undefined,
    replyTargetPolicy: 'agent-default',
  });

  assert.equal(entry.payload.message.type, undefined);
  assert.equal(entry.payload.message.mediaUrl, '/tmp/photo.jpg');
  assert.equal(entry.payload.message.transferMode, 'media');
  assert.equal(entry.payload.message.msg, 'caption');
});

test('[outbox] media entry explicit type is preserved', () => {
  const entry = buildOutboxEntry({
    createMessageId: makeId(),
    now,
    normalizeAccountId: norm,
    pushEvent: 'plugin.bncr.push',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:group:xxx',
    route: baseRoute,
    mediaUrl: '/tmp/photo.jpg',
    transferMode: 'media',
    msg: 'caption',
    asVoice: false,
    audioAsVoice: false,
    type: 'image',
    downloadMedia: undefined,
    kind: undefined,
    replyToId: undefined,
    replyTargetPolicy: 'agent-default',
  });

  assert.equal(entry.payload.message.type, 'image');
  assert.equal(entry.payload.message.mediaUrl, '/tmp/photo.jpg');
  assert.equal(entry.payload.message.transferMode, 'media');
});
