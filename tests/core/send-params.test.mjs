import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBncrSendParams } from '../../src/messaging/outbound/send-params.ts';

const baseInput = {
  accountId: 'Primary',
};

test('normalizes text send params', () => {
  assert.deepEqual(
    normalizeBncrSendParams({
      ...baseInput,
      params: {
        to: ' Bncr:tgBot:-1001:10001 ',
        message: ' hello ',
      },
    }),
    {
      to: 'Bncr:tgBot:-1001:10001',
      accountId: 'Primary',
      message: 'hello',
      caption: '',
      mediaUrl: undefined,
      mediaUrls: undefined,
      asVoice: false,
      audioAsVoice: false,
    },
  );
});

test('falls back from caption to message when media is absent', () => {
  assert.deepEqual(
    normalizeBncrSendParams({
      ...baseInput,
      params: {
        to: 'target',
        caption: 'caption only',
      },
    }),
    {
      to: 'target',
      accountId: 'Primary',
      message: 'caption only',
      caption: '',
      mediaUrl: undefined,
      mediaUrls: undefined,
      asVoice: false,
      audioAsVoice: false,
    },
  );
});

test('media field takes priority over path, filePath, and mediaUrl', () => {
  const normalized = normalizeBncrSendParams({
    ...baseInput,
    params: {
      to: 'target',
      message: 'media caption',
      media: ' /tmp/media.png ',
      path: '/tmp/path.png',
      filePath: '/tmp/file-path.png',
      mediaUrl: '/tmp/media-url.png',
    },
  });

  assert.equal(normalized.message, '');
  assert.equal(normalized.caption, 'media caption');
  assert.equal(normalized.mediaUrl, ' /tmp/media.png ');
});

test('path is used when media is absent', () => {
  const normalized = normalizeBncrSendParams({
    ...baseInput,
    params: {
      to: 'target',
      caption: 'path caption',
      path: '/tmp/path.png',
      filePath: '/tmp/file-path.png',
      mediaUrl: '/tmp/media-url.png',
    },
  });

  assert.equal(normalized.caption, 'path caption');
  assert.equal(normalized.mediaUrl, '/tmp/path.png');
});

test('filePath is used when media and path are absent', () => {
  const normalized = normalizeBncrSendParams({
    ...baseInput,
    params: {
      to: 'target',
      message: 'filePath caption',
      filePath: '/tmp/file-path.png',
      mediaUrl: '/tmp/media-url.png',
    },
  });

  assert.equal(normalized.caption, 'filePath caption');
  assert.equal(normalized.mediaUrl, '/tmp/file-path.png');
});

test('mediaUrl is used when media, path, and filePath are absent', () => {
  const normalized = normalizeBncrSendParams({
    ...baseInput,
    params: {
      to: 'target',
      message: 'mediaUrl caption',
      mediaUrl: '/tmp/media-url.png',
      audioAsVoice: true,
    },
  });

  assert.equal(normalized.caption, 'mediaUrl caption');
  assert.equal(normalized.mediaUrl, '/tmp/media-url.png');
  assert.equal(normalized.audioAsVoice, true);
});

test('extra object is preserved as a shallow copy for send params', () => {
  const extra = { replyMarkup: { inline_keyboard: [] }, priority: 1 };
  const normalized = normalizeBncrSendParams({
    ...baseInput,
    params: {
      to: 'target',
      message: 'hello',
      extra,
    },
  });

  assert.deepEqual(normalized.extra, extra);
  assert.notEqual(normalized.extra, extra);

  extra.priority = 2;
  assert.equal(normalized.extra.priority, 1);
});

test('non-object extra is ignored for send params', () => {
  const normalized = normalizeBncrSendParams({
    ...baseInput,
    params: {
      to: 'target',
      message: 'hello',
      extra: ['bad'],
    },
  });

  assert.equal(normalized.extra, undefined);
});

test('mediaUrls are normalized as media send input when single mediaUrl is absent', () => {
  const normalized = normalizeBncrSendParams({
    ...baseInput,
    params: {
      to: 'target',
      message: 'album caption',
      mediaUrls: [' /tmp/one.png ', '', '/tmp/two.png', 123],
    },
  });

  assert.equal(normalized.message, '');
  assert.equal(normalized.caption, 'album caption');
  assert.equal(normalized.mediaUrl, undefined);
  assert.deepEqual(normalized.mediaUrls, ['/tmp/one.png', '/tmp/two.png']);
});

test('mediaUrl is merged into mediaUrls without duplication', () => {
  const normalized = normalizeBncrSendParams({
    ...baseInput,
    params: {
      to: 'target',
      caption: 'merged media',
      mediaUrl: '/tmp/one.png',
      mediaUrls: [' /tmp/two.png ', '/tmp/one.png', ''],
    },
  });

  assert.equal(normalized.caption, 'merged media');
  assert.equal(normalized.mediaUrl, undefined);
  assert.deepEqual(normalized.mediaUrls, ['/tmp/two.png', '/tmp/one.png']);
});

test('asVoice without media throws', () => {
  assert.throws(
    () =>
      normalizeBncrSendParams({
        ...baseInput,
        params: {
          to: 'target',
          message: 'voice text',
          asVoice: true,
        },
      }),
    /send voice requires media path/,
  );
});

test('asVoice allows mediaUrls without single mediaUrl', () => {
  const normalized = normalizeBncrSendParams({
    ...baseInput,
    params: {
      to: 'target',
      caption: 'voice album',
      mediaUrls: ['/tmp/voice-1.ogg', '/tmp/voice-2.ogg'],
      asVoice: true,
    },
  });

  assert.equal(normalized.caption, 'voice album');
  assert.equal(normalized.mediaUrl, undefined);
  assert.deepEqual(normalized.mediaUrls, ['/tmp/voice-1.ogg', '/tmp/voice-2.ogg']);
  assert.equal(normalized.asVoice, true);
});

test('empty content without media throws', () => {
  assert.throws(
    () =>
      normalizeBncrSendParams({
        ...baseInput,
        params: {
          to: 'target',
          message: '   ',
          caption: '',
        },
      }),
    /send requires message or media/,
  );
});
