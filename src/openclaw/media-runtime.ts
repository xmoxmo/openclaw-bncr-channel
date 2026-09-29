import { existsSync } from 'node:fs';
import path from 'node:path';
import { canonicalizeBase64, estimateBase64DecodedBytes } from 'openclaw/plugin-sdk/media-runtime';

export const OPENCLAW_SEND_BUFFER_MEDIA_URL = 'buffer://message-send/attachment';
export const OPENCLAW_OUTBOUND_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

type RuntimeMediaLoaded = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

type RuntimeMediaApi = {
  loadWebMedia?: (
    mediaUrl: string,
    options?: { localRoots?: readonly string[]; maxBytes?: number },
  ) => Promise<RuntimeMediaLoaded>;
};

type RuntimeChannelMediaApi = {
  readRemoteMediaBuffer?: (options: {
    url: string;
    maxBytes?: number;
  }) => Promise<RuntimeMediaLoaded>;
  saveMediaBuffer?: (
    buffer: Buffer,
    mimeType: string | undefined,
    direction: 'inbound' | 'outbound',
    maxBytes: number,
    fileName?: string,
  ) => Promise<{ path: string }>;
};

type RuntimeApiHolder = {
  runtime?: {
    media?: RuntimeMediaApi;
    channel?: {
      media?: RuntimeChannelMediaApi;
    };
  };
};

export type OpenClawLoadedMedia = RuntimeMediaLoaded;

type OpenClawSendBufferDecodeResult = {
  buffer: Buffer;
  mimeType?: string;
  fileName?: string;
};

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * Translate a sandbox container workspace path into an authorized host path.
 *
 * `extra.path` bypasses host-side sandbox staging, so a path such as
 * `/workspace/file.js` reaches the plugin unchanged. Resolve it only against
 * roots supplied by the host and prefer the most specific matching root.
 */
function resolveContainerWorkspaceMediaPath(
  mediaUrl: string,
  localRoots?: readonly string[],
): string {
  if (!localRoots?.length || !/^\/workspace(?:\/|$)/.test(mediaUrl)) {
    return mediaUrl;
  }
  if (existsSync(mediaUrl)) {
    return mediaUrl;
  }

  const relativePath = mediaUrl.slice('/workspace'.length).replace(/^\/+/, '');
  if (!relativePath) {
    return mediaUrl;
  }

  let bestMatch: { root: string; candidate: string } | undefined;
  for (const root of localRoots) {
    const resolvedRoot = path.resolve(root);
    const candidate = path.resolve(resolvedRoot, relativePath);
    if (!isPathInsideRoot(candidate, resolvedRoot) || !existsSync(candidate)) {
      continue;
    }
    if (!bestMatch || resolvedRoot.length > bestMatch.root.length) {
      bestMatch = { root: resolvedRoot, candidate };
    }
  }

  return bestMatch?.candidate ?? mediaUrl;
}

export function isOpenClawSendBufferMediaUrl(mediaUrl: string): boolean {
  return String(mediaUrl || '').trim() === OPENCLAW_SEND_BUFFER_MEDIA_URL;
}

export function decodeOpenClawSendBuffer(params: {
  buffer: string;
  contentType?: string;
  mimeType?: string;
  filename?: string;
  fileName?: string;
  maxBytes?: number;
}): OpenClawSendBufferDecodeResult {
  const raw = String(params.buffer || '').trim();
  const match = /^data:([^;,\s]+)(;(?!base64)[^,;\s]+)*;base64,(.*)$/is.exec(raw);
  const encoded = match ? match[3] : raw;
  if (!encoded.trim()) {
    throw new Error('send buffer base64 decoded to empty buffer');
  }
  const canonical = canonicalizeBase64(encoded);
  if (!canonical) {
    throw new Error('send buffer has invalid base64 data');
  }

  const maxBytes = params.maxBytes ?? OPENCLAW_OUTBOUND_MEDIA_MAX_BYTES;
  const estimatedBytes = estimateBase64DecodedBytes(canonical);
  if (estimatedBytes > maxBytes) {
    throw new Error(
      `send buffer media too large: estimated ${estimatedBytes} bytes exceeds ${maxBytes} bytes`,
    );
  }

  const buffer = Buffer.from(canonical, 'base64');
  if (!buffer.length) {
    throw new Error('send buffer base64 decoded to empty buffer');
  }
  if (buffer.byteLength > maxBytes) {
    throw new Error(
      `send buffer media too large: decoded ${buffer.byteLength} bytes exceeds ${maxBytes} bytes`,
    );
  }

  return {
    buffer,
    mimeType:
      normalizeOptionalString(params.contentType) ??
      normalizeOptionalString(params.mimeType) ??
      normalizeOptionalString(match?.[1]),
    fileName: normalizeOptionalString(params.filename) ?? normalizeOptionalString(params.fileName),
  };
}

export function isOpenClawRemoteHttpMediaUrl(mediaUrl: string): boolean {
  return /^https?:\/\//i.test(String(mediaUrl || '').trim());
}

/**
 * Try to resolve a relative media path against each local root.
 * Returns the first absolute path that exists on disk, or the original
 * relative path if nothing is found (the host will then emit its own error).
 */
function resolveRelativeMediaPath(mediaUrl: string, localRoots?: readonly string[]): string {
  if (!mediaUrl || !localRoots?.length) return mediaUrl;
  const containerWorkspacePath = resolveContainerWorkspaceMediaPath(mediaUrl, localRoots);
  if (containerWorkspacePath !== mediaUrl) return containerWorkspacePath;
  if (path.isAbsolute(mediaUrl)) return mediaUrl;
  // HTTP / file:// / data: / ~ paths are handled elsewhere
  if (/^(https?|file|data):/i.test(mediaUrl) || mediaUrl.startsWith('~')) return mediaUrl;
  for (const root of localRoots) {
    const candidate = path.resolve(root, mediaUrl);
    if (existsSync(candidate)) return candidate;
  }
  return mediaUrl;
}

export async function loadOpenClawWebMedia(
  api: RuntimeApiHolder,
  mediaUrl: string,
  options?: { localRoots?: readonly string[]; maxBytes?: number },
): Promise<RuntimeMediaLoaded> {
  const readRemoteMediaBuffer = api?.runtime?.channel?.media?.readRemoteMediaBuffer;
  if (isOpenClawRemoteHttpMediaUrl(mediaUrl) && typeof readRemoteMediaBuffer === 'function') {
    return readRemoteMediaBuffer({ url: mediaUrl, maxBytes: options?.maxBytes });
  }

  const loadWebMedia = api?.runtime?.media?.loadWebMedia;
  if (typeof loadWebMedia !== 'function') {
    throw new Error('OpenClaw runtime media loadWebMedia API is unavailable');
  }

  // Resolve relative paths against local roots before handing off to the host
  const resolvedUrl = resolveRelativeMediaPath(mediaUrl, options?.localRoots);

  return loadWebMedia(resolvedUrl, options);
}

export async function saveOpenClawChannelMediaBuffer(
  api: RuntimeApiHolder,
  buffer: Buffer,
  mimeType: string | undefined,
  direction: 'inbound' | 'outbound',
  maxBytes: number,
  fileName?: string,
): Promise<{ path: string }> {
  const saveMediaBuffer = api?.runtime?.channel?.media?.saveMediaBuffer;
  if (typeof saveMediaBuffer !== 'function') {
    throw new Error('OpenClaw channel media saveMediaBuffer API is unavailable');
  }
  return saveMediaBuffer(buffer, mimeType, direction, maxBytes, fileName);
}
