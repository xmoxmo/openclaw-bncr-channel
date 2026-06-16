import { createBncrFileInboundAbortHandler } from './file-inbound-abort.ts';
import { createBncrFileInboundChunkHandler } from './file-inbound-chunk.ts';
import { createBncrFileInboundCompleteHandler } from './file-inbound-complete.ts';
import { createBncrFileInboundInitHandler } from './file-inbound-init.ts';
import type { BncrFileInboundRuntime } from './file-inbound-runtime.ts';

export function createBncrFileInboundHandlers(runtime: BncrFileInboundRuntime) {
  const handleFileInit = createBncrFileInboundInitHandler(runtime);
  const handleFileChunk = createBncrFileInboundChunkHandler(runtime);
  const handleFileComplete = createBncrFileInboundCompleteHandler(runtime);
  const handleFileAbort = createBncrFileInboundAbortHandler(runtime);

  return {
    handleFileInit,
    handleFileChunk,
    handleFileComplete,
    handleFileAbort,
  };
}
