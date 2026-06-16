import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { BncrConnection, BncrRoute } from '../core/types.ts';
import {
  createBncrFileInboundHandlersComponent,
  createBncrInboundHandlersComponent,
} from './channel-components.ts';
import type {
  buildInboundAcceptedLifecycleDebugInfo,
  buildInboundResponsePayload,
} from './channel-inbound-helpers.ts';
import type { createBncrFileInboundHandlers } from './file-inbound-handlers.ts';

export function createBncrInboundSurfaceHandlersGroup(runtime: {
  getApi: Parameters<typeof createBncrFileInboundHandlersComponent>[0]['getApi'];
  channelId: string;
  bridgeId: string;
  pluginRoot: string;
  asString: (value: unknown, fallback?: string) => string;
  now: () => number;
  normalizeAccountId: (value: string) => string;
  finiteNonNegativeNumberOrNull: (value: unknown) => number | null;
  syncDebugFlag: () => Promise<void>;
  shouldIgnoreStaleEvent: (args: {
    kind:
      | 'inbound'
      | 'activity'
      | 'ack'
      | 'file.init'
      | 'file.chunk'
      | 'file.complete'
      | 'file.abort';
    payload: { leaseId?: string; connectionEpoch?: number };
    accountId: string;
    connId: string;
    clientId?: string;
  }) => boolean;
  observeLease: (
    kind:
      | 'connect'
      | 'inbound'
      | 'activity'
      | 'ack'
      | 'file.init'
      | 'file.chunk'
      | 'file.complete'
      | 'file.abort',
    payload: { leaseId?: string; connectionEpoch?: number },
  ) => { stale: boolean };
  matchesTransferOwner: Parameters<typeof createBncrFileInboundHandlers>[0]['matchesTransferOwner'];
  refreshAcceptedFileTransferLiveState: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    context: GatewayRequestHandlerOptions['context'];
  }) => void;
  refreshLiveConnectionState: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady: boolean;
    preferredForOutbound: boolean;
    inboundOnly: boolean;
    context: GatewayRequestHandlerOptions['context'];
  }) => void;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: Parameters<typeof createBncrFileInboundHandlers>[0]['logWarn'];
  logError: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  buildInboundResponsePayload: typeof buildInboundResponsePayload;
  buildInboundAcceptedLifecycleDebugInfo: typeof buildInboundAcceptedLifecycleDebugInfo;
  isOnline: (accountId: string) => boolean;
  hasRecentInboundReachability: (accountId: string) => boolean;
  getActiveConnectionKey: (accountId: string) => string | null;
  buildActiveConnectionDebugList: (accountId: string) => BncrConnection[];
  markLastInboundAt: (accountId: string) => void;
  ensureCanonicalAgentId: Parameters<
    typeof createBncrInboundHandlersComponent
  >[0]['ensureCanonicalAgentId'];
  prepareInboundAcceptance: Parameters<
    typeof createBncrInboundHandlersComponent
  >[0]['prepareInboundAcceptance'];
  logInboundSummary: (args: {
    accountId: string;
    route: BncrRoute;
    msgType: string;
    text: string;
    hasMedia: boolean;
  }) => void;
  flushPushQueueBestEffort: (args?: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }) => void;
  rememberSessionRoute: (sessionKey: string, accountId: string, route: BncrRoute) => void;
  enqueueFromReply: Parameters<typeof createBncrInboundHandlersComponent>[0]['enqueueFromReply'];
  setInboundActivity: (accountId: string, at: number) => void;
  scheduleSave: () => void;
  fileRecvTransfers: Parameters<
    typeof createBncrFileInboundHandlersComponent
  >[0]['fileRecvTransfers'];
  inboundFileTransferMaxBytes: number;
  inboundFileTransferMaxChunks: number;
}) {
  const fileInboundHandlers = createBncrFileInboundHandlersComponent({
    getApi: runtime.getApi,
    asString: runtime.asString,
    now: runtime.now,
    normalizeAccountId: runtime.normalizeAccountId,
    finiteNonNegativeNumberOrNull: runtime.finiteNonNegativeNumberOrNull,
    shouldIgnoreStaleEvent: runtime.shouldIgnoreStaleEvent,
    observeLease: runtime.observeLease,
    matchesTransferOwner: runtime.matchesTransferOwner,
    refreshAcceptedFileTransferLiveState: runtime.refreshAcceptedFileTransferLiveState,
    logWarn: runtime.logWarn,
    fileRecvTransfers: runtime.fileRecvTransfers,
    inboundFileTransferMaxBytes: runtime.inboundFileTransferMaxBytes,
    inboundFileTransferMaxChunks: runtime.inboundFileTransferMaxChunks,
  });

  const inboundHandlers = createBncrInboundHandlersComponent({
    getApi: runtime.getApi,
    channelId: runtime.channelId,
    bridgeId: runtime.bridgeId,
    pluginRoot: runtime.pluginRoot,
    asString: runtime.asString,
    now: runtime.now,
    syncDebugFlag: runtime.syncDebugFlag,
    shouldIgnoreStaleEvent: runtime.shouldIgnoreStaleEvent,
    buildInboundResponsePayload: runtime.buildInboundResponsePayload,
    refreshLiveConnectionState: runtime.refreshLiveConnectionState,
    logInfo: runtime.logInfo,
    logError: runtime.logError,
    buildInboundAcceptedLifecycleDebugInfo: runtime.buildInboundAcceptedLifecycleDebugInfo,
    isOnline: runtime.isOnline,
    hasRecentInboundReachability: runtime.hasRecentInboundReachability,
    getActiveConnectionKey: runtime.getActiveConnectionKey,
    buildActiveConnectionDebugList: runtime.buildActiveConnectionDebugList,
    markLastInboundAt: runtime.markLastInboundAt,
    ensureCanonicalAgentId: runtime.ensureCanonicalAgentId,
    prepareInboundAcceptance: runtime.prepareInboundAcceptance,
    logInboundSummary: runtime.logInboundSummary,
    flushPushQueueBestEffort: runtime.flushPushQueueBestEffort,
    rememberSessionRoute: runtime.rememberSessionRoute,
    enqueueFromReply: runtime.enqueueFromReply,
    setInboundActivity: runtime.setInboundActivity,
    scheduleSave: runtime.scheduleSave,
  });

  return {
    fileInboundHandlers,
    inboundHandlers,
  };
}
