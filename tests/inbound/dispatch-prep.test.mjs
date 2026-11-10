import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildBncrInboundReplyRouteFact,
  prepareBncrInboundSessionContext,
  resolveBncrInboundConversation,
} from '../../src/messaging/inbound/dispatch-prep.ts';
import { parseBncrInboundParams } from '../../src/messaging/inbound/parse.ts';
import { installBncrTestMediaStorage } from '../helpers/bncr-media-storage.mjs';
import { withInboundSessionRuntimeStub } from '../helpers/inbound-runtime.mjs';

function createParsed(overrides = {}) {
  return {
    accountId: 'Primary',
    route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
    peer: { kind: 'group', id: 'Bncr:tgBot:-1001:10001' },
    sessionKeyfromroute: '',
    providedOriginatingTo: '',
    extracted: {},
    msgType: 'text',
    mediaBase64: '',
    mediaPathFromTransfer: '',
    mimeType: 'text/plain',
    fileName: '',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    ...overrides,
  };
}

function createApi(routeResult, extra = {}, workspaceRoot = '/tmp/bncr-test-workspaces') {
  return {
    runtime: {
      agent: {
        resolveAgentWorkspaceDir(_cfg, agentId) {
          return path.join(workspaceRoot, agentId);
        },
      },
      channel: {
        routing: {
          resolveAgentRoute() {
            return routeResult;
          },
        },
        reply: {
          resolveEnvelopeFormatOptions() {
            return { style: 'test' };
          },
          formatAgentEnvelope({ body, previousTimestamp, envelope }) {
            return `ENV:${body}:${String(previousTimestamp)}:${envelope.style}`;
          },
        },
        media: {
          async saveMediaBuffer() {
            return { path: '/tmp/inbound.bin' };
          },
        },
        session: {
          readSessionUpdatedAt() {
            return 42;
          },
        },
      },
    },
    ...extra,
  };
}

test('parseBncrInboundParams prefers mediaList and falls back to legacy path/base64 fields', () => {
  const parsedWithList = parseBncrInboundParams({
    accountId: 'Primary',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'image',
    mediaList: [
      { path: '/tmp/a.png', mimeType: 'image/png', fileName: 'a.png', type: 'image' },
      { path: '/tmp/b.jpg', mimeType: 'image/jpeg', fileName: 'b.jpg', type: 'image' },
    ],
    path: '/tmp/legacy.png',
  });
  assert.deepEqual(parsedWithList.mediaItems, [
    { path: '/tmp/a.png', mimeType: 'image/png', fileName: 'a.png', type: 'image' },
    { path: '/tmp/b.jpg', mimeType: 'image/jpeg', fileName: 'b.jpg', type: 'image' },
  ]);

  const parsedLegacy = parseBncrInboundParams({
    accountId: 'Primary',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'image',
    path: '/tmp/legacy.png',
    mimeType: 'image/png',
    fileName: 'legacy.png',
  });
  assert.deepEqual(parsedLegacy.mediaItems, [
    { path: '/tmp/legacy.png', mimeType: 'image/png', fileName: 'legacy.png', type: 'image' },
  ]);
});

test('resolveBncrInboundConversation throws when resolved route sessionKey is empty', () => {
  assert.throws(
    () =>
      resolveBncrInboundConversation({
        api: createApi({ sessionKey: ' ', agentId: 'orion' }),
        cfg: {},
        channelId: 'bncr',
        parsed: createParsed(),
        canonicalAgentId: 'orion',
      }),
    /empty sessionKey/,
  );
});

test('resolveBncrInboundConversation throws when resolved route agentId is empty', () => {
  assert.throws(
    () =>
      resolveBncrInboundConversation({
        api: createApi({ sessionKey: 'agent:orion:bncr:direct:demo', agentId: ' ' }),
        cfg: {},
        channelId: 'bncr',
        parsed: createParsed(),
        canonicalAgentId: 'orion',
      }),
    /empty agentId/,
  );
});

test('prepareBncrInboundSessionContext resolves storePath from resolved agentId', async () => {
  const rememberCalls = [];
  const { restore } = withInboundSessionRuntimeStub({
    resolveStorePath(storeConfig, options) {
      return `/tmp/${String(storeConfig || 'store')}-${options?.agentId || 'unknown'}.json`;
    },
    async readSessionUpdatedAtAsync() {
      return 42;
    },
  });
  const resolution = resolveBncrInboundConversation({
    api: createApi({ sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion-worker' }),
    cfg: { session: { store: '/tmp/store' } },
    channelId: 'bncr',
    parsed: createParsed(),
    canonicalAgentId: 'orion',
  });

  try {
    const prepared = await prepareBncrInboundSessionContext({
      api: createApi({ sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion-worker' }),
      cfg: { session: { store: '/tmp/store' } },
      parsed: createParsed({ extracted: { text: 'hello inbound' } }),
      resolution,
      rememberSessionRoute(sessionKey, accountId, route) {
        rememberCalls.push({ sessionKey, accountId, route });
      },
    });

    assert.match(prepared.storePath, /orion-worker/);
    assert.equal(prepared.rawBody, 'hello inbound');
    assert.equal(prepared.body, 'ENV:hello inbound:42:test');
    assert.deepEqual(rememberCalls, [
      {
        sessionKey: resolution.baseSessionKey,
        accountId: 'Primary',
        route: resolution.route,
      },
    ]);
  } finally {
    restore();
  }
});

test('prepareBncrInboundSessionContext saves multiple inbound media items and builds aggregated placeholder', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  const { restore } = withInboundSessionRuntimeStub({
    resolveStorePath(storeConfig, options) {
      return `/tmp/${String(storeConfig || 'store')}-${options?.agentId || 'unknown'}.json`;
    },
    async readSessionUpdatedAtAsync() {
      return 42;
    },
  });
  const api = createApi({ sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion-worker' });
  const resolution = resolveBncrInboundConversation({
    api,
    cfg: { session: { store: '/tmp/store' } },
    channelId: 'bncr',
    parsed: createParsed(),
    canonicalAgentId: 'orion',
  });

  try {
    const prepared = await prepareBncrInboundSessionContext({
      api,
      cfg: { session: { store: '/tmp/store' } },
      parsed: createParsed({
        msgType: 'image',
        extracted: { text: '收到媒体文件' },
        mediaItems: [
          {
            base64: Buffer.from('a').toString('base64'),
            mimeType: 'image/png',
            fileName: 'a.png',
            type: 'image',
          },
          {
            base64: Buffer.from('b').toString('base64'),
            mimeType: 'image/jpeg',
            fileName: 'b.jpg',
            type: 'image',
          },
        ],
      }),
      resolution,
      currentTurn: true,
      rememberSessionRoute() {},
    });

    assert.equal(prepared.rawBody, '<media:image> (2 images)');
    assert.equal(prepared.mediaItems.length, 2);
    assert.equal(prepared.mediaItems.length, 2);
    assert.match(prepared.mediaItems[0].mediaId, /^bncr-media:/);
    assert.match(prepared.mediaItems[1].mediaId, /^bncr-media:/);
    assert.equal(prepared.mediaItems[0].originAgentId, 'orion-worker');
    assert.equal(prepared.mediaItems[0].attachmentScope, 'current');
    assert.equal(prepared.mediaItems[0].sourceKind, 'buffer');
    assert.match(prepared.mediaItems[0].storedPath, /\/history\/orion-worker\/.+\.png$/);
    assert.equal(prepared.mediaItems[0].path, prepared.mediaItems[0].storedPath);
    assert.match(prepared.mediaItems[0].path, /\/history\/orion-worker\/.+\.png$/);
    assert.ok(prepared.mediaItems[0].path.startsWith(mediaStorage.root));
    assert.equal((await readFile(prepared.mediaItems[0].path)).toString(), 'a');
    assert.equal((await readFile(prepared.mediaItems[1].path)).toString(), 'b');
  } finally {
    await mediaStorage.restore();
    restore();
  }
});

test('historical URL stays deferred until an explicit download request', async () => {
  let downloads = 0;
  const api = createApi(
    { sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion' },
    {
      runtime: {
        channel: {
          routing: {
            resolveAgentRoute() {
              return { sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion' };
            },
          },
          reply: {
            resolveEnvelopeFormatOptions() {
              return { style: 'test' };
            },
            formatAgentEnvelope({ body }) {
              return `ENV:${body}`;
            },
          },
          session: {
            readSessionUpdatedAt() {
              return 0;
            },
          },
          media: {
            async readRemoteMediaBuffer() {
              downloads += 1;
              return { buffer: Buffer.from('should-not-download'), contentType: 'image/jpeg' };
            },
          },
        },
      },
    },
  );
  const parsed = createParsed({
    msgType: 'image',
    extracted: { text: 'old image' },
    mediaItems: [{ path: 'https://example.test/old.jpg', mimeType: 'image/jpeg', type: 'image' }],
    msgId: 'historical-url-1',
  });
  const resolution = resolveBncrInboundConversation({
    api,
    cfg: {},
    channelId: 'bncr',
    parsed,
    canonicalAgentId: 'orion',
  });
  const prepared = await prepareBncrInboundSessionContext({
    api,
    cfg: {},
    parsed,
    resolution,
    currentTurn: false,
    rememberSessionRoute() {},
  });

  assert.equal(downloads, 0);
  assert.equal(prepared.mediaItems[0].url, 'https://example.test/old.jpg');
  assert.equal(prepared.mediaItems[0].status, 'deferred');
  assert.equal(prepared.mediaItems[0].path, undefined);
  assert.equal(prepared.mediaItems[0].attachmentScope, 'historical');
});

test('current URL downloads once and retains the original URL beside the local path', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  let downloads = 0;
  const api = createApi(
    { sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion' },
    {
      runtime: {
        channel: {
          routing: {
            resolveAgentRoute() {
              return { sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion' };
            },
          },
          reply: {
            resolveEnvelopeFormatOptions() {
              return { style: 'test' };
            },
            formatAgentEnvelope({ body }) {
              return `ENV:${body}`;
            },
          },
          session: {
            readSessionUpdatedAt() {
              return 0;
            },
          },
          media: {
            async readRemoteMediaBuffer() {
              downloads += 1;
              return { buffer: Buffer.from('current'), contentType: 'image/png' };
            },
          },
        },
      },
    },
  );
  try {
    const parsed = createParsed({
      msgType: 'image',
      extracted: { text: 'current image' },
      mediaItems: [{ path: 'https://example.test/current.png', type: 'image' }],
      msgId: 'current-url-1',
    });
    const resolution = resolveBncrInboundConversation({
      api,
      cfg: {},
      channelId: 'bncr',
      parsed,
      canonicalAgentId: 'orion',
    });
    const prepared = await prepareBncrInboundSessionContext({
      api,
      cfg: {},
      parsed,
      resolution,
      currentTurn: true,
      rememberSessionRoute() {},
    });

    assert.equal(downloads, 1);
    assert.equal(prepared.mediaItems[0].url, 'https://example.test/current.png');
    assert.equal(prepared.mediaItems[0].attachmentScope, 'current');
    assert.equal(prepared.mediaItems[0].status, 'ready');
    assert.equal(prepared.mediaItems[0].path, prepared.mediaItems[0].storedPath);
    assert.match(prepared.mediaItems[0].path, /\/history\/orion\/.+$/);
    assert.ok(prepared.mediaItems[0].path.startsWith(mediaStorage.root));
    assert.equal((await readFile(prepared.mediaItems[0].path)).toString(), 'current');
  } finally {
    await mediaStorage.restore();
  }
});

test('current URL failure keeps the message metadata and does not block the turn', async () => {
  const api = createApi(
    { sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion' },
    {
      runtime: {
        channel: {
          routing: {
            resolveAgentRoute() {
              return { sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion' };
            },
          },
          reply: {
            resolveEnvelopeFormatOptions() {
              return { style: 'test' };
            },
            formatAgentEnvelope({ body }) {
              return `ENV:${body}`;
            },
          },
          session: {
            readSessionUpdatedAt() {
              return 0;
            },
          },
          media: {
            async readRemoteMediaBuffer() {
              throw new Error('offline');
            },
          },
        },
      },
    },
  );
  const parsed = createParsed({
    msgType: 'image',
    extracted: { text: 'failed image' },
    mediaItems: [{ path: 'http://127.0.0.1:1/offline.png', type: 'image' }],
    msgId: 'current-url-failed',
  });
  const resolution = resolveBncrInboundConversation({
    api,
    cfg: {},
    channelId: 'bncr',
    parsed,
    canonicalAgentId: 'orion',
  });
  const prepared = await prepareBncrInboundSessionContext({
    api,
    cfg: {},
    parsed,
    resolution,
    currentTurn: true,
    rememberSessionRoute() {},
  });

  assert.equal(prepared.mediaItems.length, 1);
  assert.equal(prepared.mediaItems[0].url, 'http://127.0.0.1:1/offline.png');
  assert.equal(prepared.mediaItems[0].status, 'fetch_failed');
  assert.equal(prepared.mediaItems[0].path, undefined);
});

test('historical local media stays deferred until the agent reads it', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'bncr-local-workspace-'));
  const workspaceDir = path.join(workspaceRoot, 'orion');
  await mkdir(workspaceDir, { recursive: true });
  const sourcePath = path.join(workspaceDir, 'old.bin');
  await writeFile(sourcePath, 'local');
  const api = createApi(
    { sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion' },
    {},
    workspaceRoot,
  );
  try {
    const parsed = createParsed({
      msgType: 'file',
      extracted: { text: 'old file' },
      mediaItems: [{ path: sourcePath, type: 'file' }],
      msgId: 'historical-local-deferred',
    });
    const resolution = resolveBncrInboundConversation({
      api,
      cfg: {},
      channelId: 'bncr',
      parsed,
      canonicalAgentId: 'orion',
    });
    const prepared = await prepareBncrInboundSessionContext({
      api,
      cfg: {},
      parsed,
      resolution,
      currentTurn: false,
      rememberSessionRoute() {},
    });

    assert.equal(prepared.mediaItems[0].status, 'deferred');
    assert.equal(prepared.mediaItems[0].originAgentId, 'orion');
    assert.equal(prepared.mediaItems[0].sourceKind, 'local');
    assert.equal(prepared.mediaItems[0].sourceRef, sourcePath);
    assert.equal(prepared.mediaItems[0].storedPath, undefined);
    assert.equal(prepared.mediaItems[0].path, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await mediaStorage.restore();
  }
});

test('current local media is copied only from the origin agent workspace', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'bncr-local-workspace-'));
  const workspaceDir = path.join(workspaceRoot, 'orion');
  const outsideDir = await mkdtemp(path.join(tmpdir(), 'bncr-local-outside-'));
  await mkdir(workspaceDir, { recursive: true });
  const sourcePath = path.join(workspaceDir, 'current.bin');
  const outsidePath = path.join(outsideDir, 'secret.bin');
  const linkedPath = path.join(workspaceDir, 'linked.bin');
  await writeFile(sourcePath, 'current-local');
  await writeFile(outsidePath, 'secret');
  await symlink(outsidePath, linkedPath);
  const api = createApi(
    { sessionKey: 'agent:orion:bncr:direct:demo', agentId: 'orion' },
    {},
    workspaceRoot,
  );

  async function prepareLocal(pathValue, msgId) {
    const parsed = createParsed({
      msgType: 'file',
      extracted: { text: msgId },
      mediaItems: [{ path: pathValue, type: 'file' }],
      msgId,
    });
    const resolution = resolveBncrInboundConversation({
      api,
      cfg: {},
      channelId: 'bncr',
      parsed,
      canonicalAgentId: 'orion',
    });
    return await prepareBncrInboundSessionContext({
      api,
      cfg: {},
      parsed,
      resolution,
      currentTurn: true,
      rememberSessionRoute() {},
    });
  }

  try {
    const ready = await prepareLocal(sourcePath, 'current-local-ready');
    assert.equal(ready.mediaItems[0].status, 'ready');
    assert.match(ready.mediaItems[0].storedPath, /\/history\/orion\/.+\.bin$/);
    assert.equal(ready.mediaItems[0].path, ready.mediaItems[0].storedPath);
    assert.equal((await readFile(ready.mediaItems[0].path)).toString(), 'current-local');

    api.runtime.config = {
      current() {
        return { channels: { bncr: { mediaMaxMb: 0.000001 } } };
      },
    };
    const oversized = await prepareLocal(sourcePath, 'current-local-oversize');
    assert.equal(oversized.mediaItems[0].status, 'oversize');
    assert.equal(oversized.mediaItems[0].storedPath, undefined);

    api.runtime.config = {
      current() {
        return { channels: { bncr: { mediaMaxMb: 2048 } } };
      },
    };
    const outside = await prepareLocal(outsidePath, 'current-local-outside');
    assert.equal(outside.mediaItems[0].status, 'unavailable');
    assert.equal(outside.mediaItems[0].storedPath, undefined);

    const linked = await prepareLocal(linkedPath, 'current-local-linked');
    assert.equal(linked.mediaItems[0].status, 'unavailable');
    assert.equal(linked.mediaItems[0].storedPath, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await mediaStorage.restore();
  }
});

test('buildBncrInboundReplyRouteFact maps dispatch route fields exactly', () => {
  const fact = buildBncrInboundReplyRouteFact({
    accountId: 'Primary',
    chatType: 'group',
    route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
    resolvedRoute: {
      sessionKey: 'agent:orion:bncr:group:demo',
      agentId: 'orion',
      mainSessionKey: 'agent:orion:bncr:group:main',
    },
    canonicalTo: 'Bncr:tgBot:-1001:10001',
    rawTo: 'Bncr:tgBot:-1001:10001',
    originatingTo: 'Bncr:tgBot:-1001:10001?raw',
    baseSessionKey: 'agent:orion:bncr:group:demo',
    dispatchSessionKey: 'agent:orion:bncr:group:demo#task',
  });

  assert.deepEqual(fact, {
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:group:demo#task',
    route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
    canonicalTo: 'Bncr:tgBot:-1001:10001',
    rawTo: 'Bncr:tgBot:-1001:10001',
    originatingTo: 'Bncr:tgBot:-1001:10001?raw',
    chatType: 'group',
  });
});
