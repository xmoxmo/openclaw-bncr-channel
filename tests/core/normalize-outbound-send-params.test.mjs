import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeOutboundSend } from '../../src/messaging/outbound/normalize-outbound-send.ts';

/* normalizeOutboundSend returns:
 *   text: string        – body after selection (message for text, caption for media)
 *   mediaUrl?: string
 *   mediaUrls?: string[]
 *   asVoice: boolean
 *   audioAsVoice: boolean
 *   downloadMedia?: boolean
 *   type?: string
 *   hasMedia: boolean
 *   extra?: Record<string, unknown>
 *   kind?: 'tool' | 'block' | 'final'
 *   replyToId?: string
 */

test('normalizes text send', () => {
  const r = normalizeOutboundSend({ message: ' hello ' });
  assert.equal(r.text, ' hello ');
  assert.equal(r.hasMedia, false);
  assert.equal(r.asVoice, false);
  assert.equal(r.audioAsVoice, false);
});

test('falls back from caption to message when media is absent', () => {
  const r = normalizeOutboundSend({ caption: 'caption only' });
  assert.equal(r.text, 'caption only');
  assert.equal(r.hasMedia, false);
});

test('media field takes priority over path, filePath, and mediaUrl', () => {
  const r = normalizeOutboundSend({
    message: 'media caption',
    media: ' /tmp/media.png ',
    path: '/tmp/path.png',
    filePath: '/tmp/file-path.png',
    mediaUrl: '/tmp/media-url.png',
  });
  assert.equal(r.hasMedia, true);
  assert.equal(r.text, 'media caption');
  assert.equal(r.mediaUrl, '/tmp/media.png');
});

test('path is used when media is absent', () => {
  const r = normalizeOutboundSend({
    caption: 'path caption',
    path: '/tmp/path.png',
    filePath: '/tmp/file-path.png',
    mediaUrl: '/tmp/media-url.png',
  });
  assert.equal(r.hasMedia, true);
  assert.equal(r.text, 'path caption');
  assert.equal(r.mediaUrl, '/tmp/path.png');
});

test('filePath is used when media and path are absent', () => {
  const r = normalizeOutboundSend({
    message: 'filePath caption',
    filePath: '/tmp/file-path.png',
    mediaUrl: '/tmp/media-url.png',
  });
  assert.equal(r.hasMedia, true);
  assert.equal(r.text, 'filePath caption');
  assert.equal(r.mediaUrl, '/tmp/file-path.png');
});

test('mediaUrl is used when media, path, and filePath are absent', () => {
  const r = normalizeOutboundSend({
    message: 'mediaUrl caption',
    mediaUrl: '/tmp/media-url.png',
    audioAsVoice: true,
  });
  assert.equal(r.hasMedia, true);
  assert.equal(r.text, 'mediaUrl caption');
  assert.equal(r.mediaUrl, '/tmp/media-url.png');
  assert.equal(r.audioAsVoice, true);
});

test('extra object is preserved as a shallow copy', () => {
  const extra = { replyMarkup: { inline_keyboard: [] }, priority: 1 };
  const r = normalizeOutboundSend({ message: 'hello', extra });

  assert.deepEqual(r.extra, extra);
  assert.notEqual(r.extra, extra);

  extra.priority = 2;
  assert.equal(r.extra.priority, 1);
});

test('non-object extra is ignored', () => {
  const r = normalizeOutboundSend({ message: 'hello', extra: ['bad'] });
  assert.equal(r.extra, undefined);
});

test('mediaUrls are normalized when single mediaUrl is absent', () => {
  const r = normalizeOutboundSend({
    message: 'album caption',
    mediaUrls: [' /tmp/one.png ', '', '/tmp/two.png', 123],
  });
  assert.equal(r.hasMedia, true);
  assert.equal(r.text, 'album caption');
  assert.equal(r.mediaUrl, undefined);
  assert.deepEqual(r.mediaUrls, ['/tmp/one.png', '/tmp/two.png']);
});

test('mediaUrl is merged into mediaUrls without duplication', () => {
  const r = normalizeOutboundSend({
    caption: 'merged media',
    mediaUrl: '/tmp/one.png',
    mediaUrls: [' /tmp/two.png ', '/tmp/one.png', ''],
  });
  assert.equal(r.hasMedia, true);
  assert.equal(r.text, 'merged media');
  assert.equal(r.mediaUrl, undefined);
  assert.deepEqual(r.mediaUrls, ['/tmp/two.png', '/tmp/one.png']);
});

test('asVoice without media returns hasMedia=false', () => {
  const r = normalizeOutboundSend({ message: 'voice text', asVoice: true });
  assert.equal(r.asVoice, true);
  assert.equal(r.hasMedia, false);
  assert.equal(r.text, 'voice text');
});

test('asVoice allows mediaUrls without single mediaUrl', () => {
  const r = normalizeOutboundSend({
    caption: 'voice album',
    mediaUrls: ['/tmp/voice-1.ogg', '/tmp/voice-2.ogg'],
    asVoice: true,
  });
  assert.equal(r.text, 'voice album');
  assert.equal(r.mediaUrl, undefined);
  assert.deepEqual(r.mediaUrls, ['/tmp/voice-1.ogg', '/tmp/voice-2.ogg']);
  assert.equal(r.asVoice, true);
});

test('empty content without media returns empty text', () => {
  const r = normalizeOutboundSend({ message: '   ', caption: '' });
  assert.equal(r.text, '   ');
  assert.equal(r.hasMedia, false);
});

test('marker in message text is parsed and merged into extra', () => {
  const r = normalizeOutboundSend({
    message: 'send [BncrParam:{"forceDocument":true,"customBadge":"VIP"}] this',
  });
  assert.equal(r.text, 'send this');
  assert.deepEqual(r.extra, { forceDocument: true, customBadge: 'VIP' });
});

test('marker consumption fields override params', () => {
  const r = normalizeOutboundSend({
    message: 'voice [BncrParam:{"asVoice":true,"type":"audio"}] clip',
    mediaUrl: '/tmp/clip.ogg',
  });
  assert.equal(r.text, 'voice clip');
  assert.equal(r.asVoice, true);
  assert.equal(r.type, 'audio');
  // consumption fields stripped from extra
  assert.equal(r.extra, undefined);
});

test('marker asVoice:false overrides host asVoice:true', () => {
  const r = normalizeOutboundSend({
    text: 'x [BncrParam:{"asVoice":false}]',
    asVoice: true,
    mediaUrl: '/tmp/clip.ogg',
  });
  assert.equal(r.asVoice, false);
});

test('marker asVoice without media returns hasMedia=false', () => {
  const r = normalizeOutboundSend({ text: '[BncrParam:{"asVoice":true}] only marker' });
  assert.equal(r.text, 'only marker');
  assert.equal(r.asVoice, true);
  assert.equal(r.hasMedia, false);
});

test('marker-only message with extra does not throw', () => {
  const r = normalizeOutboundSend({ text: '[BncrParam:{"forceDocument":true}]' });
  assert.equal(r.text, '');
  assert.deepEqual(r.extra, { forceDocument: true });
});

test('marker in caption also extracts params', () => {
  const r = normalizeOutboundSend({
    caption: '[BncrParam:{"silent":true}] caption text',
    mediaUrl: '/tmp/file.jpg',
  });
  assert.equal(r.hasMedia, true);
  assert.equal(r.text, 'caption text');
  assert.deepEqual(r.extra, { silent: true });
});

test('marker in both message and caption merges params (caption wins)', () => {
  const r = normalizeOutboundSend({
    message: '[BncrParam:{"forceDocument":true}] msg',
    caption: '[BncrParam:{"gifPlayback":true}] cap',
  });
  assert.equal(r.text, 'msg');
  assert.deepEqual(r.extra, { forceDocument: true, gifPlayback: true });
});

test('extra param object merges with marker params (marker wins)', () => {
  const r = normalizeOutboundSend({
    message: 'test [BncrParam:{"priority":2,"forceDocument":true}]',
    extra: { priority: 1, customKey: 'original' },
  });
  assert.equal(r.text, 'test');
  assert.equal(r.extra.priority, 2); // marker wins
  assert.equal(r.extra.forceDocument, true);
  assert.equal(r.extra.customKey, 'original');
});
