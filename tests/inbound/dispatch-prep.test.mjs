import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBncrInboundReplyRouteFact,
  prepareBncrInboundSessionContext,
  resolveBncrInboundConversation,
} from '../../src/messaging/inbound/dispatch-prep.ts';
import { parseBncrInboundParams } from '../../src/messaging/inbound/parse.ts';
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

function createApi(routeResult, extra = {}) {
  return {
    runtime: {
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
    readSessionUpdatedAt() {
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
  const { restore } = withInboundSessionRuntimeStub({
    resolveStorePath(storeConfig, options) {
      return `/tmp/${String(storeConfig || 'store')}-${options?.agentId || 'unknown'}.json`;
    },
    readSessionUpdatedAt() {
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
      rememberSessionRoute() {},
    });

    assert.equal(prepared.rawBody, '<media:image> (2 images)');
    assert.equal(prepared.mediaItems.length, 2);
    assert.deepEqual(prepared.mediaItems, [
      {
        path: '/tmp/inbound.bin',
        contentType: 'image/png',
        fileName: 'a.png',
        kind: 'image',
      },
      {
        path: '/tmp/inbound.bin',
        contentType: 'image/jpeg',
        fileName: 'b.jpg',
        kind: 'image',
      },
    ]);
  } finally {
    restore();
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
    originatingTo: 'Bncr:tgBot:-1001:10001?raw',
    chatType: 'group',
  });
});
