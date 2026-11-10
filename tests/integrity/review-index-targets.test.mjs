import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const INDEX_PATH = new URL('../../memory/review-index.json', import.meta.url);

test('bncr review index registers one concrete state file per target', {
  skip: fs.existsSync(INDEX_PATH)
    ? false
    : 'review index is intentionally excluded from the public export',
}, () => {
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const entries = Object.entries(index.targets ?? {});
  assert.ok(entries.length > 0);

  const signatures = new Map();
  for (const [statePath, target] of entries) {
    assert.match(statePath, /^memory\/[a-z0-9-]+-review-state\.json$/, statePath);
    assert.ok(fs.existsSync(new URL(`../../${statePath}`, import.meta.url)), statePath);
    assert.equal(typeof target.target, 'string');
    assert.equal(typeof target.coverageProfile, 'string');
    assert.ok(Array.isArray(target.scopePaths) && target.scopePaths.length > 0);

    const signature = JSON.stringify([
      target.coverageProfile,
      target.target,
      [...target.scopePaths].sort(),
    ]);
    assert.equal(signatures.has(signature), false, `duplicate review target: ${statePath}`);
    signatures.set(signature, statePath);
  }
});
