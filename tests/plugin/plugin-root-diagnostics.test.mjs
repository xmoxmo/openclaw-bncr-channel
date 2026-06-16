import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createBncrBridge } from '../../src/channel.ts';
import { createApiStub } from '../helpers/bncr-bridge.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginFile = path.join(pluginRoot, 'index.ts');

test('plugin file diagnostics use injected plugin root instead of process cwd', () => {
  const previousCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bncr-cwd-'));
  try {
    process.chdir(tmp);
    const bridge = createBncrBridge(createApiStub(), { pluginRoot, pluginFile });
    const diagnostics = bridge.buildExtendedDiagnostics('Primary');

    assert.equal(diagnostics.regression.pluginFilesPresent, true);
    assert.equal(diagnostics.regression.pluginIndexExists, true);
    assert.equal(diagnostics.regression.pluginChannelExists, true);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
