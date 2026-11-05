import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const REQUIRED_OPENCLAW_RANGE = '>=2026.10.10';
const BROAD_RUNTIME_BARRELS = [
  'openclaw/plugin-sdk/agent-runtime',
  'openclaw/plugin-sdk/conversation-runtime',
  'openclaw/plugin-sdk/media-runtime',
  'openclaw/plugin-sdk/security-runtime',
];
const CHANNEL_SDK_HELPER_IMPORTS = [
  'openclaw/plugin-sdk/json-store',
  'openclaw/plugin-sdk/param-readers',
  'openclaw/plugin-sdk/status-helpers',
  'openclaw/plugin-sdk/tool-send',
];

test('bncr package and README require the OpenClaw 2026.10.10 runtime baseline', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

  assert.equal(pkg.peerDependencies?.openclaw, REQUIRED_OPENCLAW_RANGE);
  assert.equal(pkg.devDependencies?.openclaw, REQUIRED_OPENCLAW_RANGE);
  assert.match(readme, /当前兼容 `OpenClaw >= 2026\.10\.10`/);
  assert.equal(readme.includes('openclaw >= 2026.5.3-1'), false);
});

function listSourceFiles(directory = new URL('../../src/', import.meta.url)) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), current);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push({ name: entry.name, source: fs.readFileSync(child, 'utf8') });
      }
    }
  }
  return files;
}

test('bncr keeps broad mutable host runtime integration behind local adapters', () => {
  const violations = [];
  for (const { name, source } of listSourceFiles()) {
    for (const specifier of BROAD_RUNTIME_BARRELS) {
      if (source.includes(`from '${specifier}'`)) violations.push(`${name}: ${specifier}`);
    }
  }

  assert.deepEqual(violations, []);
});

test('bncr source does not call retired session-store APIs', () => {
  const retiredApis = ['patchSessionEntry', 'listSessionEntries', 'updateSessionStoreEntry'];
  const violations = [];
  for (const { name, source } of listSourceFiles()) {
    for (const api of retiredApis) {
      if (new RegExp(`\\b${api}\\b`).test(source)) violations.push(`${name}: ${api}`);
    }
  }

  assert.deepEqual(violations, []);
});

test('bncr README documents the basic installation and health checks', () => {
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

  assert.match(readme, /openclaw plugins install @xmoxmo\/bncr/);
  assert.match(readme, /openclaw gateway status/);
  assert.match(readme, /openclaw gateway health/);
});

test('bncr fullcheck keeps the repository verification path', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  assert.equal(
    pkg.scripts?.fullcheck,
    'npm run typecheck && npm run check && npm test && npm run selfcheck && npm run check-pack && npm run format:check',
  );
});

test('bncr README documents the user-facing delivery capabilities', () => {
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

  assert.match(readme, /文本消息/);
  assert.match(readme, /文件传输和媒体附件/);
  assert.match(readme, /会话历史上下文/);
  assert.match(readme, /离线排队、ACK、重试和重连/);
});

test('bncr channel routes OpenClaw SDK helper imports through the local adapter', () => {
  const adapterSource = fs.readFileSync(
    new URL('../../src/openclaw/sdk-helpers.ts', import.meta.url),
    'utf8',
  );

  for (const specifier of CHANNEL_SDK_HELPER_IMPORTS) {
    assert.match(adapterSource, new RegExp(`from '${specifier.replace('/', '\\/')}'`), specifier);
  }

  const channelSource = fs.readFileSync(new URL('../../src/channel.ts', import.meta.url), 'utf8');
  for (const specifier of CHANNEL_SDK_HELPER_IMPORTS) {
    assert.equal(channelSource.includes(`from '${specifier}'`), false, specifier);
  }
});
