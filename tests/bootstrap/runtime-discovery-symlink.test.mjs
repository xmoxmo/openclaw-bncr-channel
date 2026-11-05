import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureBncrOpenClawSdkResolution } from '../../src/bootstrap/runtime-discovery.ts';

test('runtime discovery refuses to replace an existing OpenClaw symlink', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bncr-runtime-discovery-'));
  try {
    const pluginDir = path.join(root, 'plugin');
    const wrongTarget = path.join(root, 'wrong-openclaw');
    await mkdir(path.join(pluginDir, 'node_modules'), { recursive: true });
    await mkdir(wrongTarget, { recursive: true });
    await writeFile(
      path.join(wrongTarget, 'package.json'),
      JSON.stringify({ name: 'openclaw', version: '0.0.0-test' }),
    );
    const linkPath = path.join(pluginDir, 'node_modules', 'openclaw');
    await symlink(wrongTarget, linkPath, 'dir');

    const pluginRequire = {
      resolve() {
        throw new Error('not resolvable in this test');
      },
    };

    assert.throws(
      () => ensureBncrOpenClawSdkResolution(pluginDir, pluginRequire),
      /refusing to replace existing OpenClaw symlink/,
    );
    assert.equal(await realpath(linkPath), await realpath(wrongTarget));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime discovery names a broken OpenClaw symlink instead of trying to replace it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bncr-runtime-broken-'));
  try {
    const pluginDir = path.join(root, 'plugin');
    await mkdir(path.join(pluginDir, 'node_modules'), { recursive: true });
    const linkPath = path.join(pluginDir, 'node_modules', 'openclaw');
    await symlink(path.join(root, 'missing-openclaw'), linkPath, 'dir');

    assert.throws(
      () =>
        ensureBncrOpenClawSdkResolution(pluginDir, {
          resolve() {
            throw new Error('not resolvable in this test');
          },
        }),
      /refusing to replace broken existing OpenClaw symlink/,
    );
    assert.equal(await readlink(linkPath), path.join(root, 'missing-openclaw'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
