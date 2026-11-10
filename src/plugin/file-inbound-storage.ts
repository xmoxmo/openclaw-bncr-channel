import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, unlinkSync } from 'node:fs';
import { chmod, mkdir, open, readdir, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { resolveOpenClawMediaDir } from '../openclaw/media-runtime.ts';

const STAGING_DIR_NAME = '.bncr-inbound-staging';
const STAGING_FILE_SUFFIX = '.part';

export function resolveInboundStagingDir(): string {
  return path.join(resolveOpenClawMediaDir(), STAGING_DIR_NAME);
}

async function ensurePrivateStagingDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export async function createInboundStagingFile(): Promise<string> {
  const dir = resolveInboundStagingDir();
  await ensurePrivateStagingDir(dir);
  const stagingPath = path.join(dir, `${randomUUID()}${STAGING_FILE_SUFFIX}`);
  const handle = await open(stagingPath, 'wx', 0o600);
  await handle.close();
  return stagingPath;
}

export async function writeInboundChunkAtOffset(args: {
  stagingPath: string;
  offset: number;
  buffer: Buffer;
}): Promise<void> {
  const handle = await open(args.stagingPath, 'r+');
  try {
    let written = 0;
    while (written < args.buffer.length) {
      const result = await handle.write(
        args.buffer,
        written,
        args.buffer.length - written,
        args.offset + written,
      );
      if (!result.bytesWritten) throw new Error('staging write made no progress');
      written += result.bytesWritten;
    }
  } finally {
    await handle.close();
  }
}

export async function discardInboundStagingFile(stagingPath: string | undefined): Promise<void> {
  if (!stagingPath) return;
  await rm(stagingPath, { force: true });
}

export function discardInboundStagingFileSync(stagingPath: string | undefined): void {
  if (!stagingPath) return;
  try {
    unlinkSync(stagingPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function validateInboundStagingFile(args: {
  stagingPath: string;
  expectedSize: number;
  expectedSha256: string;
}): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(args.stagingPath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > args.expectedSize) {
      throw new Error(`file size mismatch expected=${args.expectedSize} got>${args.expectedSize}`);
    }
    hash.update(bytes);
  }
  if (size !== args.expectedSize) {
    throw new Error(`file size mismatch expected=${args.expectedSize} got=${size}`);
  }
  const sha256 = hash.digest('hex');
  if (args.expectedSha256 && sha256 !== args.expectedSha256) {
    throw new Error('file sha256 mismatch');
  }
  return { size, sha256 };
}

export async function pruneInboundStagingFiles(maxAgeMs: number): Promise<void> {
  const dir = resolveInboundStagingDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const now = Date.now();
  await Promise.all(
    names
      .filter((name) => name.endsWith(STAGING_FILE_SUFFIX))
      .map(async (name) => {
        const candidate = path.join(dir, name);
        try {
          const info = await stat(candidate);
          if (info.isFile() && now - info.mtimeMs > maxAgeMs) await unlink(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }),
  );
}
