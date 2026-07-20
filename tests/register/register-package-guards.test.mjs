import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const REQUIRED_OPENCLAW_RANGE = '>=2026.5.27';
const CHANNEL_SDK_HELPER_IMPORTS = [
  'openclaw/plugin-sdk/json-store',
  'openclaw/plugin-sdk/param-readers',
  'openclaw/plugin-sdk/status-helpers',
  'openclaw/plugin-sdk/tool-send',
];

test('bncr package and README require the OpenClaw 2026.5.27 runtime baseline', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

  assert.equal(pkg.peerDependencies?.openclaw, REQUIRED_OPENCLAW_RANGE);
  assert.equal(pkg.devDependencies?.openclaw, REQUIRED_OPENCLAW_RANGE);
  assert.match(readme, /兼容范围：`openclaw >= 2026\.5\.27`/);
  assert.equal(readme.includes('openclaw >= 2026.5.3-1'), false);
});

test('bncr README documents the package dry-run check', () => {
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

  assert.match(readme, /npm run check-pack/);
  assert.match(readme, /npm pack --dry-run --json/);
});

test('bncr fullcheck includes typecheck in the full verification path and README documents it', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

  assert.equal(
    pkg.scripts?.fullcheck,
    'npm run typecheck && npm run check && npm test && npm run selfcheck && npm run check-pack && npm run format:check',
  );
  assert.match(readme, /npm run fullcheck/);
  assert.match(readme, /npm run typecheck/);
  assert.match(readme, /npm run check/);
  assert.match(readme, /typecheck \+ check \+ test \+ selfcheck \+ check-pack \+ format:check/);
  assert.match(readme, /npm run format:check/);
});

test('bncr README documents channel handoff rather than final platform delivery semantics', () => {
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

  assert.match(readme, /进入 bncr 自管 outbox，即表示频道 handoff 完成/);
  assert.match(readme, /不等价于客户端 ACK 或目标平台最终送达/);
  assert.match(readme, /后续可靠投递由 bncr 自身负责/);
  assert.match(readme, /已注册生产 `channel\.message` 作为 bncr 的频道专用 handoff adapter/);
  assert.match(readme, /`text` \/ `media` \/ `payload` 会转换为 bncr outbox entry/);
  assert.match(readme, /原有通用 `message\.send` \/ `channel\.actions\.send` 发送能力继续保留/);
  assert.match(readme, /`channel\.message` 是频道专用入口，不替代通用发送入口/);
  assert.match(readme, /仍不启用 `durableFinal`/);
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
