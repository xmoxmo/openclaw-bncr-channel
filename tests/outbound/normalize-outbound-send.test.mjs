import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeOutboundSend } from '../../src/messaging/outbound/normalize-outbound-send.ts';

/** @param {import('../../src/messaging/outbound/normalize-outbound-send.ts').UnifiedOutboundSendInput} input */
async function n(input) {
  return await normalizeOutboundSend(input);
}

/* ===================================================================
 * 1. 文本化参数是否解析
 * =================================================================== */
test('[BncrParam] marker is parsed from text body', async () => {
  const r = await n({ text: 'hi [BncrParam:{"customKey":"val"}] there' });
  // Body stripped of marker
  assert.equal(r.text, 'hi there');
  // Unknown key → extra
  assert.equal(r.extra?.customKey, 'val');
});

test('[BncrParam] marker at start of text', async () => {
  const r = await n({ text: '[BncrParam:{"customKey":"val"}] hi there' });
  assert.equal(r.text, 'hi there');
  assert.equal(r.extra?.customKey, 'val');
});

test('[BncrParam] marker-only text with no other content', async () => {
  const r = await n({ text: '[BncrParam:{"customKey":"val"}]' });
  assert.equal(r.text, '');
  assert.equal(r.extra?.customKey, 'val');
});

test('[BncrParam] marker parsed from caption field', async () => {
  // caption is text fallback for media sends
  const r = await n({
    caption: 'media [BncrParam:{"priority":10}]',
    mediaUrl: 'tests/media/a.png',
  });
  // Caption with marker → text used
  assert.equal(r.text, 'media');
  assert.equal(r.extra?.priority, 10);
});

test('[BncrParam] no marker returns text unchanged', async () => {
  const r = await n({ text: 'plain hello world' });
  assert.equal(r.text, 'plain hello world');
  assert.equal(r.extra, undefined);
});

test('[BncrParam] invalid JSON marker stays in text for debugging', async () => {
  const r = await n({ text: 'bad [BncrParam:{invalid}] here' });
  // Invalid JSON is left in text so the user can identify and fix the bad payload
  assert.equal(r.text, 'bad [BncrParam:{invalid}] here');
  assert.equal(r.extra, undefined);
});

/* ===================================================================
 * 2. 文本化参数是否在正文中剥离
 * =================================================================== */
test('[BncrParam] stripped from message body', async () => {
  const r = await n({ message: 'lead [BncrParam:{"k":"v"}] trail' });
  assert.equal(r.text, 'lead trail');
});

test('[BncrParam] stripped from caption body', async () => {
  const r = await n({ caption: 'cap [BncrParam:{"k":"v"}] end' });
  assert.equal(r.text, 'cap end');
});

test('[BncrParam] stripped from message when caption also present', async () => {
  // message + caption both parsed; caption used for media text
  const r = await n({
    message: 'msg [BncrParam:{"a":1}]',
    caption: 'cap [BncrParam:{"b":2}]',
    mediaUrl: 'tests/media/x.png',
  });
  // hasMedia → text uses caption (marker stripped)
  assert.equal(r.text, 'cap');
  assert.equal(r.extra?.a, 1);
  assert.equal(r.extra?.b, 2);
});

/* ===================================================================
 * 3. 已知参数是否提前消费参与决策
 * =================================================================== */

// 3a. asVoice
test('[BncrParam] asVoice:true forces routing (no mediaUrl but hasMedia=true)', async () => {
  const r = await n({
    text: '[BncrParam:{"asVoice":true,"path":"tests/media/test_a.mp3","type":"audio"}]',
  });
  assert.equal(r.asVoice, true);
  assert.equal(r.hasMedia, true);
  assert.equal(r.mediaUrl, 'tests/media/test_a.mp3');
});

test('[BncrParam] asVoice:false overrides host asVoice:true', async () => {
  const r = await n({
    text: 'x [BncrParam:{"asVoice":false}]',
    asVoice: true,
    mediaUrl: 'tests/media/a.ogg',
  });
  assert.equal(r.asVoice, false);
  assert.equal(r.hasMedia, true);
});

// 3b. type → media routing
test('[BncrParam] type:file with remote path triggers media routing', async () => {
  const r = await n({
    text: '[BncrParam:{"type":"file","path":"tests/media/test_doc.pdf"}] text',
  });
  assert.equal(r.hasMedia, true);
  assert.equal(r.type, 'file');
  assert.equal(r.mediaUrl, 'tests/media/test_doc.pdf');
  // path stripped from extra
  assert.equal(r.extra?.path, undefined);
});

test('[BncrParam] type:voice promotes remote audio URL to media', async () => {
  const r = await n({
    text: '[BncrParam:{"type":"voice","path":"tests/media/test_audio.mp3"}] listen',
  });
  assert.equal(r.hasMedia, true);
  assert.equal(r.type, 'voice');
  assert.equal(r.mediaUrl, 'tests/media/test_audio.mp3');
  assert.equal(r.text, 'listen');
});

test('[BncrParam] type:appmsg with path is media evidence (default)', async () => {
  const r = await n({
    text: '[BncrParam:{"type":"appmsg","path":"tests/media/test_thumb.jpg","msg":"<appmsg/>"}]',
  });
  // path is media evidence by default -> media branch
  assert.equal(r.hasMedia, true);
  assert.equal(r.mediaUrl, 'tests/media/test_thumb.jpg');
  // type appmsg was not consumed -> remains in extra
  assert.equal(r.extra?.type, 'appmsg');
  assert.equal(r.extra?.msg, '<appmsg/>');
  // path is consumed as mediaUrl -> stripped from extra
  assert.equal(r.extra?.path, undefined);
});

// 3c. ismedia → force media
test('[BncrParam] ismedia:true forces remote URL to media routing', async () => {
  const r = await n({
    text: '[BncrParam:{"ismedia":true,"path":"tests/media/test_img.png"}]',
  });
  assert.equal(r.hasMedia, true);
  assert.equal(r.mediaUrl, 'tests/media/test_img.png');
  // ismedia NOT in extra
  assert.equal(r.extra?.ismedia, undefined);
});

test('[BncrParam] ismedia:false does not force remote URL to media', async () => {
  const r = await n({
    text: '[BncrParam:{"ismedia":false,"path":"tests/media/test_img.png"}] text',
  });
  // Not local, not media type, ismedia:false -> stays text
  assert.equal(r.hasMedia, false);
  assert.equal(r.extra?.path, 'tests/media/test_img.png');
});

// 3d. downloadMedia tri-state
test('[BncrParam] downloadMedia:true overrides undefined', async () => {
  const r = await n({
    text: '[BncrParam:{"downloadMedia":true,"type":"image","path":"tests/media/test_p.jpg"}]',
    mediaUrl: 'tests/media/test_q.jpg',
  });
  assert.equal(r.downloadMedia, true);
  assert.equal(r.hasMedia, true);
});

test('[BncrParam] downloadMedia:false overrides host true', async () => {
  const r = await n({
    text: '[BncrParam:{"downloadMedia":false,"type":"image","path":"tests/media/test_p.jpg"}] img',
    downloadMedia: true,
  });
  assert.equal(r.downloadMedia, false);
  assert.equal(r.hasMedia, true);
});

test('[BncrParam] downloadMedia undefined when neither marker nor host set', async () => {
  const r = await n({ text: '[BncrParam:{"type":"image","path":"tests/media/a.jpg"}]' });
  // type=image, local path -> media, no downloadMedia set
  assert.equal(r.downloadMedia, undefined);
  assert.equal(r.hasMedia, true);
});

// 3e. kind, replyToId consumed
test('[BncrParam] consumed kind is applied and stripped from extra', async () => {
  const r = await n({ text: '[BncrParam:{"kind":"tool"}] hi' });
  assert.equal(r.kind, 'tool');
  assert.equal(r.extra?.kind, undefined);
});

test('[BncrParam] consumed replyToId is applied and stripped from extra', async () => {
  const r = await n({ text: '[BncrParam:{"replyToId":"123"}] hi' });
  assert.equal(r.replyToId, '123');
  assert.equal(r.extra?.replyToId, undefined);
});

// 3f. audioAsVoice consumed
test('[BncrParam] audioAsVoice consumed', async () => {
  const r = await n({
    text: '[BncrParam:{"audioAsVoice":true}]',
    mediaUrl: 'tests/media/a.mp3',
  });
  assert.equal(r.audioAsVoice, true);
});

/* ===================================================================
 * 4. 未知参数是否原样透传
 * =================================================================== */
test('[BncrParam] unknown params pass through to extra', async () => {
  const r = await n({
    text: '[BncrParam:{"customBadge":"VIP","priority":5,"tags":["dev","ops"]}] msg',
  });
  assert.equal(r.extra?.customBadge, 'VIP');
  assert.equal(r.extra?.priority, 5);
  assert.deepEqual(r.extra?.tags, ['dev', 'ops']);
});

test('[BncrParam] multiple unknown params survive media routing (path stripped)', async () => {
  const r = await n({
    text: '[BncrParam:{"type":"image","path":"tests/media/test_x.jpg","customField":"keep"}] img',
  });
  assert.equal(r.hasMedia, true);
  assert.equal(r.type, 'image');
  // customField stays in extra
  assert.equal(r.extra?.customField, 'keep');
  // path stripped from extra
  assert.equal(r.extra?.path, undefined);
});

test('[BncrParam] forceDocument and gifPlayback survive in extra', async () => {
  const r = await n({
    text: '[BncrParam:{"forceDocument":true,"gifPlayback":true,"silent":true}]',
    mediaUrl: 'tests/media/vid.mp4',
  });
  assert.equal(r.hasMedia, true);
  // These are NOT consumption fields -> survive in extra
  assert.equal(r.extra?.forceDocument, true);
  assert.equal(r.extra?.gifPlayback, true);
  assert.equal(r.extra?.silent, true);
});

/* ===================================================================
 * 5. 透传到外发出口前是否散开到message的下层
 *
 * extra 会在最终出站出口（tgbot/geweplus adapter）散开到 message 顶层。
 * normalizeOutboundSend 的职责是保留 extra 完整，且消费字段被剥离。
 * 以下测试验证消费字段已剥离、未知字段原样保留。
 * =================================================================== */
test('[BncrParam] consumed fields stripped from extra (asVoice, type, ismedia)', async () => {
  const r = await n({
    text: '[BncrParam:{"asVoice":true,"type":"audio","ismedia":true,"customKey":"v"}] msg',
    mediaUrl: 'tests/media/a.mp3',
  });
  assert.equal(r.asVoice, true);
  assert.equal(r.type, 'audio');
  assert.equal(r.hasMedia, true);
  // consumed fields NOT in extra
  assert.equal(r.extra?.asVoice, undefined);
  assert.equal(r.extra?.ismedia, undefined);
  // unknown field survives
  assert.equal(r.extra?.customKey, 'v');
});

test('[BncrParam] media source fields stripped from extra (path, paths, mediaUrl, mediaUrls)', async () => {
  const r = await n({
    text: '[BncrParam:{"type":"image","path":"tests/media/a.jpg","paths":["tests/media/b.jpg"],"mediaUrl":"tests/media/test_c.jpg","mediaUrls":["tests/media/test_d.jpg"],"keepMe":"y"}]',
  });
  assert.equal(r.hasMedia, true);
  // When both single path and paths array, mediaUrl is undefined
  // (all sources merged into mediaUrls)
  assert.equal(r.mediaUrl, undefined);
  assert.ok(r.mediaUrls?.length >= 2);
  assert.ok(r.mediaUrls?.includes('tests/media/a.jpg'));
  assert.ok(r.mediaUrls?.includes('tests/media/b.jpg'));
  // Consumed fields stripped from extra
  assert.equal(r.extra?.path, undefined);
  assert.equal(r.extra?.paths, undefined);
  assert.equal(r.extra?.mediaUrl, undefined);
  assert.equal(r.extra?.mediaUrls, undefined);
  // Unknown field survives
  assert.equal(r.extra?.keepMe, 'y');
});

test('[BncrParam] appmsg with explicit ismedia:false stays in text branch', async () => {
  // Explicit ismedia:false overrides default path-as-media-evidence
  const r = await n({
    text: '[BncrParam:{"ismedia":false,"type":"appmsg","msg":"<appmsg/>","path":"tests/media/test_t.jpg"}]',
  });
  assert.equal(r.hasMedia, false);
  // type and path stay in extra for downstream scattering
  assert.equal(r.extra?.type, 'appmsg');
  assert.equal(r.extra?.msg, '<appmsg/>');
  assert.equal(r.extra?.path, 'tests/media/test_t.jpg');
});

test('[BncrParam] forcedoc and host-level passthrough fields survive in extra', async () => {
  const r = await n({
    text: '[BncrParam:{"forceDocument":true,"gifPlayback":true,"silent":true}]',
    mediaUrl: 'tests/media/anim.gif',
  });
  assert.equal(r.extra?.forceDocument, true);
  assert.equal(r.extra?.gifPlayback, true);
  assert.equal(r.extra?.silent, true);
});

/* ===================================================================
 * Edge: host params also merge (no marker)
 * =================================================================== */
test('[BncrParam] host-level asVoice and downloadMedia apply without marker', async () => {
  const r = await n({
    text: 'say hi',
    asVoice: true,
    downloadMedia: true,
    mediaUrl: 'tests/media/v.mp3',
  });
  // asVoice and downloadMedia are direct normalized params
  assert.equal(r.text, 'say hi');
  assert.equal(r.hasMedia, true);
  assert.equal(r.asVoice, true);
  assert.equal(r.downloadMedia, true);
});

test('[BncrParam] host downloadMedia:false passes through false (skip cascade)', async () => {
  // Host false passes through as false so scene cascade can't override it
  // sendDispatch checks downloadMedia === undefined before cascade
  const r = await n({
    text: 'x',
    downloadMedia: false,
  });
  // false is preserved for downstream to respect
  assert.equal(r.downloadMedia, false);
  assert.equal(r.asVoice, false);
});

/* ===================================================================
 * Structured `message` tool extra shares the same normalizer as BncrParam.
 * =================================================================== */
test('[structured extra] media type and downloadMedia are consumed, unknown fields survive', async () => {
  const r = await n({
    text: 'structured voice',
    mediaUrl: 'tests/media/a.mp3',
    extra: { type: 'voice', downloadMedia: true, customBadge: 'VIP' },
  });

  assert.equal(r.hasMedia, true);
  assert.equal(r.type, 'voice');
  assert.equal(r.downloadMedia, true);
  assert.equal(r.extra?.type, undefined);
  assert.equal(r.extra?.downloadMedia, undefined);
  assert.equal(r.extra?.customBadge, 'VIP');
});

test('[structured extra] appmsg type and msg pass through for downstream scatter', async () => {
  const r = await n({
    text: 'card',
    extra: { type: 'appmsg', msg: '<appmsg/>', customKey: 'keep' },
  });

  assert.equal(r.hasMedia, false);
  assert.equal(r.extra?.type, 'appmsg');
  assert.equal(r.extra?.msg, '<appmsg/>');
  assert.equal(r.extra?.customKey, 'keep');
});

test('[BncrParam] empty text and no media returns hasMedia=false, asVoice=false', async () => {
  const r = await n({});
  assert.equal(r.text, '');
  assert.equal(r.hasMedia, false);
  assert.equal(r.asVoice, false);
  assert.equal(r.audioAsVoice, false);
});
