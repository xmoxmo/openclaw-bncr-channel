import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  extensionForOpenClawMime,
  resolveOpenClawMediaDir,
  saveOpenClawMediaBuffer,
} from '../../openclaw/media-runtime.ts';

export const BNCR_MEDIA_REF_PREFIX = 'bncr-media:';

export type BncrMediaSourceErrorCode =
  | 'SOURCE_REQUIRED'
  | 'SOURCE_KIND_INVALID'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_TOO_LARGE'
  | 'SOURCE_FETCH_FAILED';

export class BncrMediaSourceError extends Error {
  readonly code: BncrMediaSourceErrorCode;

  constructor(code: BncrMediaSourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BncrMediaSourceError';
    this.code = code;
  }
}

type HistoryMediaStorage = {
  saveBuffer: (args: {
    buffer: Buffer;
    contentType?: string;
    agentId: string;
    maxBytes: number;
    fileName?: string;
  }) => Promise<{ path: string }>;
  getMediaDir: () => string;
};

const defaultStorage: HistoryMediaStorage = {
  async saveBuffer(args) {
    return saveOpenClawMediaBuffer(
      args.buffer,
      args.contentType,
      `history/${sanitizeMediaPathSegment(args.agentId)}`,
      args.maxBytes,
      args.fileName,
    );
  },
  getMediaDir() {
    return resolveOpenClawMediaDir();
  },
};

let storage = defaultStorage;

export function setBncrHistoryMediaStorageForTest(next: Partial<HistoryMediaStorage> | null): void {
  storage = next
    ? {
        saveBuffer: next.saveBuffer ?? defaultStorage.saveBuffer,
        getMediaDir: next.getMediaDir ?? defaultStorage.getMediaDir,
      }
    : defaultStorage;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`))
  );
}

function sanitizeMediaPathSegment(value: string): string {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+$/, 'agent');
  return normalized || 'unknown';
}

export function createBncrMediaId(): string {
  return `${BNCR_MEDIA_REF_PREFIX}${randomUUID()}`;
}

export function isBncrMediaRef(value: string): boolean {
  return String(value || '')
    .trim()
    .startsWith(BNCR_MEDIA_REF_PREFIX);
}

export async function saveBncrHistoryMediaBuffer(args: {
  buffer: Buffer;
  contentType?: string;
  agentId: string;
  maxBytes: number;
  fileName?: string;
}): Promise<{ path: string }> {
  return storage.saveBuffer(args);
}

export async function readBncrMediaFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`media path is not a regular file: ${filePath}`);
    if (info.size > maxBytes)
      throw new Error(`media file is too large: ${info.size} > ${maxBytes}`);
    const buffer = await handle.readFile();
    if (buffer.byteLength > maxBytes) {
      throw new Error(`media file is too large: ${buffer.byteLength} > ${maxBytes}`);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

export async function assertBncrManagedMediaFile(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  const source = String(filePath || '').trim();
  if (!source) throw new BncrMediaSourceError('SOURCE_REQUIRED', 'media source is required');
  if (!path.isAbsolute(source)) {
    throw new BncrMediaSourceError(
      'SOURCE_NOT_FOUND',
      'local media source must be an absolute managed path',
    );
  }

  let resolvedRoot: string;
  let resolvedSource: string;
  try {
    resolvedRoot = await fs.realpath(storage.getMediaDir());
    resolvedSource = await fs.realpath(source);
  } catch (error) {
    throw new BncrMediaSourceError('SOURCE_NOT_FOUND', 'media source is not available', {
      cause: error,
    });
  }
  if (!isPathInsideRoot(resolvedSource, resolvedRoot)) {
    // A path outside the managed store is indistinguishable from an
    // unavailable path at this boundary.
    throw new BncrMediaSourceError(
      'SOURCE_NOT_FOUND',
      'local media source is outside the OpenClaw media directory',
    );
  }

  let info: Awaited<ReturnType<typeof fs.stat>>;
  try {
    info = await fs.stat(resolvedSource);
  } catch (error) {
    throw new BncrMediaSourceError('SOURCE_NOT_FOUND', 'media source is not available', {
      cause: error,
    });
  }
  if (!info.isFile()) {
    throw new BncrMediaSourceError('SOURCE_NOT_FOUND', 'media source is not a regular file');
  }
  if (info.size > maxBytes) {
    throw new BncrMediaSourceError(
      'SOURCE_TOO_LARGE',
      `media source is too large: ${info.size} > ${maxBytes}`,
    );
  }
  return resolvedSource;
}

async function writeBncrMaterializedMedia(args: {
  workspaceDir: string;
  mediaRef: string;
  contentType?: string;
  fileName?: string;
  contentDiscriminator?: string;
  write: (hostPath: string) => Promise<void>;
  assertCurrent?: () => void;
}): Promise<{ mediaUri: string; hostPath: string }> {
  const extension =
    extensionForOpenClawMime(args.contentType || '') ||
    path.extname(args.fileName || '').replace(/[^a-zA-Z0-9.]/g, '');
  const discriminator = args.contentDiscriminator
    ? `_${sanitizeMediaPathSegment(args.contentDiscriminator)}`
    : '';
  const fileName = `${sanitizeMediaPathSegment(args.mediaRef)}${discriminator}${extension}`;
  args.assertCurrent?.();
  await fs.mkdir(args.workspaceDir, { recursive: true });
  const resolvedWorkspaceDir = await fs.realpath(args.workspaceDir);
  const mediaDir = path.join(resolvedWorkspaceDir, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  const resolvedMediaDir = await fs.realpath(mediaDir);
  if (!isPathInsideRoot(resolvedMediaDir, resolvedWorkspaceDir)) {
    throw new Error('media output directory is outside the agent workspace');
  }
  const targetDir = path.join(resolvedMediaDir, 'inbound');
  await fs.mkdir(targetDir, { recursive: true });
  const resolvedTargetDir = await fs.realpath(targetDir);
  if (!isPathInsideRoot(resolvedTargetDir, resolvedWorkspaceDir)) {
    throw new Error('media output directory is outside the agent workspace');
  }
  const hostPath = path.join(resolvedTargetDir, fileName);
  const temporaryPath = `${hostPath}.${randomUUID()}.tmp`;
  try {
    args.assertCurrent?.();
    await args.write(temporaryPath);
    args.assertCurrent?.();
    await fs.rename(temporaryPath, hostPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    mediaUri: `media://inbound/${encodeURIComponent(fileName)}`,
    hostPath,
  };
}

export async function materializeBncrMediaBuffer(args: {
  workspaceDir: string;
  mediaRef: string;
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  assertCurrent?: () => void;
}): Promise<{ mediaUri: string; hostPath: string }> {
  const contentDigest = createHash('sha256').update(args.buffer).digest('hex').slice(0, 16);
  return writeBncrMaterializedMedia({
    ...args,
    contentDiscriminator: contentDigest,
    write: (hostPath) => fs.writeFile(hostPath, args.buffer),
  });
}
