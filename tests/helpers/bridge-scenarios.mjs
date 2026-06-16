import { cleanupBridge, createBridge } from './bncr-bridge.mjs';
import { withConsoleCapture } from './console-capture.mjs';

export async function withBridge(fn, options = {}) {
  const bridge = createBridge(options.logs, options);
  try {
    return await fn(bridge);
  } finally {
    cleanupBridge(bridge);
  }
}

export async function withBridgeAndConsoleCapture(channels, fn, options = {}) {
  return withConsoleCapture(channels, async (captures) =>
    withBridge((bridge) => fn({ bridge, captures }), options),
  );
}
