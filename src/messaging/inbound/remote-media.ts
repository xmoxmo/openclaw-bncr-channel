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
): OpenClawLoadedMedia {
  if (!loaded?.buffer?.length) {
    throw new Error(`inbound remote media ${source} download returned empty buffer`);
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
  return assertLoadedInboundRemoteMedia(
    await readRemoteMediaBuffer({ url, maxBytes, ssrfPolicy: { allowPrivateNetwork: true } }),
    'runtime',
  );
}

export async function loadInboundRemoteMedia(
  api: RuntimeChannelMediaReader,
  url: string,
  maxBytes: number,
  options?: { urlGuard?: InboundMediaUrlGuard },
): Promise<OpenClawLoadedMedia> {
  try {
    return await readRemoteMediaBufferFromRuntime(api, url, maxBytes);
  } catch {
    // Host reader failed (unavailable, or host-side policy). The fallback does a
    // direct fetch under the same trust model: Bncr treats internal and public
    // destinations identically, so it only validates URL shape, not destination.
    const urlGuard = options?.urlGuard ?? assertFetchableMediaUrl;
    return assertLoadedInboundRemoteMedia(
      await downloadInboundMediaUrl(url, maxBytes, undefined, urlGuard),
      'fallback',
    );
  }
}
