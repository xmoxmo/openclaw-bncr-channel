import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  resolveBncrPluginRoot,
  resolveBncrRuntimeSourceDir,
} from '../../src/bootstrap/runtime-discovery.ts';
import { resolvePluginEntryFileFromModule } from '../../src/bootstrap/runtime-loader.ts';

test('runtime loader resolves dist bundle paths back to the bncr plugin root and source runtime', () => {
  const distModuleUrl = new URL('../../dist/index.js', import.meta.url).href;
  const pluginFile = resolvePluginEntryFileFromModule(distModuleUrl);
  const pluginDir = path.dirname(pluginFile);
  const pluginRoot = resolveBncrPluginRoot(pluginFile);
  const runtimeSourceDir = resolveBncrRuntimeSourceDir(pluginDir);

  // 适配工作仓 (bncr) 和发布仓 (bncr-public) 等不同目录名
  assert.match(pluginFile, /\/bncr(?:-public)?\/dist\/index\.js$/);
  assert.match(pluginDir, /\/bncr(?:-public)?\/dist$/);
  assert.match(pluginRoot, /\/bncr(?:-public)?$/);
  assert.match(runtimeSourceDir, /\/bncr(?:-public)?\/src$/);
});
