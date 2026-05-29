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
  return loadWebMedia(mediaUrl, options);
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
