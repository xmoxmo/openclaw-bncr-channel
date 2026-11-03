import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { setBncrHistoryMediaStorageForTest } from '../../src/messaging/inbound/media-assets.ts';

export async function installBncrTestMediaStorage() {
  const root = await mkdtemp(path.join(tmpdir(), 'bncr-media-test-'));
  let sequence = 0;
  setBncrHistoryMediaStorageForTest({
    async saveBuffer({ buffer, agentId, fileName }) {
      const directory = path.join(root, 'history', agentId.replace(/[^a-zA-Z0-9._-]+/g, '_'));
      await mkdir(directory, { recursive: true });
      sequence += 1;
      const suffix = path.extname(fileName || '') || '.bin';
      const savedPath = path.join(directory, `${sequence}${suffix}`);
      await writeFile(savedPath, buffer);
      return { path: savedPath };
    },
    resolveWorkspaceDir(_cfg, agentId) {
      return path.join(root, 'workspaces', agentId.replace(/[^a-zA-Z0-9._-]+/g, '_'));
    },
    getMediaDir() {
      return root;
    },
  });
  return {
    root,
    async restore() {
      setBncrHistoryMediaStorageForTest(null);
      await rm(root, { recursive: true, force: true });
    },
  };
}
