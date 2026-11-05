import { emitBncrLogLine } from '../../core/logging.ts';
import {
  type OpenClawLoadedMedia,
  readOpenClawRemoteMediaBuffer,
} from '../../openclaw/media-runtime.ts';
import { downloadInboundMediaUrl, type InboundMediaUrlGuard } from './media-url-download.ts';
import { assertFetchableMediaUrl } from './media-url-policy.ts';

type RuntimeApiHolder = Parameters<typeof readOpenClawRemoteMediaBuffer>[0];

let warnedHostMediaReaderFallback = false;

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

export async function loadInboundRemoteMedia(
  api: RuntimeApiHolder,
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
    runtimeLoaded = await readOpenClawRemoteMediaBuffer(api, url, maxBytes);
  } catch {
    if (!warnedHostMediaReaderFallback) {
      warnedHostMediaReaderFallback = true;
      emitBncrLogLine(
        'warn',
        '[bncr] inbound media host reader failed; using trusted direct-download fallback',
      );
    }
    return loadFallback();
  }
  if (!runtimeLoaded?.buffer?.length) return loadFallback();
  return assertLoadedInboundRemoteMedia(runtimeLoaded, 'runtime', maxBytes);
}
