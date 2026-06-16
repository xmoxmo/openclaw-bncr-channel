export const INBOUND_MEDIA_URL_MAX_BYTES = 200 * 1024 * 1024;
const INBOUND_MEDIA_URL_TIMEOUT_MS = 30_000;

export function isHttpMediaUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function readResponseHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof (headers as { get?: unknown }).get !== 'function') return undefined;
  const value = (headers as { get(name: string): string | null }).get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeInboundMediaUrlTimeoutMs(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : INBOUND_MEDIA_URL_TIMEOUT_MS;
}

async function readInboundMediaResponseBody(args: {
  response: Response;
  maxBytes: number;
  abort: () => void;
}): Promise<Buffer> {
  const body = args.response.body;
  if (!body || typeof body.getReader !== 'function') {
    const buffer = Buffer.from(await args.response.arrayBuffer());
    if (buffer.length > args.maxBytes) {
      throw new Error(
        `inbound media url too large: ${buffer.length} bytes exceeds ${args.maxBytes} bytes`,
      );
    }
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > args.maxBytes) {
        args.abort();
        throw new Error(
          `inbound media url too large: ${total} bytes exceeds ${args.maxBytes} bytes`,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function downloadInboundMediaUrl(
  url: string,
  maxBytes = INBOUND_MEDIA_URL_MAX_BYTES,
  timeoutMs = INBOUND_MEDIA_URL_TIMEOUT_MS,
): Promise<{ buffer: Buffer; contentType?: string }> {
  if (typeof fetch !== 'function') {
    throw new Error('inbound media url download unavailable: fetch is not available');
  }

  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, normalizeInboundMediaUrlTimeoutMs(timeoutMs));

  try {
    const response = await fetch(url, { signal: abortController.signal });
    if (!response.ok) {
      throw new Error(`inbound media url download failed: HTTP ${response.status}`);
    }

    const contentLength = Number(readResponseHeader(response.headers, 'content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      abortController.abort();
      throw new Error(
        `inbound media url too large: content-length ${contentLength} bytes exceeds ${maxBytes} bytes`,
      );
    }

    const buffer = await readInboundMediaResponseBody({
      response,
      maxBytes,
      abort: () => abortController.abort(),
    });
    if (!buffer.length) throw new Error('inbound media url downloaded empty buffer');

    return { buffer, contentType: readResponseHeader(response.headers, 'content-type') };
  } catch (err) {
    if (timedOut) throw new Error(`inbound media url download timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
