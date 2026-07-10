import { execFileSync } from 'node:child_process';
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
