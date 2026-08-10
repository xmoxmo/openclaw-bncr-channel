import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  assertInboundMediaBase64Size,
  decodeInboundMediaBase64,
  dispatchBncrInbound,
  estimateBase64DecodedBytes,
} from '../../src/messaging/inbound/dispatch.ts';
import { downloadInboundMediaUrl } from '../../src/messaging/inbound/media-url-download.ts';
import { parseBncrInboundParams } from '../../src/messaging/inbound/parse.ts';
import { loadInboundRemoteMedia } from '../../src/messaging/inbound/remote-media.ts';
import { createInboundApiStub } from '../helpers/inbound-runtime.mjs';

test('estimateBase64DecodedBytes accounts for padding and whitespace before inbound media guard', () => {
  assert.equal(estimateBase64DecodedBytes('TWFu'), 3);
  assert.equal(estimateBase64DecodedBytes('TWE='), 2);
  assert.equal(estimateBase64DecodedBytes('TQ=='), 1);
  assert.equal(estimateBase64DecodedBytes(' T W F u\n'), 3);
  assert.doesNotThrow(() => assertInboundMediaBase64Size('TWFu', 3));
  assert.throws(
    () => assertInboundMediaBase64Size('TWFu', 2),
    /inbound media too large: estimated 3 bytes exceeds 2 bytes/,
  );
});

test('decodeInboundMediaBase64 rejects empty decoded media and decoded oversize payloads', () => {
  assert.equal(decodeInboundMediaBase64(' T 2s= ').toString(), 'Ok');
  assert.throws(
    () => decodeInboundMediaBase64('', 10),
    /inbound media base64 decoded to empty buffer/,
  );
  assert.throws(
    () => decodeInboundMediaBase64('====', 10),
    /inbound media base64 decoded to empty buffer/,
  );
  assert.throws(
    () => decodeInboundMediaBase64(Buffer.from('too-large').toString('base64'), 3),
    /inbound media too large:/,
  );
});

test('dispatchBncrInbound saves normal inline base64 media after preflight size check', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'image',
    msg: 'image inbound',
    base64: Buffer.from('ok').toString('base64'),
    mimeType: 'image/png',
    fileName: 'demo.png',
    msgId: 'inbound-media-small',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.savedMediaBuffers.length, 1);
  assert.equal(calls.savedMediaBuffers[0].buffer.toString(), 'ok');
  assert.equal(calls.savedMediaBuffers[0].mimeType, 'image/png');
  assert.equal(calls.builtContexts[0].Body, 'ENV:image inbound');
  assert.equal(calls.builtContexts[0].BodyForAgent, 'ENV:image inbound');
  assert.equal(calls.builtContexts[0].RawBody, 'image inbound');
  assert.equal(calls.builtContexts[0].CommandBody, 'image inbound');
  assert.equal(calls.builtContexts[0].BodyForCommands, 'image inbound');
  assert.equal(
    calls.builtContexts[0].MediaPath,
    '/home/test/.openclaw/media/inbound/bncr-inbound-media-1.bin',
  );
  assert.equal(calls.builtContexts[0].MediaType, 'image/png');
  assert.deepEqual(
    calls.builtContexts[0].BncrStructuredContextFacts,
    calls.builtContexts[0].StructuredContextFacts,
  );
  assert.deepEqual(calls.builtContexts[0].StructuredContextFacts.media, [
    {
      path: '/home/test/.openclaw/media/inbound/bncr-inbound-media-1.bin',
      contentType: 'image/png',
      kind: 'image',
      messageId: 'inbound-media-small',
    },
  ]);
  assert.deepEqual(calls.builtContextArgs[0].supplemental.untrustedContext, [
    {
      label: 'Bncr inbound context',
      source: 'bncr',
      type: 'bncr.inbound_context',
      payload: {
        platform: 'bncr/tgBot',
        conversation_context: [
          {
            messageId: 'inbound-media-small',
            timestamp:
              calls.builtContexts[0].StructuredContextFacts.conversationContext[0].timestamp,
            role: 'user',
            sender: 'Bncr:tgBot:-1001:0',
            senderId: '10001',
            content: 'image inbound',
          },
          {
            messageId: 'inbound-media-small',
            timestamp:
              calls.builtContexts[0].StructuredContextFacts.conversationContext[0].timestamp,
            role: 'user',
            sender: 'Bncr:tgBot:-1001:0',
            senderId: '10001',
            media_type: 'image',
            path: 'media://inbound/bncr-inbound-media-1.bin',
            contentType: 'image/png',
          },
        ],
        participants: {
          10001: {
            name: 'Bncr:tgBot:-1001:0',
            isBot: false,
            role: 'user',
            displayName: 'Bncr:tgBot:-1001:0',
          },
        },
        is_group_chat: true,
        account_id: 'Primary',
        reply: {
          to: 'Bncr:tgBot:-1001:0',
          originatingTo: 'Bncr:tgBot:-1001:0',
          rawTo: 'Bncr:tgBot:-1001:10001',
        },
        media: [
          {
            path: 'media://inbound/bncr-inbound-media-1.bin',
            contentType: 'image/png',
            kind: 'image',
            messageId: 'inbound-media-small',
          },
        ],
      },
    },
  ]);
});

test('dispatchBncrInbound prefers runtime remote media reader for http media path', async () => {
  const remoteCalls = [];
  const { api, calls } = createInboundApiStub({
    async readRemoteMediaBuffer(options) {
      remoteCalls.push(options);
      return { buffer: Buffer.from('runtime-jpg'), contentType: 'image/jpeg' };
    },
  });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'image',
    msg: '收到媒体文件',
    path: 'https://example.test/photos/file_6.jpg',
    base64: '',
    mimeType: 'image',
    fileName: '1781167496030',
    msgId: 'inbound-media-runtime-url',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.deepEqual(remoteCalls, [
    { url: 'https://example.test/photos/file_6.jpg', maxBytes: 200 * 1024 * 1024 },
  ]);
  assert.equal(calls.savedMediaBuffers.length, 1);
  assert.equal(calls.savedMediaBuffers[0].buffer.toString(), 'runtime-jpg');
  assert.equal(calls.savedMediaBuffers[0].mimeType, 'image/jpeg');
  assert.equal(calls.savedMediaBuffers[0].direction, 'inbound');
  assert.equal(calls.savedMediaBuffers[0].maxBytes, 200 * 1024 * 1024);
  assert.equal(calls.builtContexts[0].MediaType, 'image/jpeg');
});

test('loadInboundRemoteMedia falls back to internal downloader when runtime reader fails', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/fallback.jpg');
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': '8',
    });
    res.end('fallback');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const mediaUrl = `http://127.0.0.1:${address.port}/fallback.jpg`;
    const loaded = await loadInboundRemoteMedia(
      {
        runtime: {
          channel: {
            media: {
              async readRemoteMediaBuffer() {
                throw new Error('runtime remote reader unavailable in test');
              },
            },
          },
        },
      },
      mediaUrl,
      1024,
    );

    assert.equal(loaded.buffer.toString(), 'fallback');
    assert.equal(loaded.contentType, 'image/jpeg');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('dispatchBncrInbound downloads http media path before building inbound context', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/photos/file_6.jpg');
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': '7',
    });
    res.end('jpgdata');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { api, calls } = createInboundApiStub();
    const address = server.address();
    const mediaUrl = `http://127.0.0.1:${address.port}/photos/file_6.jpg`;
    const parsed = parseBncrInboundParams({
      accountId: 'Primary',
      clientId: 'client-1',
      platform: 'tgBot',
      groupId: '-1001',
      userId: '10001',
      type: 'image',
      msg: '收到媒体文件',
      path: mediaUrl,
      base64: '',
      mimeType: 'image',
      fileName: '1781167496030',
      msgId: 'inbound-media-url',
    });

    await dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed,
      canonicalAgentId: 'orion',
      rememberSessionRoute() {},
      enqueueFromReply: async () => {},
      setInboundActivity() {},
      scheduleSave() {},
    });

    assert.equal(calls.savedMediaBuffers.length, 1);
    assert.equal(calls.savedMediaBuffers[0].buffer.toString(), 'jpgdata');
    assert.equal(calls.savedMediaBuffers[0].mimeType, 'image/jpeg');
    assert.equal(calls.savedMediaBuffers[0].direction, 'inbound');
    assert.equal(calls.savedMediaBuffers[0].maxBytes, 200 * 1024 * 1024);
    assert.equal(calls.savedMediaBuffers[0].fileName, '1781167496030');
    assert.equal(
      calls.builtContexts[0].MediaPath,
      '/home/test/.openclaw/media/inbound/bncr-inbound-media-1.bin',
    );
    assert.equal(calls.builtContexts[0].MediaType, 'image/jpeg');
    assert.deepEqual(calls.builtContexts[0].StructuredContextFacts.media, [
      {
        path: '/home/test/.openclaw/media/inbound/bncr-inbound-media-1.bin',
        contentType: 'image/jpeg',
        kind: 'image',
        messageId: 'inbound-media-url',
      },
    ]);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('dispatchBncrInbound accepts mediaList and exposes multiple media entries in the current turn', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'image',
    msg: '收到媒体文件',
    mediaList: [
      {
        base64: Buffer.from('img-1').toString('base64'),
        mimeType: 'image/png',
        fileName: 'first.png',
        type: 'image',
      },
      {
        base64: Buffer.from('img-2').toString('base64'),
        mimeType: 'image/jpeg',
        fileName: 'second.jpg',
        type: 'image',
      },
    ],
    msgId: 'inbound-media-list-1',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.savedMediaBuffers.length, 2);
  assert.equal(calls.savedMediaBuffers[0].buffer.toString(), 'img-1');
  assert.equal(calls.savedMediaBuffers[1].buffer.toString(), 'img-2');
  assert.equal(calls.builtContexts[0].Body, 'ENV:<media:image> (2 images)');
  assert.equal(calls.builtContexts[0].BodyForAgent, 'ENV:<media:image> (2 images)');
  assert.equal(
    calls.builtContexts[0].MediaPath,
    '/home/test/.openclaw/media/inbound/bncr-inbound-media-1.bin',
  );
  assert.equal(calls.builtContexts[0].MediaType, 'image/png');
  assert.deepEqual(calls.builtContextArgs[0].media, [
    {
      path: '/home/test/.openclaw/media/inbound/bncr-inbound-media-1.bin',
      contentType: 'image/png',
      kind: 'image',
      messageId: 'inbound-media-list-1',
    },
    {
      path: '/home/test/.openclaw/media/inbound/bncr-inbound-media-2.bin',
      contentType: 'image/jpeg',
      kind: 'image',
      messageId: 'inbound-media-list-1',
    },
  ]);
  assert.deepEqual(calls.builtContexts[0].StructuredContextFacts.media, [
    {
      path: '/home/test/.openclaw/media/inbound/bncr-inbound-media-1.bin',
      contentType: 'image/png',
      kind: 'image',
      messageId: 'inbound-media-list-1',
    },
    {
      path: '/home/test/.openclaw/media/inbound/bncr-inbound-media-2.bin',
      contentType: 'image/jpeg',
      kind: 'image',
      messageId: 'inbound-media-list-1',
    },
  ]);
});

test('downloadInboundMediaUrl rejects streamed bodies once they exceed maxBytes without content-length', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/stream.bin');
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('1234');
    res.end('5');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const mediaUrl = `http://127.0.0.1:${address.port}/stream.bin`;
    await assert.rejects(
      () => downloadInboundMediaUrl(mediaUrl, 4, 1_000),
      /inbound media url too large: 5 bytes exceeds 4 bytes/,
    );
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('downloadInboundMediaUrl times out slow responses', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/slow.bin');
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('s');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const mediaUrl = `http://127.0.0.1:${address.port}/slow.bin`;
    await assert.rejects(
      () => downloadInboundMediaUrl(mediaUrl, 1024, 50),
      /inbound media url download timed out after 50ms/,
    );
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
