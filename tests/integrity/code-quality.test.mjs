import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function runTool(name, bin, args) {
  test(`code-quality: ${name}`, () => {
    try {
      execFileSync(bin, args, {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 60_000,
      });
    } catch (err) {
      const stderr = err.stderr || '';
      const stdout = err.stdout || '';
      throw new Error(`${name} failed:\n${stdout || ''}${stderr || ''}${err.message || ''}`);
    }
  });
}

runTool('biome ci (format+lint)', 'node_modules/.bin/biome', ['ci', '.']);
runTool('tsc typecheck', 'node_modules/.bin/tsc', ['-p', 'tsconfig.typecheck.json', '--noEmit']);

function walkAndFindNewer(dir, refTime) {
  const stale = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      stale.push(...walkAndFindNewer(full, refTime));
    } else if (entry.name.endsWith('.ts') && fs.statSync(full).mtimeMs > refTime + 1000) {
      stale.push(full);
    }
  }
  return stale;
}

test('code-quality: dist is up-to-date', () => {
  const distPath = path.resolve(root, 'dist/index.js');
  let distTime;
  try {
    distTime = fs.statSync(distPath).mtimeMs;
  } catch {
    throw new Error('dist/index.js not found — run `npm run build` first');
  }

  const srcDir = path.resolve(root, 'src');
  const staleSrc = walkAndFindNewer(srcDir, distTime);
  if (staleSrc.length > 0) {
    throw new Error(
      `dist/index.js is stale (built ${new Date(distTime).toISOString()}). ` +
        `Newer source files:\n  ${staleSrc.slice(0, 10).join('\n  ')}` +
        (staleSrc.length > 10 ? `\n  ... and ${staleSrc.length - 10} more` : '') +
        '\nRun `npm run build` to rebuild.',
    );
  }
});
