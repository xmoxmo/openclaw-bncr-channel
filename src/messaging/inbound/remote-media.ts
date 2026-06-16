import type { OpenClawLoadedMedia } from '../../openclaw/media-runtime.ts';
import { downloadInboundMediaUrl, INBOUND_MEDIA_URL_MAX_BYTES } from './media-url-download.ts';

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
  maxBytes = INBOUND_MEDIA_URL_MAX_BYTES,
): Promise<OpenClawLoadedMedia> {
  try {
    return await readRemoteMediaBufferFromRuntime(api, url, maxBytes);
  } catch {
    return assertLoadedInboundRemoteMedia(await downloadInboundMediaUrl(url, maxBytes), 'fallback');
  }
}
