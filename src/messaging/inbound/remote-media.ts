import type { OpenClawLoadedMedia } from '../../openclaw/media-runtime.ts';
import { downloadInboundMediaUrl, type InboundMediaUrlGuard } from './media-url-download.ts';
import { assertPublicInboundMediaUrl } from './media-url-policy.ts';

type RuntimeChannelMediaReader = {
  runtime?: {
    channel?: {
      media?: {
        readRemoteMediaBuffer?: (options: {
          url: string;
          maxBytes?: number;
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
  return assertLoadedInboundRemoteMedia(await readRemoteMediaBuffer({ url, maxBytes }), 'runtime');
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
    // The host reader applies its own destination policy. The internal fallback
    // must enforce the same boundary itself instead of retrying the rejected URL
    // through a raw fetch.
    const urlGuard = options?.urlGuard ?? assertPublicInboundMediaUrl;
    return assertLoadedInboundRemoteMedia(
      await downloadInboundMediaUrl(url, maxBytes, undefined, urlGuard),
      'fallback',
    );
  }
}
