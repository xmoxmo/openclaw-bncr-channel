import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

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

async function resolveBundleInputs() {
  const result = await build({
    entryPoints: [path.join(root, 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    write: false,
    metafile: true,
    absWorkingDir: root,
    outfile: path.join(root, 'dist', 'index.js'),
  });
  return Object.keys(result.metafile.inputs).map((input) => path.resolve(root, input));
}

test('code-quality: dist is up-to-date', async () => {
  const distPath = path.resolve(root, 'dist/index.js');
  let distTime;
  try {
    distTime = fs.statSync(distPath).mtimeMs;
  } catch {
    throw new Error('dist/index.js not found — run `npm run build` first');
  }

  const bundleInputs = await resolveBundleInputs();
  const stale = bundleInputs.filter((input) => fs.statSync(input).mtimeMs > distTime + 1000);
  if (stale.length > 0) {
    throw new Error(
      `dist/index.js is stale (built ${new Date(distTime).toISOString()}). ` +
        `Newer source files:\n  ${stale
          .slice(0, 10)
          .map((file) => path.relative(root, file))
          .join('\n  ')}` +
        (stale.length > 10 ? `\n  ... and ${stale.length - 10} more` : '') +
        '\nRun `npm run build` to rebuild.',
    );
  }
});
