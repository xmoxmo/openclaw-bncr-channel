import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBncrBridge } from '../../src/channel.ts';
import { BncrMediaSourceError } from '../../src/messaging/inbound/media-assets.ts';
import { installBncrTestMediaStorage } from '../helpers/bncr-media-storage.mjs';

function createApi(readRemoteMediaBuffer, mediaMaxMb = 2048, workspaceRoot = os.tmpdir()) {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {
      agent: {
        resolveAgentWorkspaceDir(_cfg, agentId) {
          return path.join(workspaceRoot, 'workspaces', agentId);
        },
      },
      config: {
        current() {
          return { channels: { bncr: { mediaMaxMb, accounts: { Primary: {} } } } };
        },
      },
      channel: {
        media: { readRemoteMediaBuffer },
      },
    },
  };
}

function downloadArgs(overrides = {}) {
  return {
    accountId: 'Primary',
    agentId: 'orion',
    sessionKey: 'agent:orion:bncr:group:-1001',
    source: 'https://example.test/history.png',
    sourceKind: 'url',
    mediaRef: 'bncr-media:history-download-1',
    contentType: 'image/png',
    ...overrides,
  };
}

function materializedFileName(mediaRef, contents, extension) {
  const digest = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  return `${mediaRef.replace(/[^a-zA-Z0-9._-]+/g, '_')}_${digest}${extension}`;
}

async function assertDirectoryEmpty(directory) {
  try {
    assert.deepEqual(await readdir(directory), []);
  } catch (error) {
    assert.equal(error.code, 'ENOENT');
  }
}

test('bncr_download_media downloads an explicit URL into the calling agent workspace', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  let downloads = 0;
  const bridge = createBncrBridge(
    createApi(
      async () => {
        downloads += 1;
        return { buffer: Buffer.from('history-image'), contentType: 'image/png' };
      },
      2048,
      mediaStorage.root,
    ),
  );

  try {
    const downloaded = await bridge.downloadHistoryMedia(
      downloadArgs({ source: 'http://127.0.0.1:8123/history.png' }),
    );

    assert.equal(downloads, 1);
    assert.equal((await readFile(downloaded.hostPath)).toString(), 'history-image');
    assert.equal(downloaded.mediaRef, 'bncr-media:history-download-1');
    assert.match(downloaded.mediaUri, /^media:\/\/inbound\//);
    assert.match(downloaded.hostPath, /workspaces\/orion\/media\/inbound\//);
    assert.equal(downloaded.contentType, 'image/png');
    assert.equal(downloaded.sizeBytes, 13);
  } finally {
    await mediaStorage.restore();
  }
});

test('bncr_download_media copies a managed local source and preserves metadata', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  const sourceDir = path.join(mediaStorage.root, 'history', 'public');
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, 'history.pdf');
  await writeFile(sourcePath, 'pdf-bytes');
  const bridge = createBncrBridge(
    createApi(
      async () => {
        throw new Error('URL reader must not run for local media');
      },
      2048,
      mediaStorage.root,
    ),
  );

  try {
    const downloaded = await bridge.downloadHistoryMedia(
      downloadArgs({
        agentId: 'orion-2',
        source: sourcePath,
        sourceKind: 'local',
        mediaRef: 'bncr-media:local-download-1',
        contentType: 'application/pdf',
        fileName: 'report.pdf',
      }),
    );

    assert.equal((await readFile(downloaded.hostPath)).toString(), 'pdf-bytes');
    assert.match(downloaded.hostPath, /workspaces\/orion-2\/media\/inbound\//);
    assert.equal(downloaded.contentType, 'application/pdf');
    assert.equal(downloaded.fileName, 'report.pdf');
  } finally {
    await mediaStorage.restore();
  }
});

test('bncr_download_media atomically replaces a pre-existing workspace symlink', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  const sourceDir = path.join(mediaStorage.root, 'history', 'public');
  const workspaceDir = path.join(mediaStorage.root, 'workspaces', 'orion', 'media', 'inbound');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, 'history.png');
  const outsidePath = path.join(mediaStorage.root, 'outside.txt');
  const targetPath = path.join(
    workspaceDir,
    materializedFileName('bncr-media:history-download-1', 'safe-image', '.png'),
  );
  await writeFile(sourcePath, 'safe-image');
  await writeFile(outsidePath, 'must-not-change');
  await symlink(outsidePath, targetPath);
  const bridge = createBncrBridge(
    createApi(async () => ({ buffer: Buffer.from('unused') }), 2048, mediaStorage.root),
  );

  try {
    const downloaded = await bridge.downloadHistoryMedia(
      downloadArgs({ source: sourcePath, sourceKind: 'local' }),
    );

    assert.equal((await readFile(outsidePath)).toString(), 'must-not-change');
    assert.equal((await readFile(targetPath)).toString(), 'safe-image');
    assert.equal((await lstat(targetPath)).isSymbolicLink(), false);
    assert.equal(downloaded.hostPath, targetPath);
  } finally {
    await mediaStorage.restore();
  }
});

test('bncr_download_media rejects a symlinked workspace media directory', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  const sourceDir = path.join(mediaStorage.root, 'history', 'public');
  const workspaceDir = path.join(mediaStorage.root, 'workspaces', 'orion');
  const outsideDir = path.join(mediaStorage.root, 'outside-workspace');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(path.join(workspaceDir, 'media'), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  const sourcePath = path.join(sourceDir, 'history.png');
  await writeFile(sourcePath, 'safe-image');
  await symlink(outsideDir, path.join(workspaceDir, 'media', 'inbound'));
  const bridge = createBncrBridge(
    createApi(async () => ({ buffer: Buffer.from('unused') }), 2048, mediaStorage.root),
  );

  try {
    await assert.rejects(
      () => bridge.downloadHistoryMedia(downloadArgs({ source: sourcePath, sourceKind: 'local' })),
      /media output directory is outside the agent workspace/,
    );
    await assert.rejects(
      access(
        path.join(
          outsideDir,
          materializedFileName('bncr-media:history-download-1', 'safe-image', '.png'),
        ),
      ),
    );
  } finally {
    await mediaStorage.restore();
  }
});

test('bncr_download_media rejects a symlinked media parent without creating outside directories', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  const sourceDir = path.join(mediaStorage.root, 'history', 'public');
  const workspaceDir = path.join(mediaStorage.root, 'workspaces', 'orion');
  const outsideDir = path.join(mediaStorage.root, 'outside-media-parent');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  const sourcePath = path.join(sourceDir, 'history.png');
  await writeFile(sourcePath, 'safe-image');
  await symlink(outsideDir, path.join(workspaceDir, 'media'));
  const bridge = createBncrBridge(
    createApi(async () => ({ buffer: Buffer.from('unused') }), 2048, mediaStorage.root),
  );

  try {
    await assert.rejects(
      () => bridge.downloadHistoryMedia(downloadArgs({ source: sourcePath, sourceKind: 'local' })),
      /media output directory is outside the agent workspace/,
    );
    assert.deepEqual(await readdir(outsideDir), []);
  } finally {
    await mediaStorage.restore();
  }
});

test('bncr_download_media rejects local files outside the managed media directory', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'bncr-media-outside-'));
  const outsidePath = path.join(outsideDir, 'secret.txt');
  await writeFile(outsidePath, 'secret');
  const linkedPath = path.join(mediaStorage.root, 'linked-secret.txt');
  await symlink(outsidePath, linkedPath);
  const bridge = createBncrBridge(
    createApi(async () => ({ buffer: Buffer.from('unused') }), 2048, mediaStorage.root),
  );

  try {
    await assert.rejects(
      () => bridge.downloadHistoryMedia(downloadArgs({ source: outsidePath, sourceKind: 'local' })),
      (error) => error instanceof BncrMediaSourceError && error.code === 'SOURCE_NOT_FOUND',
    );
    await assert.rejects(
      () => bridge.downloadHistoryMedia(downloadArgs({ source: linkedPath, sourceKind: 'local' })),
      (error) => error instanceof BncrMediaSourceError && error.code === 'SOURCE_NOT_FOUND',
    );
  } finally {
    await mediaStorage.restore();
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('bncr_download_media reports missing, oversized, invalid, and failed sources', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  const bridge = createBncrBridge(
    createApi(
      async () => {
        throw new Error('offline');
      },
      0.000001,
      mediaStorage.root,
    ),
  );

  try {
    await assert.rejects(
      () =>
        bridge.downloadHistoryMedia(
          downloadArgs({
            source: path.join(mediaStorage.root, 'missing.png'),
            sourceKind: 'local',
          }),
        ),
      (error) => error instanceof BncrMediaSourceError && error.code === 'SOURCE_NOT_FOUND',
    );

    const oversizedPath = path.join(mediaStorage.root, 'oversized.bin');
    await writeFile(oversizedPath, 'too-large');
    await assert.rejects(
      () =>
        bridge.downloadHistoryMedia(downloadArgs({ source: oversizedPath, sourceKind: 'local' })),
      (error) => error instanceof BncrMediaSourceError && error.code === 'SOURCE_TOO_LARGE',
    );

    await assert.rejects(
      () =>
        bridge.downloadHistoryMedia(
          downloadArgs({ source: 'file:///tmp/a.png', sourceKind: 'url' }),
        ),
      (error) => error instanceof BncrMediaSourceError && error.code === 'SOURCE_KIND_INVALID',
    );

    await assert.rejects(
      () => bridge.downloadHistoryMedia(downloadArgs({ sourceKind: 'remote' })),
      (error) => error instanceof BncrMediaSourceError && error.code === 'SOURCE_KIND_INVALID',
    );

    await assert.rejects(
      () => bridge.downloadHistoryMedia(downloadArgs()),
      (error) => error instanceof BncrMediaSourceError && error.code === 'SOURCE_FETCH_FAILED',
    );

    await assert.rejects(
      () => bridge.downloadHistoryMedia(downloadArgs({ source: '' })),
      (error) => error instanceof BncrMediaSourceError && error.code === 'SOURCE_REQUIRED',
    );
  } finally {
    await mediaStorage.restore();
  }
});

test('bncr_download_media honors stale invocation checks before writing URL output', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  const bridge = createBncrBridge(
    createApi(
      async () => ({ buffer: Buffer.from('history-image'), contentType: 'image/png' }),
      2048,
      mediaStorage.root,
    ),
  );
  let checks = 0;

  try {
    await assert.rejects(
      () =>
        bridge.downloadHistoryMedia(
          downloadArgs({
            assertCurrent() {
              checks += 1;
              if (checks === 2) throw new Error('stale invocation');
            },
          }),
        ),
      /stale invocation/,
    );
    assert.equal(checks, 2);
    await assertDirectoryEmpty(
      path.join(mediaStorage.root, 'workspaces', 'orion', 'media', 'inbound'),
    );
  } finally {
    await mediaStorage.restore();
  }
});

test('bncr_download_media honors stale invocation checks before writing local output', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  const sourceDir = path.join(mediaStorage.root, 'history', 'public');
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, 'history.png');
  await writeFile(sourcePath, 'history-image');
  const bridge = createBncrBridge(
    createApi(async () => ({ buffer: Buffer.from('unused') }), 2048, mediaStorage.root),
  );
  let checks = 0;

  try {
    await assert.rejects(
      () =>
        bridge.downloadHistoryMedia(
          downloadArgs({
            source: sourcePath,
            sourceKind: 'local',
            assertCurrent() {
              checks += 1;
              if (checks === 2) throw new Error('stale local invocation');
            },
          }),
        ),
      /stale local invocation/,
    );
    assert.equal(checks, 2);
    await assertDirectoryEmpty(
      path.join(mediaStorage.root, 'workspaces', 'orion', 'media', 'inbound'),
    );
  } finally {
    await mediaStorage.restore();
  }
});

test('bncr_download_media removes the temporary file when invocation becomes stale before rename', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  const bridge = createBncrBridge(
    createApi(
      async () => ({ buffer: Buffer.from('history-image'), contentType: 'image/png' }),
      2048,
      mediaStorage.root,
    ),
  );
  let checks = 0;

  try {
    await assert.rejects(
      () =>
        bridge.downloadHistoryMedia(
          downloadArgs({
            assertCurrent() {
              checks += 1;
              if (checks === 6) throw new Error('stale before rename');
            },
          }),
        ),
      /stale before rename/,
    );
    assert.equal(checks, 6);
    await assertDirectoryEmpty(
      path.join(mediaStorage.root, 'workspaces', 'orion', 'media', 'inbound'),
    );
  } finally {
    await mediaStorage.restore();
  }
});

test('bncr_download_media keeps concurrent writes with the same mediaRef isolated', async () => {
  const mediaStorage = await installBncrTestMediaStorage();
  const bridge = createBncrBridge(
    createApi(
      async ({ url }) => ({
        buffer: Buffer.from(url.endsWith('/first.png') ? 'first-image' : 'second-image'),
        contentType: 'image/png',
      }),
      2048,
      mediaStorage.root,
    ),
  );

  try {
    const [first, second] = await Promise.all([
      bridge.downloadHistoryMedia(
        downloadArgs({ source: 'http://127.0.0.1/first.png', mediaRef: 'bncr-media:shared' }),
      ),
      bridge.downloadHistoryMedia(
        downloadArgs({ source: 'http://127.0.0.1/second.png', mediaRef: 'bncr-media:shared' }),
      ),
    ]);

    assert.notEqual(first.hostPath, second.hostPath);
    assert.equal((await readFile(first.hostPath)).toString(), 'first-image');
    assert.equal((await readFile(second.hostPath)).toString(), 'second-image');
  } finally {
    await mediaStorage.restore();
  }
});
