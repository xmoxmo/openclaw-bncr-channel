import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isOpenClawRemoteHttpMediaUrl,
  loadOpenClawWebMedia,
  saveOpenClawChannelMediaBuffer,
} from '../../src/openclaw/media-runtime.ts';

test('isOpenClawRemoteHttpMediaUrl only accepts http and https urls', () => {
  assert.equal(isOpenClawRemoteHttpMediaUrl('http://a'), true);
  assert.equal(isOpenClawRemoteHttpMediaUrl('https://a'), true);
  assert.equal(isOpenClawRemoteHttpMediaUrl('/tmp/a.png'), false);
  assert.equal(isOpenClawRemoteHttpMediaUrl('file:///tmp/a.png'), false);
});

test('loadOpenClawWebMedia prefers channel remote reader for http urls and falls back otherwise', async () => {
  const calls = [];
  const api = {
    runtime: {
      media: {
        async loadWebMedia(mediaUrl, options) {
          calls.push(['loadWebMedia', mediaUrl, options]);
          return { buffer: Buffer.from('local'), contentType: 'application/octet-stream' };
        },
      },
      channel: {
        media: {
          async readRemoteMediaBuffer(options) {
            calls.push(['readRemoteMediaBuffer', options]);
            return { buffer: Buffer.from('remote'), contentType: 'image/png' };
          },
        },
      },
    },
  };

  const remote = await loadOpenClawWebMedia(api, 'https://example.com/a.png', { maxBytes: 64 });
  const local = await loadOpenClawWebMedia(api, '/tmp/a.png', { localRoots: ['/tmp'] });

  assert.equal(remote.buffer.toString(), 'remote');
  assert.equal(local.buffer.toString(), 'local');
  assert.deepEqual(calls, [
    ['readRemoteMediaBuffer', { url: 'https://example.com/a.png', maxBytes: 64 }],
    ['loadWebMedia', '/tmp/a.png', { localRoots: ['/tmp'] }],
  ]);
});

test('media runtime throws when host methods are unavailable', async () => {
  await assert.rejects(
    () => loadOpenClawWebMedia({}, '/tmp/a.png'),
    /loadWebMedia API is unavailable/,
  );
  await assert.rejects(
    () => saveOpenClawChannelMediaBuffer({}, Buffer.from('x'), 'text/plain', 'inbound', 1),
    /saveMediaBuffer API is unavailable/,
  );
});
