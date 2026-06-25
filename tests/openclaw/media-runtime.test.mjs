import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('loadOpenClawWebMedia resolves relative paths against localRoots', async () => {
  const dir = path.join(tmpdir(), `bncr-media-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'test.png');
  writeFileSync(filePath, 'fake-png-content');

  const calls = [];
  const api = {
    runtime: {
      media: {
        async loadWebMedia(mediaUrl, options) {
          calls.push(['loadWebMedia', mediaUrl, options]);
          return { buffer: Buffer.from('resolved'), contentType: 'image/png' };
        },
      },
    },
  };

  // Relative path that exists inside localRoots
  const result = await loadOpenClawWebMedia(api, 'test.png', { localRoots: [dir] });
  assert.equal(result.buffer.toString(), 'resolved');
  assert.equal(calls.length, 1);
  // Should have resolved to absolute path
  assert.equal(calls[0][1], filePath);

  rmSync(dir, { recursive: true, force: true });
});

test('loadOpenClawWebMedia passes absolute paths through unchanged', async () => {
  const calls = [];
  const api = {
    runtime: {
      media: {
        async loadWebMedia(mediaUrl, options) {
          calls.push(['loadWebMedia', mediaUrl, options]);
          return { buffer: Buffer.from('data'), contentType: 'text/plain' };
        },
      },
    },
  };

  await loadOpenClawWebMedia(api, '/absolute/path/file.txt', { localRoots: ['/tmp'] });
  assert.equal(calls[0][1], '/absolute/path/file.txt');
});

test('loadOpenClawWebMedia passes relative path through when no root matches', async () => {
  const calls = [];
  const api = {
    runtime: {
      media: {
        async loadWebMedia(mediaUrl, options) {
          calls.push(['loadWebMedia', mediaUrl, options]);
          return { buffer: Buffer.from('data'), contentType: 'text/plain' };
        },
      },
    },
  };

  // Relative path that doesn't exist under any root
  await loadOpenClawWebMedia(api, 'nonexistent/foo.png', { localRoots: ['/tmp'] });
  assert.equal(calls[0][1], 'nonexistent/foo.png');
});

test('loadOpenClawWebMedia preserves HTTP urls through resolution', async () => {
  const calls = [];
  const api = {
    runtime: {
      media: {
        async loadWebMedia(mediaUrl, options) {
          calls.push(['loadWebMedia', mediaUrl, options]);
          return { buffer: Buffer.from('data'), contentType: 'text/plain' };
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

  await loadOpenClawWebMedia(api, 'http://example.com/file.png', { localRoots: ['/tmp'] });
  assert.equal(calls[0][0], 'readRemoteMediaBuffer');
});

test('loadOpenClawWebMedia preserves ~ paths through resolution', async () => {
  const calls = [];
  const api = {
    runtime: {
      media: {
        async loadWebMedia(mediaUrl, options) {
          calls.push(['loadWebMedia', mediaUrl, options]);
          return { buffer: Buffer.from('data'), contentType: 'text/plain' };
        },
      },
    },
  };

  await loadOpenClawWebMedia(api, '~/some/file.png', { localRoots: ['/tmp'] });
  // ~ paths should pass through unchanged
  assert.equal(calls[0][1], '~/some/file.png');
});
