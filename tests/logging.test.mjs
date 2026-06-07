import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  buildBncrDebugJsonMessage,
  formatBncrLogLine,
  normalizeBncrLogLine,
  summarizeBncrTextPreview,
} from '../src/core/logging.ts';

function sha12(raw) {
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

function parseDebugPayload(message) {
  return JSON.parse(message.slice(message.indexOf(' ') + 1));
}

test('formatBncrLogLine normalizes scope and message', () => {
  assert.equal(formatBncrLogLine(' inbound ', ' hello '), '[bncr] inbound hello');
  assert.equal(formatBncrLogLine('', 'hello'), '[bncr] hello');
  assert.equal(formatBncrLogLine('debug', ''), '[bncr] debug');
});

test('normalizeBncrLogLine preserves existing prefix', () => {
  assert.equal(normalizeBncrLogLine('ready'), '[bncr] ready');
  assert.equal(normalizeBncrLogLine('[bncr] ready'), '[bncr] ready');
  assert.equal(normalizeBncrLogLine(''), '[bncr]');
});

test('buildBncrDebugJsonMessage appends serialized payload', () => {
  assert.equal(
    buildBncrDebugJsonMessage('event-name', { ok: true, count: 2 }),
    'event-name {"ok":true,"count":2}',
  );
});

test('buildBncrDebugJsonMessage summarizes text fields without full long body', () => {
  const longText = '  sensitive token abc123\n'.repeat(4);
  const message = buildBncrDebugJsonMessage('send-entry:text', { text: longText });
  const payload = parseDebugPayload(message);

  assert.equal(payload.text.preview, 'sensitive token abc123 s…');
  assert.equal(payload.text.length, longText.replace(/\s+/g, ' ').trim().length);
  assert.equal(payload.text.sha256, sha12(longText.replace(/\s+/g, ' ').trim()));
  assert.doesNotMatch(message, /abc123 sensitive token abc123/);
});

test('buildBncrDebugJsonMessage summarizes media urls by basename and hash', () => {
  const mediaUrl = 'https://cdn.example.test/private/photo.png?token=secret-token';
  const localPath = '/var/tmp/audio/private voice.ogg';
  const localPathWithQuery = '/var/tmp/audio/report.pdf?token=secret-token#frag';
  const message = buildBncrDebugJsonMessage('send-entry:media', {
    mediaUrl,
    mediaUrls: [mediaUrl, localPath, localPathWithQuery, ''],
    nested: { path: 'file:///tmp/nested/report.pdf?sig=secret' },
  });
  const payload = parseDebugPayload(message);

  assert.deepEqual(payload.mediaUrl, {
    basename: 'photo.png',
    scheme: 'https',
    sha256: sha12(mediaUrl),
  });
  assert.deepEqual(payload.mediaUrls[0], {
    basename: 'photo.png',
    scheme: 'https',
    sha256: sha12(mediaUrl),
  });
  assert.deepEqual(payload.mediaUrls[1], {
    basename: 'private voice.ogg',
    scheme: 'path',
    sha256: sha12(localPath),
  });
  assert.deepEqual(payload.mediaUrls[2], {
    basename: 'report.pdf',
    scheme: 'path',
    sha256: sha12(localPathWithQuery),
  });
  assert.equal(payload.mediaUrls[3], '');
  assert.deepEqual(payload.nested.path, {
    basename: 'report.pdf',
    scheme: 'file',
    sha256: sha12('file:///tmp/nested/report.pdf?sig=secret'),
  });
  assert.doesNotMatch(message, /secret-token|sig=secret|\/var\/tmp\/audio|frag/);
});

test('buildBncrDebugJsonMessage redacts sensitive debug payload keys', () => {
  const message = buildBncrDebugJsonMessage('debug:secret', {
    accessToken: 'token-123',
    password: 'pw-123',
    authorization: 'Bearer abc',
    cookie: 'sid=secret-cookie',
    nested: {
      clientSecret: 'secret-123',
      apiKey: 'api-key-123',
      safe: 'kept',
    },
    tokens: ['token-a', 'token-b'],
  });
  const payload = parseDebugPayload(message);

  assert.equal(payload.accessToken, '[redacted]');
  assert.equal(payload.password, '[redacted]');
  assert.equal(payload.authorization, '[redacted]');
  assert.equal(payload.cookie, '[redacted]');
  assert.equal(payload.nested.clientSecret, '[redacted]');
  assert.equal(payload.nested.apiKey, '[redacted]');
  assert.equal(payload.nested.safe, 'kept');
  assert.equal(payload.tokens, '[redacted]');
  assert.doesNotMatch(
    message,
    /token-123|pw-123|Bearer abc|secret-cookie|secret-123|api-key-123|token-a/,
  );
});

test('summarizeBncrTextPreview compacts whitespace and respects unicode boundaries', () => {
  assert.equal(summarizeBncrTextPreview('  hello\n  world  ', 20), 'hello world');
  assert.equal(summarizeBncrTextPreview('', 8), '-');
  assert.equal(summarizeBncrTextPreview('陌陌陌陌', 3), '陌陌陌…');
  assert.equal(summarizeBncrTextPreview('abcdef', 0), 'a…');
});
