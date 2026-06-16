import type { BncrRoute, OutboxEntry } from '../core/types.ts';
import {
  buildOutboxAckDebugInfo,
  buildOutboxScheduleDebugInfo,
} from '../messaging/outbound/diagnostics.ts';
import { computeOutboxRetryWait } from '../messaging/outbound/queue-selectors.ts';
import {
  OUTBOUND_SCHEDULE_SOURCE,
  type OutboundScheduleSource,
} from '../messaging/outbound/reasons.ts';
import type { RetryRerouteDecision } from '../messaging/outbound/retry-policy.ts';
import { applyBncrRetryRerouteDecisionToEntry } from '../runtime/outbox-transitions.ts';

export type BncrOutboxDrainAckRuntime = {
  bridgeId: string;
  pushEvent: string;
  now: () => number;
  defaultAckTimeoutMs: number;
  adaptiveAckTimeoutEnabled: boolean;
  outboxSize: () => number;
  formatDisplayScope: (route: BncrRoute) => string;
  isFileTransferEntry: (entry: OutboxEntry) => boolean;
  setOutboxEntry: (messageId: string, entry: OutboxEntry) => void;
  scheduleSave: () => void;
  moveToDeadLetter: (entry: OutboxEntry, reason: string) => void;
  recordAckTimeoutTelemetry: (accountId: string) => void;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logOutboxAckReroute: (args: {
    accountId: string;
    entry: OutboxEntry;
    requireAck: boolean;
    currentConnId: string;
    availableConnIds: string[];
    decision: Extract<RetryRerouteDecision, { kind: 'retry' }>;
    localNextDelay: number | null;
    ackTimeoutMs?: number | null;
  }) => void;
};

export function createBncrOutboxDrainAck(runtime: BncrOutboxDrainAckRuntime) {
  const logAckWaitStart = (args: {
    entry: OutboxEntry;
    requireAck: boolean;
    ackTimeoutMs?: number | null;
    onlineNow: boolean;
    recentInboundReachable: boolean;
  }) => {
    runtime.logInfo(
      'outbox',
      `ack wait-start ${JSON.stringify(
        buildOutboxAckDebugInfo({
          messageId: args.entry.messageId,
          accountId: args.entry.accountId,
          sessionKey: args.entry.sessionKey,
          to: runtime.formatDisplayScope(args.entry.route),
          kind: runtime.isFileTransferEntry(args.entry) ? 'file-transfer' : undefined,
          requireAck: args.requireAck,
          ackResult: 'timeout',
          ackStage: 'message',
          ackOutcome: 'waiting',
          ackTimeoutMs: args.ackTimeoutMs || runtime.defaultAckTimeoutMs,
          adaptiveAckTimeoutEnabled: runtime.adaptiveAckTimeoutEnabled,
          onlineNow: args.onlineNow,
          recentInboundReachable: args.recentInboundReachable,
          connIds: args.entry.lastPushConnId ? [args.entry.lastPushConnId] : [],
          ownerConnId: args.entry.lastPushConnId,
          ownerClientId: args.entry.lastPushClientId,
          event: runtime.pushEvent,
        }),
      )}`,
      { debugOnly: true },
    );
  };

  const handleAckTimeoutReroute = (args: {
    accountId: string;
    entry: OutboxEntry;
    requireAck: boolean;
    currentConnId: string;
    availableConnIds: string[];
    decision:
      | { kind: 'dead-letter'; terminalReason: string; [key: string]: unknown }
      | Extract<RetryRerouteDecision, { kind: 'retry' }>;
    localNextDelay: number | null;
    ackTimeoutMs?: number | null;
    updateMinOutboxDelay: (current: number | null, next: number | null) => number | null;
  }) => {
    if (args.decision.kind === 'dead-letter') {
      runtime.logInfo(
        'outbox ack fatal',
        `mid=${args.entry.messageId}|q=${runtime.outboxSize()}|err=${args.decision.terminalReason}`,
      );
      runtime.moveToDeadLetter(args.entry, args.decision.terminalReason);
      return { kind: 'dead-letter' as const, localNextDelay: args.localNextDelay };
    }

    const nextEntry = applyBncrRetryRerouteDecisionToEntry(args.entry, args.decision);
    runtime.setOutboxEntry(args.entry.messageId, nextEntry);
    runtime.scheduleSave();
    if (args.requireAck) runtime.recordAckTimeoutTelemetry(args.accountId);
    const wait = computeOutboxRetryWait(args.decision.nextAttemptAt, runtime.now());
    const localNextDelay = args.updateMinOutboxDelay(args.localNextDelay, wait);
    runtime.logOutboxAckReroute({
      accountId: args.accountId,
      entry: nextEntry,
      requireAck: args.requireAck,
      currentConnId: args.currentConnId,
      availableConnIds: args.availableConnIds,
      decision: args.decision,
      localNextDelay,
      ackTimeoutMs: args.ackTimeoutMs,
    });
    return { kind: 'retry' as const, nextEntry, wait, localNextDelay };
  };

  const logSchedule = (args: {
    accountId: string;
    messageId: string;
    wait: number;
    localNextDelay: number | null;
    source: OutboundScheduleSource;
  }) => {
    runtime.logInfo(
      'outbox',
      `schedule ${JSON.stringify(
        buildOutboxScheduleDebugInfo({
          bridgeId: runtime.bridgeId,
          accountId: args.accountId,
          messageId: args.messageId,
          source: args.source,
          wait: args.wait,
          localNextDelay: args.localNextDelay,
        }),
      )}`,
      { debugOnly: true },
    );
  };

  return {
    logAckWaitStart,
    handleAckTimeoutReroute,
    logSchedule,
    scheduleSource: OUTBOUND_SCHEDULE_SOURCE,
  };
}
