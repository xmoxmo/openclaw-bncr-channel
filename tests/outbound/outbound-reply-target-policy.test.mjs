import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFileTransferOutboxEntry,
  buildTextOutboxEntry,
} from '../../src/core/outbox-entry-builders.ts';
import { buildBncrMediaOutboundFrame } from '../../src/messaging/outbound/media.ts';

const route = { platform: 'tgBot', groupId: '-1001', userId: '10001' };
const commonRuntime = {
  createMessageId: () => 'msg-1',
  now: () => 1000,
  normalizeAccountId: (accountId) => accountId || 'Primary',
};

function normalizeReplyToId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

test('tool text outbound strips replyToId while final keeps it', () => {
  const toolEntry = buildTextOutboxEntry({
    ...commonRuntime,
    normalizeReplyToId,
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route,
    text: 'tool progress',
    kind: 'tool',
    replyToId: 'inbound-msg-1',
  });

  const finalEntry = buildTextOutboxEntry({
    ...commonRuntime,
    normalizeReplyToId,
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route,
    text: 'final answer',
    kind: 'final',
    replyToId: 'inbound-msg-1',
  });

  assert.equal(toolEntry.payload.replyToId, undefined);
  assert.equal(toolEntry.payload.message.kind, 'tool');
  assert.equal(finalEntry.payload.replyToId, 'inbound-msg-1');
  assert.equal(finalEntry.payload.message.kind, 'final');
});

test('tool media outbound frame strips replyToId while block keeps it', () => {
  const toolFrame = buildBncrMediaOutboundFrame({
    messageId: 'media-tool-1',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route,
    media: { mode: 'chunk', mimeType: 'image/png', path: '/tmp/tool.png' },
    mediaUrl: '/tmp/tool.png',
    mediaMsg: 'tool image',
    fileName: 'tool.png',
    kind: 'tool',
    replyToId: 'inbound-msg-1',
    now: 1000,
  });

  const blockFrame = buildBncrMediaOutboundFrame({
    messageId: 'media-block-1',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route,
    media: { mode: 'chunk', mimeType: 'image/png', path: '/tmp/block.png' },
    mediaUrl: '/tmp/block.png',
    mediaMsg: 'block image',
    fileName: 'block.png',
    kind: 'block',
    replyToId: 'inbound-msg-1',
    now: 1000,
  });

  assert.equal(toolFrame.replyToId, undefined);
  assert.equal(toolFrame.message.kind, 'tool');
  assert.equal(blockFrame.replyToId, 'inbound-msg-1');
  assert.equal(blockFrame.message.kind, 'block');
});

test('tool file-transfer metadata strips replyToId while final keeps it', () => {
  const toolEntry = buildFileTransferOutboxEntry({
    ...commonRuntime,
    pushEvent: 'plugin.bncr.push',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route,
    mediaUrl: '/tmp/tool.png',
    text: 'tool file',
    kind: 'tool',
    replyToId: 'inbound-msg-1',
  });

  const finalEntry = buildFileTransferOutboxEntry({
    ...commonRuntime,
    pushEvent: 'plugin.bncr.push',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route,
    mediaUrl: '/tmp/final.png',
    text: 'final file',
    kind: 'final',
    replyToId: 'inbound-msg-1',
  });

  assert.equal(toolEntry.payload._meta.replyToId, undefined);
  assert.equal(toolEntry.payload._meta.messageKind, 'tool');
  assert.equal(finalEntry.payload._meta.replyToId, 'inbound-msg-1');
  assert.equal(finalEntry.payload._meta.messageKind, 'final');
});
