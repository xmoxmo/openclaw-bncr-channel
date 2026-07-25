import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { OutboxEntry } from '../core/types.ts';
import { createBncrMessageAckRuntime } from './message-ack-runtime.ts';
import { createBncrOutboxAckLogs } from './outbox-ack-logs.ts';
import {
  type BncrOutboxAckOkTelemetryPatch,
  createBncrOutboxAckOutcome,
} from './outbox-ack-outcome.ts';
import { createBncrOutboxDrainAck } from './outbox-drain-ack.ts';
import { createBncrOutboxDrainRuntime } from './outbox-drain-runtime.ts';
import { createBncrOutboxDrainSchedule } from './outbox-drain-schedule.ts';

export function createBncrAckOutboxRuntimeGroup(runtime: {
  bridgeId: string;
  pushEvent: string;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  backoffMs: (retryCount: number) => number;
  isPlainObject: (value: unknown) => value is Record<string, unknown>;
  clampFiniteNumber: (value: unknown, fallback: number, min?: number, max?: number) => number;
  normalizeAccountId: (accountId: string) => string;
  resolveAccountIdForSession: (sessionKey: string) => string | null;
  resolveActiveAccountIds?: () => Iterable<string>;
  formatDisplayScope: (route: OutboxEntry['route']) => string;
  isFileTransferEntry: (entry: OutboxEntry) => boolean;
  recommendedAckTimeoutMaxMs: number;
  adaptiveAckTimeoutEnabled: boolean;
  defaultAckTimeoutMs: number;
  stopped: () => boolean;
  outbox: Map<string, OutboxEntry>;
  deadLetter: () => OutboxEntry[];
  connectionsValues: () => IterableIterator<{
    accountId: string;
    connId: string;
    clientId?: string;
    connectedAt: number;
    lastSeenAt: number;
    inboundOnly?: boolean;
    outboundReady?: boolean;
    preferredForOutbound?: boolean;
    outboundReadyUntil?: number;
    preferredForOutboundUntil?: number;
    lastAckOkAt?: number;
    lastPushTimeoutAt?: number;
    pushFailureScore?: number;
  }>;
  gatewayContextAvailable: () => boolean;
  messageAckWaiters: Map<
    string,
    {
      promise: Promise<'acked' | 'timeout'>;
      resolve: (result: 'acked' | 'timeout') => void;
      timer: NodeJS.Timeout;
    }
  >;
  fileAckWaiterCount: () => number;
  activeConnectionCount: (accountId: string) => number;
  getAccountPendingOutboxEntries: (accountId: string) => OutboxEntry[];
  pushDrainRunningAccounts: Set<string>;
  pushDrainRunningSinceByAccount: Map<string, number>;
  pushDrainStuckWarnedAtByAccount: Map<string, number>;
  isOnline: (accountId: string) => boolean;
  hasRecentInboundReachability: (accountId: string) => boolean;
  isOutboundAckRequired: (accountId?: string) => boolean;
  resolveMessageAckTimeoutMs: (accountId: string) => number;
  waitForMessageAck: (messageId: string, waitMs: number) => Promise<'acked' | 'timeout'>;
  resolvePushConnIds: (accountId: string) => Iterable<string>;
  sleepMs: (ms: number) => Promise<void>;
  schedulePushDrain: (delayMs: number) => void;
  tryPushEntry: (entry: OutboxEntry) => Promise<boolean>;
  handleFileTransferPushFailure: (args: { entry: OutboxEntry; error: unknown }) => void;
  handleTextPushFailure: (args: { entry: OutboxEntry; error: unknown }) => void;
  isPrePushGuardDeferral: (entry: OutboxEntry) => boolean;
  scheduleSave: () => void;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logError: (scope: string, message: string) => void;
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
    payload: Record<string, unknown>,
  ) => { stale: boolean };
  rememberGatewayContext: (context: GatewayRequestHandlerOptions['context']) => void;
  markSeen: (accountId: string, connId: string, clientId?: string) => void;
  markOutboundCapability: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    outboundReady: boolean;
    preferredForOutbound: boolean;
  }) => void;
  recordAckOkTelemetry: (args: {
    accountId: string;
    entry: OutboxEntry;
    telemetryPatch: BncrOutboxAckOkTelemetryPatch;
  }) => void;
  deleteOutboxEntry: (messageId: string) => void;
  setOutboxEntry: (messageId: string, entry: OutboxEntry) => void;
  resolveMessageAck: (messageId: string, result: 'acked' | 'timeout') => boolean;
  moveToDeadLetter: (entry: OutboxEntry, reason: string) => void;
  recordAckTimeoutTelemetry: (accountId: string) => void;
  degradeOutboundCapability: (args: {
    accountId: string;
    connId?: string;
    clientId?: string;
    reason: string;
  }) => void;
  flushPushQueueBestEffort: (args?: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }) => void;
  flushTriggerTimer: string;
  flushReasonScheduledDrain: string;
  outboundFlushTriggerAckOk: string;
  outboundFlushReasonMessageAcked: string;
  pushDrainExceptionRetryLimit: number;
  pushDrainExceptionRetryDelayMs: number;
  pushDrainStuckWarnMs: number;
  pushDrainIntervalMs: number;
  pushDrainAccountTimeBudgetMs: number;
  pushDrainAccountBudget: number;
  pushAckTimeoutMs: number;
  maxRetry: number;
  prePushGuardRetryDelayMs: number;
}) {
  const outboxAckLogs = createBncrOutboxAckLogs({
    bridgeId: runtime.bridgeId,
    pushEvent: runtime.pushEvent,
    now: runtime.now,
    outboxSize: () => runtime.outbox.size,
    adaptiveAckTimeoutEnabled: runtime.adaptiveAckTimeoutEnabled,
    formatDisplayScope: runtime.formatDisplayScope,
    isFileTransferEntry: runtime.isFileTransferEntry,
    logInfo: runtime.logInfo,
  });

  const outboxAckOutcome = createBncrOutboxAckOutcome({
    now: runtime.now,
    defaultAckTimeoutMs: runtime.defaultAckTimeoutMs,
    markOutboundCapability: runtime.markOutboundCapability,
    recordAckOkTelemetry: runtime.recordAckOkTelemetry,
    deleteOutboxEntry: runtime.deleteOutboxEntry,
    setOutboxEntry: runtime.setOutboxEntry,
    scheduleSave: runtime.scheduleSave,
    resolveMessageAck: (messageId, result) => {
      runtime.resolveMessageAck(messageId, result);
    },
    moveToDeadLetter: runtime.moveToDeadLetter,
    logOutboxAckSummary: outboxAckLogs.logOutboxAckSummary,
  });

  const messageAckRuntime = createBncrMessageAckRuntime({
    asString: runtime.asString,
    now: runtime.now,
    clampFiniteNumber: (value, fallback, min, max) =>
      runtime.clampFiniteNumber(value, fallback, min ?? fallback, max ?? fallback),
    normalizeAccountId: runtime.normalizeAccountId,
    recommendedAckTimeoutMaxMs: runtime.recommendedAckTimeoutMaxMs,
    messageAckWaiters: runtime.messageAckWaiters,
    stopped: runtime.stopped,
    outbox: runtime.outbox,
    observeLease: runtime.observeLease,
    rememberGatewayContext: runtime.rememberGatewayContext,
    markSeen: runtime.markSeen,
    logInfo: runtime.logInfo,
    logWarn: runtime.logWarn,
    handleAckOk: outboxAckOutcome.handleAckOk,
    handleAckFatal: outboxAckOutcome.handleAckFatal,
    handleAckRetry: outboxAckOutcome.handleAckRetry,
    flushPushQueueBestEffort: runtime.flushPushQueueBestEffort,
    outboundFlushTriggerAckOk: runtime.outboundFlushTriggerAckOk,
    outboundFlushReasonMessageAcked: runtime.outboundFlushReasonMessageAcked,
  });

  const outboxDrainAck = createBncrOutboxDrainAck({
    bridgeId: runtime.bridgeId,
    pushEvent: runtime.pushEvent,
    now: runtime.now,
    defaultAckTimeoutMs: runtime.defaultAckTimeoutMs,
    adaptiveAckTimeoutEnabled: runtime.adaptiveAckTimeoutEnabled,
    outboxSize: () => runtime.outbox.size,
    formatDisplayScope: runtime.formatDisplayScope,
    isFileTransferEntry: runtime.isFileTransferEntry,
    setOutboxEntry: runtime.setOutboxEntry,
    scheduleSave: runtime.scheduleSave,
    moveToDeadLetter: runtime.moveToDeadLetter,
    recordAckTimeoutTelemetry: runtime.recordAckTimeoutTelemetry,
    logInfo: runtime.logInfo,
    logOutboxAckReroute: outboxAckLogs.logOutboxAckReroute,
  });

  const outboxDrainSchedule = createBncrOutboxDrainSchedule({
    bridgeId: runtime.bridgeId,
    logInfo: runtime.logInfo,
  });

  const outboxDrainRuntime = createBncrOutboxDrainRuntime({
    bridgeId: runtime.bridgeId,
    now: runtime.now,
    asString: runtime.asString,
    backoffMs: runtime.backoffMs,
    isPlainObject: runtime.isPlainObject,
    normalizeAccountId: runtime.normalizeAccountId,
    stopped: runtime.stopped,
    outbox: runtime.outbox,
    deadLetter: runtime.deadLetter,
    connectionsValues: runtime.connectionsValues,
    gatewayContextAvailable: runtime.gatewayContextAvailable,
    messageAckWaiterCount: () => runtime.messageAckWaiters.size,
    fileAckWaiterCount: runtime.fileAckWaiterCount,
    activeConnectionCount: runtime.activeConnectionCount,
    getAccountPendingOutboxEntries: runtime.getAccountPendingOutboxEntries,
    pushDrainRunningAccounts: runtime.pushDrainRunningAccounts,
    pushDrainRunningSinceByAccount: runtime.pushDrainRunningSinceByAccount,
    pushDrainStuckWarnedAtByAccount: runtime.pushDrainStuckWarnedAtByAccount,
    isOnline: runtime.isOnline,
    hasRecentInboundReachability: runtime.hasRecentInboundReachability,
    isOutboundAckRequired: runtime.isOutboundAckRequired,
    resolveMessageAckTimeoutMs: runtime.resolveMessageAckTimeoutMs,
    waitForMessageAck: runtime.waitForMessageAck,
    logOutboxAckWait: outboxAckLogs.logOutboxAckWait,
    degradeOutboundCapability: runtime.degradeOutboundCapability,
    resolvePushConnIds: runtime.resolvePushConnIds,
    sleepMs: runtime.sleepMs,
    schedulePushDrain: runtime.schedulePushDrain,
    outboxDrainSchedule,
    outboxDrainAck,
    tryPushEntry: runtime.tryPushEntry,
    handleFileTransferPushFailure: runtime.handleFileTransferPushFailure,
    handleTextPushFailure: runtime.handleTextPushFailure,
    isPrePushGuardDeferral: runtime.isPrePushGuardDeferral,
    resolveAccountIdForSession: runtime.resolveAccountIdForSession,
    resolveActiveAccountIds: runtime.resolveActiveAccountIds,
    moveToDeadLetter: runtime.moveToDeadLetter,
    scheduleSave: runtime.scheduleSave,
    logInfo: runtime.logInfo,
    logWarn: runtime.logWarn,
    logError: runtime.logError,
    flushTriggerTimer: runtime.flushTriggerTimer,
    flushReasonScheduledDrain: runtime.flushReasonScheduledDrain,
    pushDrainExceptionRetryLimit: runtime.pushDrainExceptionRetryLimit,
    pushDrainExceptionRetryDelayMs: runtime.pushDrainExceptionRetryDelayMs,
    pushDrainStuckWarnMs: runtime.pushDrainStuckWarnMs,
    pushDrainIntervalMs: runtime.pushDrainIntervalMs,
    pushDrainAccountTimeBudgetMs: runtime.pushDrainAccountTimeBudgetMs,
    pushDrainAccountBudget: runtime.pushDrainAccountBudget,
    pushAckTimeoutMs: runtime.pushAckTimeoutMs,
    maxRetry: runtime.maxRetry,
    prePushGuardRetryDelayMs: runtime.prePushGuardRetryDelayMs,
  });

  return {
    outboxAckLogs,
    outboxAckOutcome,
    messageAckRuntime,
    outboxDrainAck,
    outboxDrainSchedule,
    outboxDrainRuntime,
  };
}
