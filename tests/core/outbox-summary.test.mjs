import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeOutboxEntry } from '../../src/core/outbox-summary.ts';

const route = { platform: 'tgBot', groupId: '-1001', userId: '10001' };

function summary(entry) {
  return summarizeOutboxEntry({
    entry,
    asString(value) {
      if (typeof value === 'string') return value;
      if (value == null) return '';
      return String(value);
    },
    formatDisplayScope(route) {
      return `Bncr:${route.platform}:${route.groupId}:${route.userId}`;
    },
    summarizeTextPreview(raw) {
      return raw || '-';
    },
  });
}

function fileTransferEntry(mediaUrl, text = '', meta = {}) {
  const { type: metaType, audioAsVoice, asVoice, ...restMeta } = meta;
  // Determine type from mediaUrl extension or meta
  let type = metaType || '';
  if (!type) {
    const cleanUrl = String(mediaUrl).split(/[?#]/, 1)[0] || '';
    const ext = cleanUrl.includes('.')
      ? cleanUrl.slice(cleanUrl.lastIndexOf('.') + 1).toLowerCase()
      : '';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif'].includes(ext)) type = 'image';
    else if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].includes(ext)) type = 'video';
    else if (['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac'].includes(ext))
      type = 'audio';
    else type = 'file';
  }
  if (audioAsVoice === true || asVoice === true) type = 'voice';
  return {
    messageId: 'mid-1',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:test',
    route,
    payload: {
      type: 'message.outbound',
      sessionKey: 'agent:orion:bncr:direct:test',
      message: {
        type,
        msg: text,
        mediaUrl,
        transferMode: 'media',
        ...(audioAsVoice !== undefined ? { audioAsVoice } : {}),
        ...(asVoice !== undefined ? { asVoice } : {}),
        ...restMeta,
      },
    },
    createdAt: 0,
    retryCount: 0,
    nextAttemptAt: 0,
  };
}

test('summarizeOutboxEntry reports file-transfer image by media extension', () => {
  assert.equal(
    summary(fileTransferEntry('/root/.openclaw/workspace/avatars/avatar.jpg', 'avatar caption')),
    'image|Bncr:tgBot:-1001:10001|avatar caption',
  );
});

test('summarizeOutboxEntry prefers file-transfer request type before media extension', () => {
  assert.equal(
    summary(fileTransferEntry('/tmp/raw-file.bin', 'typed image caption', { type: 'image' })),
    'image|Bncr:tgBot:-1001:10001|typed image caption',
  );
});

test('summarizeOutboxEntry falls back to media filename when file-transfer has no caption', () => {
  assert.equal(
    summary(fileTransferEntry('/root/.openclaw/workspace/avatars/avatar.jpg')),
    'image|Bncr:tgBot:-1001:10001|avatar.jpg',
  );
  assert.equal(
    summary(fileTransferEntry('https://example.test/media/%E5%A4%B4%E5%83%8F.jpg?token=redacted')),
    'image|Bncr:tgBot:-1001:10001|头像.jpg',
  );
});

test('summarizeOutboxEntry reports file-transfer voice before extension inference', () => {
  assert.equal(
    summary(fileTransferEntry('/tmp/audio.bin', 'voice caption', { audioAsVoice: true })),
    'voice|Bncr:tgBot:-1001:10001|voice caption',
  );
});

test('summarizeOutboxEntry keeps direct outbound message type when present', () => {
  assert.equal(
    summary({
      messageId: 'mid-2',
      accountId: 'Primary',
      sessionKey: 'agent:orion:bncr:direct:test',
      route,
      payload: {
        type: 'message.outbound',
        message: {
          type: 'video',
          msg: 'video caption',
        },
      },
      createdAt: 0,
      retryCount: 0,
      nextAttemptAt: 0,
    }),
    'video|Bncr:tgBot:-1001:10001|video caption',
  );
});
