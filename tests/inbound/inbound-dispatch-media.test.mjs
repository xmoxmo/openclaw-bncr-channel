import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';

import {
  assertInboundMediaBase64Size,
  decodeInboundMediaBase64,
  dispatchBncrInbound,
  estimateBase64DecodedBytes,
} from '../../src/messaging/inbound/dispatch.ts';
import { downloadInboundMediaUrl } from '../../src/messaging/inbound/media-url-download.ts';
import { assertFetchableMediaUrl } from '../../src/messaging/inbound/media-url-policy.ts';
import { parseBncrInboundParams } from '../../src/messaging/inbound/parse.ts';
import { loadInboundRemoteMedia } from '../../src/messaging/inbound/remote-media.ts';
import { fallbackBncrMediaMaxBytes } from '../../src/openclaw/media-limit-runtime.ts';
import { installBncrTestMediaStorage } from '../helpers/bncr-media-storage.mjs';
import { createInboundApiStub } from '../helpers/inbound-runtime.mjs';

let mediaStorage;
test.beforeEach(async () => {
  mediaStorage = await installBncrTestMediaStorage();
});
test.afterEach(async () => {
  await mediaStorage?.restore();
  mediaStorage = undefined;
});

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
  assert.equal(decodeInboundMediaBase64(' T 2s= ', fallbackBncrMediaMaxBytes()).toString(), 'Ok');
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

  assert.equal(calls.builtContexts[0].Body, 'ENV:image inbound');
  assert.equal(calls.builtContexts[0].BodyForAgent, 'ENV:image inbound');
  assert.equal(calls.builtContexts[0].RawBody, 'image inbound');
  assert.equal(calls.builtContexts[0].CommandBody, 'image inbound');
  assert.equal(calls.builtContexts[0].BodyForCommands, 'image inbound');
  assert.match(calls.builtContexts[0].MediaPath, /\/history\/orion\/.+\.png$/);
  assert.equal((await readFile(calls.builtContexts[0].MediaPath)).toString(), 'ok');
  assert.equal(calls.builtContexts[0].MediaType, 'image/png');
  assert.deepEqual(
    calls.builtContexts[0].BncrStructuredContextFacts,
    calls.builtContexts[0].StructuredContextFacts,
  );
  const currentMedia = calls.builtContexts[0].StructuredContextFacts.media[0];
  assert.equal(currentMedia.contentType, 'image/png');
  assert.equal(currentMedia.kind, 'image');
  assert.equal(currentMedia.messageId, 'inbound-media-small');
  const promptPayload = calls.builtContextArgs[0].supplemental.untrustedContext[0].payload;
  assert.equal(promptPayload.platform, 'bncr/tgBot');
  assert.equal(promptPayload.conversation_context.length, 2);
  assert.equal(promptPayload.conversation_context[0].content, 'image inbound');
  assert.equal(promptPayload.conversation_context[1].path, undefined);
  assert.match(promptPayload.conversation_context[1].source, /\/history\/orion\//);
  assert.equal(promptPayload.media[0].source, undefined);
  assert.match(promptPayload.media[0].mediaRef, /^bncr-media:/);
  assert.equal(promptPayload.media[0].originAgentId, 'orion');
});

test('dispatchBncrInbound prefers runtime remote media reader for http media path', async () => {
  const remoteCalls = [];
  const { api, calls } = createInboundApiStub({
    async readRemoteMediaBuffer(options) {
      remoteCalls.push(options);
      return {
        buffer: Buffer.from('runtime-jpg'),
        contentType: 'image/jpeg',
        fileName: 'server-name.jpg',
      };
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
    {
      url: 'https://example.test/photos/file_6.jpg',
      maxBytes: fallbackBncrMediaMaxBytes(),
      ssrfPolicy: { allowPrivateNetwork: true },
    },
  ]);
  assert.equal(calls.builtContexts[0].MediaType, 'image/jpeg');
  assert.equal((await readFile(calls.builtContexts[0].MediaPath)).toString(), 'runtime-jpg');
  const promptMedia = calls.builtContextArgs[0].supplemental.untrustedContext[0].payload.media[0];
  assert.equal(promptMedia.path, 'https://example.test/photos/file_6.jpg');
  assert.equal(promptMedia.fileName, 'server-name.jpg');
  assert.equal(calls.builtContexts[0].StructuredContextFacts.media[0].fileName, 'server-name.jpg');
});

test('silent history flush never downloads the historical URL', async () => {
  const remoteCalls = [];
  const { api, calls } = createInboundApiStub({
    async readRemoteMediaBuffer(options) {
      remoteCalls.push(options);
      return { buffer: Buffer.from('unexpected'), contentType: 'image/png' };
    },
  });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'image',
    msg: 'old image',
    path: 'https://example.test/old.png',
    mimeType: 'image/png',
    msgId: 'flush-history-url',
  });

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    shouldDispatch: false,
    shouldAccumulate: false,
    forceSilentHistoryFlush: true,
    conversationHistories: new Map([
      [
        'Primary:tgBot:-1001',
        [
          {
            sender: 'alice',
            senderId: '10002',
            role: 'user',
            body: 'history text',
            timestamp: 1,
            messageId: 'history-text-1',
          },
        ],
      ],
    ]),
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(remoteCalls.length, 0);
  assert.deepEqual(calls.builtContextArgs[0].media, []);
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
      { urlGuard: async () => {} },
    );

    assert.equal(loaded.buffer.toString(), 'fallback');
    assert.equal(loaded.contentType, 'image/jpeg');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('loadInboundRemoteMedia rejects oversized buffers returned by the runtime reader', async () => {
  await assert.rejects(
    () =>
      loadInboundRemoteMedia(
        {
          runtime: {
            channel: {
              media: {
                async readRemoteMediaBuffer() {
                  return { buffer: Buffer.alloc(17), contentType: 'image/png' };
                },
              },
            },
          },
        },
        'https://example.test/oversized.png',
        16,
      ),
    /too large: 17 > 16/,
  );
});

test('loadInboundRemoteMedia falls back to a raw fetch of a trusted loopback URL when the host reader rejects it', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '10' });
    res.end('private-ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const mediaUrl = `http://127.0.0.1:${address.port}/private.jpg`;
    const loaded = await loadInboundRemoteMedia(
      {
        runtime: {
          channel: {
            media: {
              async readRemoteMediaBuffer() {
                throw new Error('host rejected private destination');
              },
            },
          },
        },
      },
      mediaUrl,
      1024,
    );
    assert.equal(loaded.buffer.toString(), 'private-ok');
    assert.equal(loaded.contentType, 'image/jpeg');
    assert.equal(requests, 1, 'the fallback is allowed to fetch the trusted private destination');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('assertFetchableMediaUrl treats private/loopback destinations like public ones and rejects malformed urls', async () => {
  for (const url of [
    'http://127.0.0.1/x',
    'http://10.1.2.3/x',
    'http://169.254.169.254/latest/meta-data',
    'http://192.168.1.1/x',
    'http://[::1]/x',
    'http://localhost/x',
    'http://media.internal/x',
    'https://93.184.216.34/photo.jpg',
  ]) {
    await assert.doesNotReject(() => assertFetchableMediaUrl(url), url);
  }
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/x',
    'http://user:pass@93.184.216.34/x',
    'not a url',
  ]) {
    await assert.rejects(() => assertFetchableMediaUrl(url), /media url/, url);
  }
});

test('downloadInboundMediaUrl validates every redirect hop', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/private' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('private');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const mediaUrl = `http://127.0.0.1:${address.port}/start`;
    await assert.rejects(
      () =>
        downloadInboundMediaUrl(mediaUrl, 1024, 1_000, async (url) => {
          if (url.endsWith('/private')) throw new Error('redirect destination blocked');
        }),
      /redirect destination blocked/,
    );
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
    const { api, calls } = createInboundApiStub({
      async readRemoteMediaBuffer({ url }) {
        const response = await fetch(url);
        return {
          buffer: Buffer.from(await response.arrayBuffer()),
          contentType: response.headers.get('content-type') || undefined,
        };
      },
    });
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

    assert.match(calls.builtContexts[0].MediaPath, /\/history\/orion\/.+$/);
    assert.equal((await readFile(calls.builtContexts[0].MediaPath)).toString(), 'jpgdata');
    assert.equal(calls.builtContexts[0].MediaType, 'image/jpeg');
    assert.equal(calls.builtContexts[0].StructuredContextFacts.media.length, 1);
    assert.equal(calls.builtContexts[0].StructuredContextFacts.media[0].contentType, 'image/jpeg');
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

  assert.equal(calls.builtContexts[0].Body, 'ENV:<media:image> (2 images)');
  assert.equal(calls.builtContexts[0].BodyForAgent, 'ENV:<media:image> (2 images)');
  assert.match(calls.builtContexts[0].MediaPath, /\/history\/orion\/.+\.png$/);
  assert.equal(calls.builtContexts[0].MediaType, 'image/png');
  assert.equal(calls.builtContextArgs[0].media.length, 2);
  assert.equal((await readFile(calls.builtContextArgs[0].media[0].path)).toString(), 'img-1');
  assert.equal((await readFile(calls.builtContextArgs[0].media[1].path)).toString(), 'img-2');
  assert.equal(calls.builtContextArgs[0].media[0].contentType, 'image/png');
  assert.equal(calls.builtContextArgs[0].media[1].contentType, 'image/jpeg');
  assert.equal(calls.builtContexts[0].StructuredContextFacts.media.length, 2);
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
