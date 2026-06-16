import type { BncrRoute } from '../core/types.ts';
import { createBncrChannelSendRuntimeComponent } from './channel-components.ts';

export function createBncrChannelSendRuntimeGroup(runtime: {
  channelId: string;
  asString: (value: unknown, fallback?: string) => string;
  syncDebugFlag: () => Promise<void>;
  logInfo: (scope: string, message: string, options?: Record<string, unknown>) => void;
  resolveVerifiedTarget: (
    to: string,
    accountId: string,
  ) => {
    sessionKey: string;
    route: BncrRoute;
    displayScope: string;
  };
  rememberSessionRoute: (sessionKey: string, accountId: string, route: BncrRoute) => void;
  enqueueFromReply: Parameters<typeof createBncrChannelSendRuntimeComponent>[0]['enqueueFromReply'];
  listOutboxEntries: Parameters<
    typeof createBncrChannelSendRuntimeComponent
  >[0]['listOutboxEntries'];
}) {
  const channelSendRuntime = createBncrChannelSendRuntimeComponent({
    channelId: runtime.channelId,
    asString: runtime.asString,
    syncDebugFlag: runtime.syncDebugFlag,
    logInfo: runtime.logInfo,
    resolveVerifiedTarget: runtime.resolveVerifiedTarget,
    rememberSessionRoute: runtime.rememberSessionRoute,
    enqueueFromReply: runtime.enqueueFromReply,
    listOutboxEntries: runtime.listOutboxEntries,
  });

  return {
    channelSendRuntime,
  };
}
