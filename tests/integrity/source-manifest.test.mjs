import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function collectSourceFiles(dir = path.join(root, 'src')) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path.relative(root, full).replaceAll(path.sep, '/'));
    }
  }
  return files.sort();
}

function extractSourceManifest(scriptPath) {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const match = source.match(/const requiredSourceFiles = \[([\s\S]*?)\n\];/);
  assert.ok(match, `${path.basename(scriptPath)} must declare requiredSourceFiles`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

test('source manifests cover every src TypeScript file', () => {
  const actual = collectSourceFiles();
  const manifests = [
    ['selfcheck', path.join(root, 'scripts', 'selfcheck.mjs')],
    ['check-pack', path.join(root, 'scripts', 'check-pack.mjs')],
  ];

  for (const [label, scriptPath] of manifests) {
    const entries = extractSourceManifest(scriptPath);
    const listed = new Set(entries);
    const missing = actual.filter((file) => !listed.has(file));
    const extra = entries.filter((file) => !actual.includes(file));

    assert.equal(entries.length, listed.size, `${label} has duplicate source manifest entries`);
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `${label} source manifest is out of sync`,
    );
  }
});
