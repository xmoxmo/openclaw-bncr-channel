import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBncrMediaOutboundFrame,
  resolveBncrOutboundMessageType,
} from '../src/messaging/outbound/media.ts';

test('keeps standard hinted type when supported', () => {
  assert.equal(
    resolveBncrOutboundMessageType({
      hintedType: 'voice',
      mimeType: 'audio/ogg',
      hasPayload: true,
    }),
    'voice',
  );
});

test('voice hinted but non-audio falls back to file', () => {
  assert.equal(
    resolveBncrOutboundMessageType({
      hintedType: 'voice',
      mimeType: 'application/pdf',
      hasPayload: true,
    }),
    'file',
  );
});

test('falls back to audio by mime major type when hinted type is unsupported', () => {
  assert.equal(
    resolveBncrOutboundMessageType({
      hintedType: 'weird',
      mimeType: 'audio/mpeg',
      hasPayload: true,
    }),
    'audio',
  );
});

test('forces text payload attachments to file when mime major type is text', () => {
  assert.equal(
    resolveBncrOutboundMessageType({
      hintedType: 'text',
      mimeType: 'text/javascript',
      hasPayload: true,
    }),
    'file',
  );
});

test('falls back to file for unknown mime major type', () => {
  assert.equal(
    resolveBncrOutboundMessageType({
      hintedType: 'unknown',
      mimeType: 'application/pdf',
      hasPayload: true,
    }),
    'file',
  );
});

test('buildBncrMediaOutboundFrame writes resolved type and path', () => {
  const frame = buildBncrMediaOutboundFrame({
    messageId: 'm1',
    sessionKey: 'agent:main:bncr:direct:abc',
    route: { platform: 'tgBot', groupId: '0', userId: '6278285192' },
    media: { mode: 'chunk', mimeType: 'audio/mpeg', path: '/tmp/a.mp3' },
    mediaUrl: '',
    mediaMsg: 'hi',
    fileName: 'a.mp3',
    now: 1,
  });

  assert.equal(frame.message.type, 'audio');
  assert.equal(frame.message.path, '/tmp/a.mp3');
  assert.equal(frame.message.fileName, 'a.mp3');
});
