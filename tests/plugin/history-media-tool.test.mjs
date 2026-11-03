import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BncrMediaSourceError } from '../../src/messaging/inbound/media-assets.ts';
import {
  BNCR_HISTORY_MEDIA_TOOL_NAME,
  createBncrHistoryMediaToolFactory,
} from '../../src/plugin/history-media-tool.ts';

function trustedContext(overrides = {}) {
  let currentChecks = 0;
  const ctx = {
    messageChannel: 'bncr',
    agentId: 'orion',
    sessionKey: 'agent:orion:bncr:group:-1001',
    agentAccountId: 'Primary',
    assertInvocationCurrent() {
      currentChecks += 1;
    },
    ...overrides,
  };

  return {
    ctx,
    get currentChecks() {
      return currentChecks;
    },
  };
}

const input = {
  source: 'https://example.test/history.pdf',
  sourceKind: 'url',
  mediaRef: 'bncr-media:test-tool-1',
  contentType: 'application/pdf',
  fileName: 'report.pdf',
};

test('history media tool is available for non-BNCR host run labels', () => {
  const factory = createBncrHistoryMediaToolFactory({
    getBridge: () => {
      throw new Error('bridge must not be read while discovering tools');
    },
  });

  assert.equal(factory.contextVersion, 2);
  assert.equal(factory.create(trustedContext({ messageChannel: 'telegram' }).ctx).length, 1);
  assert.equal(factory.create(trustedContext({ messageChannel: undefined }).ctx).length, 1);
  assert.equal(factory.create(trustedContext({ messageChannel: 'webchat' }).ctx).length, 1);
  assert.equal(factory.create(trustedContext().ctx).length, 1);
});

test('history media tool passes the explicit source contract and trusted turn identity', async () => {
  const calls = [];
  const trusted = trustedContext();
  const factory = createBncrHistoryMediaToolFactory({
    getBridge: () => ({
      async downloadHistoryMedia(args) {
        calls.push(args);
        return {
          mediaRef: args.mediaRef,
          mediaUri: 'media://inbound/history.pdf',
          hostPath: '/host/only/history.pdf',
          contentType: args.contentType,
          fileName: args.fileName,
          sizeBytes: 42,
        };
      },
    }),
  });
  const [tool] = factory.create(trusted.ctx);

  assert.equal(tool.name, BNCR_HISTORY_MEDIA_TOOL_NAME);
  const result = await tool.execute('call-1', {
    ...input,
    accountId: 'Secondary',
    agentId: 'must-not-win',
    sessionKey: 'must-not-win-either',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].accountId, 'Primary');
  assert.equal(calls[0].agentId, 'orion');
  assert.equal(calls[0].sessionKey, 'agent:orion:bncr:group:-1001');
  assert.equal(calls[0].source, input.source);
  assert.equal(calls[0].sourceKind, 'url');
  assert.equal(calls[0].mediaRef, input.mediaRef);
  assert.equal(calls[0].contentType, input.contentType);
  assert.equal(calls[0].fileName, input.fileName);
  assert.equal(calls[0].assertCurrent, trusted.ctx.assertInvocationCurrent);
  assert.equal(trusted.currentChecks, 2);
  assert.deepEqual(result.details, {
    ok: true,
    mediaRef: input.mediaRef,
    source: input.source,
    sourceKind: 'url',
    path: 'media://inbound/history.pdf',
    contentType: input.contentType,
    fileName: input.fileName,
    sizeBytes: 42,
  });
});

test('history media tool returns image media as image content', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bncr-history-tool-'));
  const imagePath = path.join(tempDir, 'history.png');
  await writeFile(
    imagePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const trusted = trustedContext();
  const factory = createBncrHistoryMediaToolFactory({
    getBridge: () => ({
      async downloadHistoryMedia(args) {
        args.assertCurrent();
        return {
          mediaRef: args.mediaRef,
          mediaUri: 'media://inbound/history.png',
          hostPath: imagePath,
          contentType: 'image/png',
          fileName: 'history.png',
        };
      },
    }),
  });
  try {
    const [tool] = factory.create(trusted.ctx);
    const result = await tool.execute('call-2', {
      source: '/root/.openclaw/media/history/public/history.png',
      sourceKind: 'local',
      mediaRef: 'bncr-media:test-tool-2',
      contentType: 'image/png',
    });

    assert.ok(result.content.some((item) => item.type === 'image'));
    assert.equal(result.details.mediaRef, 'bncr-media:test-tool-2');
    assert.equal(result.details.path, 'media://inbound/history.png');
    assert.equal(result.details.sourceKind, 'local');
    assert.equal(trusted.currentChecks, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('history media tool returns source validation codes without invoking the bridge', async () => {
  const calls = [];
  const factory = createBncrHistoryMediaToolFactory({
    getBridge: () => ({
      async downloadHistoryMedia(args) {
        calls.push(args);
        throw new BncrMediaSourceError('SOURCE_NOT_FOUND', 'gone');
      },
    }),
  });
  const [tool] = factory.create(trustedContext().ctx);

  const missingSource = await tool.execute('call-3', {
    sourceKind: 'url',
    mediaRef: 'bncr-media:only-ref',
  });
  assert.equal(missingSource.details.code, 'SOURCE_REQUIRED');

  const invalidKind = await tool.execute('call-4', {
    source: input.source,
    sourceKind: 'remote',
  });
  assert.equal(invalidKind.details.code, 'SOURCE_KIND_INVALID');

  const unavailable = await tool.execute('call-5', {
    source: '/root/.openclaw/media/history/public/gone.png',
    sourceKind: 'local',
  });
  assert.equal(unavailable.details.code, 'SOURCE_NOT_FOUND');
  assert.equal(calls.length, 1);
});
