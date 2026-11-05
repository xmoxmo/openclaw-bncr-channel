import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { STALE_SCENES_FILTERS } from '../../src/messaging/inbound/command-constants.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('README documents exactly the canonical stale filters', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const documented = [...readme.matchAll(/\/bncr stale \[([a-z|]+)\]/g)].map((match) =>
    match[1].split('|'),
  );
  assert.ok(documented.length > 0, 'README must document the /bncr stale filters');
  for (const list of documented) assert.deepEqual(list, [...STALE_SCENES_FILTERS]);
});

test('README scopes omitted-agent fan-out and stale activity consistently', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /管理员省略 `<agentId>` 时改动该场景所有 agent 的行/);
  assert.match(readme, /私聊非管理员省略时只作用于自己的 agent 行/);
  assert.match(readme, /活动优先取 `lastInteractionAt`/);
  assert.match(readme, /store-write fallback/);
});
