import path from 'node:path';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { emitBncrLogLine } from '../core/logging.ts';
import { formatDisplayScope, normalizeStoredSessionKey, parseRouteLike } from '../core/targets.ts';
import type { BncrRoute } from '../core/types.ts';
import type { BncrInboundParamsInput } from '../messaging/inbound/contracts.ts';
import { dispatchBncrInbound } from '../messaging/inbound/dispatch.ts';
import type { BncrGroupHistoryMap } from '../messaging/inbound/group-history.ts';
import type { BncrOutboundReplayCache } from '../messaging/inbound/outbound-replay-cache.ts';
import { parseBncrInboundParams } from '../messaging/inbound/parse.ts';
import { OUTBOUND_FLUSH_REASON, OUTBOUND_FLUSH_TRIGGER } from '../messaging/outbound/reasons.ts';
import type { ReplyPayloadInput } from '../messaging/outbound/reply-enqueue.ts';
import { getOpenClawRuntimeConfig } from '../openclaw/config-runtime.ts';
import { saveOpenClawChannelMediaBuffer } from '../openclaw/media-runtime.ts';
import { createBncrConnectionHandlers } from './connection-handlers.ts';
import { createBncrDiagnosticsHandlers } from './diagnostics-handlers.ts';
import { createBncrFileInboundHandlers } from './file-inbound-handlers.ts';
import { createBncrInboundHandlers } from './inbound-handlers.ts';

export function createBncrConnectionHandlersComponent(
  runtime: Parameters<typeof createBncrConnectionHandlers>[0],
) {
  return createBncrConnectionHandlers(runtime);
}

export function createBncrBridgeDiagnosticsHandlersComponent(runtime: {
  getApi: () => OpenClawPluginApi;
  channelId: string;
  asString: (value: unknown, fallback?: string) => string;
  now: () => number;
  countInvalidOutboxSessionKeys: Parameters<
    typeof createBncrDiagnosticsHandlers
  >[0]['countInvalidOutboxSessionKeys'];
  countLegacyAccountResidue: Parameters<
    typeof createBncrDiagnosticsHandlers
  >[0]['countLegacyAccountResidue'];
  buildRuntimeStatusInput: Parameters<
    typeof createBncrDiagnosticsHandlers
  >[0]['buildRuntimeStatusInput'];
  getAccountRuntimeSnapshot: Parameters<
    typeof createBncrDiagnosticsHandlers
  >[0]['getAccountRuntimeSnapshot'];
  buildIntegratedDiagnostics: Parameters<
    typeof createBncrDiagnosticsHandlers
  >[0]['buildIntegratedDiagnostics'];
  buildExtendedDiagnostics: Parameters<
    typeof createBncrDiagnosticsHandlers
  >[0]['buildExtendedDiagnostics'];
  buildDownlinkHealth: Parameters<typeof createBncrDiagnosticsHandlers>[0]['buildDownlinkHealth'];
  buildRuntimeFlags: Parameters<typeof createBncrDiagnosticsHandlers>[0]['buildRuntimeFlags'];
  activeConnectionCount: Parameters<
    typeof createBncrDiagnosticsHandlers
  >[0]['activeConnectionCount'];
  getMessageAckWaiterCount: Parameters<
    typeof createBncrDiagnosticsHandlers
  >[0]['getMessageAckWaiterCount'];
  getFileAckWaiterCount: Parameters<
    typeof createBncrDiagnosticsHandlers
  >[0]['getFileAckWaiterCount'];
  filterDeadLetterEntries: Parameters<
    typeof createBncrDiagnosticsHandlers
  >[0]['filterDeadLetterEntries'];
  listDeadLetterEntries: Parameters<
    typeof createBncrDiagnosticsHandlers
  >[0]['listDeadLetterEntries'];
  buildDeadLetterDiagnostics: Parameters<
    typeof createBncrDiagnosticsHandlers
  >[0]['buildDeadLetterDiagnostics'];
  replaceDeadLetterEntries: Parameters<
    typeof createBncrDiagnosticsHandlers
  >[0]['replaceDeadLetterEntries'];
  scheduleSave: Parameters<typeof createBncrDiagnosticsHandlers>[0]['scheduleSave'];
  logDeadLetterSummary: Parameters<typeof createBncrDiagnosticsHandlers>[0]['logDeadLetterSummary'];
  pluginRoot: string;
}) {
  const buildDiagnosticsRuntimeStatusInput = (
    accountId: string,
    overrides: {
      running: boolean;
      invalidOutboxSessionKeys?: number;
      legacyAccountResidue?: number;
    },
  ) => ({
    ...runtime.buildRuntimeStatusInput(accountId, overrides),
    running: overrides.running,
    channelRoot: resolveBncrChannelRoot(runtime.pluginRoot),
  });

  return createBncrDiagnosticsHandlers({
    getApi: runtime.getApi,
    channelId: runtime.channelId,
    asString: runtime.asString,
    now: runtime.now,
    countInvalidOutboxSessionKeys: runtime.countInvalidOutboxSessionKeys,
    countLegacyAccountResidue: runtime.countLegacyAccountResidue,
    buildRuntimeStatusInput: buildDiagnosticsRuntimeStatusInput,
    getAccountRuntimeSnapshot: (accountId, runtimeStatusInput) =>
      runtime.getAccountRuntimeSnapshot(
        accountId,
        runtimeStatusInput || buildDiagnosticsRuntimeStatusInput(accountId, { running: true }),
      ),
    buildIntegratedDiagnostics: (accountId, runtimeStatusInput) =>
      runtime.buildIntegratedDiagnostics(
        accountId,
        runtimeStatusInput || buildDiagnosticsRuntimeStatusInput(accountId, { running: true }),
      ),
    buildExtendedDiagnostics: (accountId, args) =>
      runtime.buildExtendedDiagnostics(accountId, {
        runtimeStatusInput:
          args?.runtimeStatusInput ||
          buildDiagnosticsRuntimeStatusInput(accountId, { running: true }),
        integratedDiagnostics:
          args?.integratedDiagnostics ||
          runtime.buildIntegratedDiagnostics(
            accountId,
            buildDiagnosticsRuntimeStatusInput(accountId, { running: true }),
          ),
      }),
    buildDownlinkHealth: runtime.buildDownlinkHealth,
    buildRuntimeFlags: runtime.buildRuntimeFlags,
    activeConnectionCount: runtime.activeConnectionCount,
    getMessageAckWaiterCount: runtime.getMessageAckWaiterCount,
    getFileAckWaiterCount: runtime.getFileAckWaiterCount,
    filterDeadLetterEntries: runtime.filterDeadLetterEntries,
    listDeadLetterEntries: runtime.listDeadLetterEntries,
    buildDeadLetterDiagnostics: runtime.buildDeadLetterDiagnostics,
    replaceDeadLetterEntries: runtime.replaceDeadLetterEntries,
    scheduleSave: runtime.scheduleSave,
    logDeadLetterSummary: runtime.logDeadLetterSummary,
  });
}

export function createBncrFileInboundHandlersComponent(runtime: {
  getApi: () => OpenClawPluginApi;
  asString: (value: unknown, fallback?: string) => string;
  now: () => number;
  normalizeAccountId: (accountId: string) => string;
  finiteNonNegativeNumberOrNull: (value: unknown) => number | null;
  shouldIgnoreStaleEvent: Parameters<
    typeof createBncrFileInboundHandlers
  >[0]['shouldIgnoreStaleEvent'];
  observeLease: Parameters<typeof createBncrFileInboundHandlers>[0]['observeLease'];
  matchesTransferOwner: Parameters<typeof createBncrFileInboundHandlers>[0]['matchesTransferOwner'];
  refreshAcceptedFileTransferLiveState: Parameters<
    typeof createBncrFileInboundHandlers
  >[0]['refreshAcceptedFileTransferLiveState'];
  logWarn: Parameters<typeof createBncrFileInboundHandlers>[0]['logWarn'];
  buildCanonicalSessionKey: Parameters<
    typeof createBncrFileInboundHandlers
  >[0]['buildCanonicalSessionKey'];
  fileRecvTransfers: Parameters<typeof createBncrFileInboundHandlers>[0]['fileRecvTransfers'];
  inboundFileTransferMaxBytes: number;
  inboundFileTransferMaxChunks: number;
}) {
  return createBncrFileInboundHandlers({
    asString: runtime.asString,
    now: runtime.now,
    normalizeAccountId: runtime.normalizeAccountId,
    finiteNonNegativeNumberOrNull: runtime.finiteNonNegativeNumberOrNull,
    shouldIgnoreStaleEvent: runtime.shouldIgnoreStaleEvent,
    observeLease: runtime.observeLease,
    matchesTransferOwner: runtime.matchesTransferOwner,
    refreshAcceptedFileTransferLiveState: runtime.refreshAcceptedFileTransferLiveState,
    logWarn: runtime.logWarn,
    parseRouteLike,
    normalizeStoredSessionKey,
    buildCanonicalSessionKey: runtime.buildCanonicalSessionKey,
    saveInboundMediaBuffer: async ({ buffer, mimeType, fileName }) =>
      await saveOpenClawChannelMediaBuffer(
        runtime.getApi(),
        buffer,
        mimeType,
        'inbound',
        50 * 1024 * 1024,
        fileName,
      ),
    fileRecvTransfers: runtime.fileRecvTransfers,
    inboundFileTransferMaxBytes: runtime.inboundFileTransferMaxBytes,
    inboundFileTransferMaxChunks: runtime.inboundFileTransferMaxChunks,
  });
}

export function createBncrInboundHandlersComponent(runtime: {
  getApi: () => OpenClawPluginApi;
  channelId: string;
  bridgeId: string;
  pluginRoot: string;
  asString: (value: unknown, fallback?: string) => string;
  now: () => number;
  syncDebugFlag: () => Promise<void>;
  shouldIgnoreStaleEvent: Parameters<typeof createBncrInboundHandlers>[0]['shouldIgnoreStaleEvent'];
  buildInboundResponsePayload: Parameters<
    typeof createBncrInboundHandlers
  >[0]['buildInboundResponsePayload'];
  refreshLiveConnectionState: Parameters<
    typeof createBncrInboundHandlers
  >[0]['refreshLiveConnectionState'];
  logInfo: Parameters<typeof createBncrInboundHandlers>[0]['logInfo'];
  logError: Parameters<typeof createBncrInboundHandlers>[0]['logError'];
  buildInboundAcceptedLifecycleDebugInfo: Parameters<
    typeof createBncrInboundHandlers
  >[0]['buildInboundAcceptedLifecycleDebugInfo'];
  isOnline: (accountId: string) => boolean;
  hasRecentInboundReachability: (accountId: string) => boolean;
  getActiveConnectionKey: (accountId: string) => string | null;
  buildActiveConnectionDebugList: Parameters<
    typeof createBncrInboundHandlers
  >[0]['buildActiveConnectionDebugList'];
  markLastInboundAt: (accountId: string) => void;
  ensureCanonicalAgentId: Parameters<typeof createBncrInboundHandlers>[0]['ensureCanonicalAgentId'];
  defaultAdminAgentId: Parameters<typeof createBncrInboundHandlers>[0]['defaultAdminAgentId'];
  defaultPublicAgentId: Parameters<typeof createBncrInboundHandlers>[0]['defaultPublicAgentId'];
  sceneRegistry: Parameters<typeof createBncrInboundHandlers>[0]['sceneRegistry'];
  groupHistories: BncrGroupHistoryMap;
  outboundReplayCache: BncrOutboundReplayCache;
  prepareInboundAcceptance: Parameters<
    typeof createBncrInboundHandlers
  >[0]['prepareInboundAcceptance'];
  logInboundSummary: Parameters<typeof createBncrInboundHandlers>[0]['logInboundSummary'];
  flushPushQueueBestEffort: (args: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }) => void;
  rememberSessionRoute: (sessionKey: string, accountId: string, route: BncrRoute) => void;
  enqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: ReplyPayloadInput;
    mediaLocalRoots?: readonly string[];
  }) => Promise<void>;
  setInboundActivity: (accountId: string, at: number) => void;
  scheduleSave: () => void;
}) {
  return createBncrInboundHandlers({
    channelId: runtime.channelId,
    bridgeId: runtime.bridgeId,
    asString: runtime.asString,
    now: runtime.now,
    syncDebugFlag: runtime.syncDebugFlag,
    parseInboundParams: (params: unknown) =>
      parseBncrInboundParams(params as BncrInboundParamsInput),
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
    getConfig: () => getOpenClawRuntimeConfig(runtime.getApi()),
    ensureCanonicalAgentId: runtime.ensureCanonicalAgentId,
    defaultAdminAgentId: runtime.defaultAdminAgentId,
    defaultPublicAgentId: runtime.defaultPublicAgentId,
    sceneRegistry: runtime.sceneRegistry,
    groupHistories: runtime.groupHistories,
    outboundReplayCache: runtime.outboundReplayCache,
    prepareInboundAcceptance: runtime.prepareInboundAcceptance,
    formatDisplayScope,
    logInboundSummary: runtime.logInboundSummary,
    enqueueFromReply: runtime.enqueueFromReply,
    flushOnInboundAccepted: (accountId) =>
      runtime.flushPushQueueBestEffort({
        accountId,
        trigger: OUTBOUND_FLUSH_TRIGGER.INBOUND,
        reason: OUTBOUND_FLUSH_REASON.INBOUND_ACCEPTED,
      }),
    dispatchInbound: ({
      cfg,
      parsed,
      canonicalAgentId,
      resolvedAgentId,
      shouldDispatch,
      shouldAccumulate,
      sceneRegistry,
      groupHistories,
      outboundReplayCache,
      defaultAdminAgentId,
      defaultPublicAgentId,
      now,
    }) =>
      dispatchBncrInbound({
        api: runtime.getApi(),
        channelId: runtime.channelId,
        cfg,
        parsed,
        canonicalAgentId,
        resolvedAgentId,
        shouldDispatch,
        shouldAccumulate,
        sceneRegistry,
        groupHistories,
        outboundReplayCache,
        defaultAdminAgentId,
        defaultPublicAgentId,
        now,
        rememberSessionRoute: runtime.rememberSessionRoute,
        enqueueFromReply: runtime.enqueueFromReply,
        setInboundActivity: runtime.setInboundActivity,
        scheduleSave: runtime.scheduleSave,
        logger: {
          warn: (msg: string) => emitBncrLogLine('warn', msg),
          error: (msg: string) => emitBncrLogLine('error', msg),
        },
      }),
  });
}

export function resolveBncrChannelRoot(pluginRoot: string) {
  return pluginRoot || path.join(process.cwd(), 'plugins', 'bncr');
}
