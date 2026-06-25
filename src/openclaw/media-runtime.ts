import { existsSync } from 'node:fs';
import path from 'node:path';

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

export function isOpenClawRemoteHttpMediaUrl(mediaUrl: string): boolean {
  return /^https?:\/\//i.test(String(mediaUrl || '').trim());
}

/**
 * Try to resolve a relative media path against each local root.
 * Returns the first absolute path that exists on disk, or the original
 * relative path if nothing is found (the host will then emit its own error).
 */
export function resolveRelativeMediaPath(mediaUrl: string, localRoots?: readonly string[]): string {
  if (!mediaUrl || !localRoots?.length) return mediaUrl;
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
