import type { OpenClawLoadedMedia } from '../../openclaw/media-runtime.ts';
import { downloadInboundMediaUrl, type InboundMediaUrlGuard } from './media-url-download.ts';
import { assertFetchableMediaUrl } from './media-url-policy.ts';

type RuntimeChannelMediaReader = {
  runtime?: {
    channel?: {
      media?: {
        readRemoteMediaBuffer?: (options: {
          url: string;
          maxBytes?: number;
          ssrfPolicy?: { allowPrivateNetwork?: boolean };
        }) => Promise<OpenClawLoadedMedia>;
      };
    };
  };
};

function assertLoadedInboundRemoteMedia(
  loaded: OpenClawLoadedMedia,
  source: 'runtime' | 'fallback',
  maxBytes: number,
): OpenClawLoadedMedia {
  if (!loaded?.buffer?.length) {
    throw new Error(`inbound remote media ${source} download returned empty buffer`);
  }
  if (loaded.buffer.byteLength > maxBytes) {
    throw new Error(
      `inbound remote media ${source} download is too large: ${loaded.buffer.byteLength} > ${maxBytes}`,
    );
  }
  return loaded;
}

async function readRemoteMediaBufferFromRuntime(
  api: RuntimeChannelMediaReader,
  url: string,
  maxBytes: number,
): Promise<OpenClawLoadedMedia> {
  const readRemoteMediaBuffer = api?.runtime?.channel?.media?.readRemoteMediaBuffer;
  if (typeof readRemoteMediaBuffer !== 'function') {
    throw new Error('OpenClaw channel media readRemoteMediaBuffer API is unavailable');
  }
  return readRemoteMediaBuffer({ url, maxBytes, ssrfPolicy: { allowPrivateNetwork: true } });
}

export async function loadInboundRemoteMedia(
  api: RuntimeChannelMediaReader,
  url: string,
  maxBytes: number,
  options?: { urlGuard?: InboundMediaUrlGuard },
): Promise<OpenClawLoadedMedia> {
  const loadFallback = async () => {
    // Host reader failed (unavailable, or host-side policy). The fallback does a
    // direct fetch under the same trust model: Bncr treats internal and public
    // destinations identically, so it only validates URL shape, not destination.
    const urlGuard = options?.urlGuard ?? assertFetchableMediaUrl;
    return assertLoadedInboundRemoteMedia(
      await downloadInboundMediaUrl(url, maxBytes, undefined, urlGuard),
      'fallback',
      maxBytes,
    );
  };
  let runtimeLoaded: OpenClawLoadedMedia;
  try {
    runtimeLoaded = await readRemoteMediaBufferFromRuntime(api, url, maxBytes);
  } catch {
    return loadFallback();
  }
  if (!runtimeLoaded?.buffer?.length) return loadFallback();
  return assertLoadedInboundRemoteMedia(runtimeLoaded, 'runtime', maxBytes);
}
