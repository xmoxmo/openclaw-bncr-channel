import type { BncrRoute, OutboxEntry } from '../core/types.ts';
import {
  buildOutboxAckDebugInfo,
  buildOutboxScheduleDebugInfo,
  buildRetryRerouteDebugInfo,
} from '../messaging/outbound/diagnostics.ts';
import { computeOutboxRetryWait } from '../messaging/outbound/queue-selectors.ts';
import { OUTBOUND_SCHEDULE_SOURCE } from '../messaging/outbound/reasons.ts';
import type { RetryRerouteDecision } from '../messaging/outbound/retry-policy.ts';

export type BncrOutboxAckLogsRuntime = {
  bridgeId: string;
  pushEvent: string;
  now: () => number;
  outboxSize: () => number;
  adaptiveAckTimeoutEnabled: boolean;
  formatDisplayScope: (route: BncrRoute) => string;
  isFileTransferEntry: (entry: OutboxEntry) => boolean;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
};

export function createBncrOutboxAckLogs(runtime: BncrOutboxAckLogsRuntime) {
  const logOutboxAckSummary = (
    scope:
      | 'outbox ack ok'
      | 'outbox ack ok late'
      | 'outbox ack retry'
      | 'outbox ack timeout'
      | 'outbox ack fatal',
    args: {
      messageId: string;
      connId?: string;
      clientId?: string;
      err?: string;
      queueMs?: number | null;
      pushMs?: number | null;
      waitMs?: number | null;
    },
  ) => {
    const parts = [`mid=${args.messageId}`, `q=${runtime.outboxSize()}`];
    if (typeof args.queueMs === 'number') parts.push(`queueMs=${args.queueMs}`);
    if (typeof args.pushMs === 'number') parts.push(`pushMs=${args.pushMs}`);
    if (typeof args.waitMs === 'number') parts.push(`waitMs=${args.waitMs}`);
    if (args.err) parts.push(`err=${args.err}`);
    runtime.logInfo(scope, parts.join('|'));
  };

  const logOutboxAckWait = (args: {
    entry: OutboxEntry;
    requireAck: boolean;
    ackResult: 'acked' | 'timeout';
    onlineNow: boolean;
    recentInboundReachable: boolean;
    ackTimeoutMs?: number | null;
  }) => {
    runtime.logInfo(
      'outbox',
      `ack ${JSON.stringify(
        buildOutboxAckDebugInfo({
          messageId: args.entry.messageId,
          accountId: args.entry.accountId,
          sessionKey: args.entry.sessionKey,
          to: runtime.formatDisplayScope(args.entry.route),
          kind: runtime.isFileTransferEntry(args.entry) ? 'file-transfer' : undefined,
          requireAck: args.requireAck,
          ackResult: args.ackResult,
          ackStage: 'message',
          ackOutcome: args.ackResult,
          reason: args.ackResult === 'timeout' ? 'push-ack-timeout' : 'message-acked',
          ackTimeoutMs: typeof args.ackTimeoutMs === 'number' ? args.ackTimeoutMs : undefined,
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

  const logOutboxAckReroute = (args: {
    accountId: string;
    entry: OutboxEntry;
    requireAck: boolean;
    currentConnId: string;
    availableConnIds: string[];
    decision: Extract<RetryRerouteDecision, { kind: 'retry' }>;
    localNextDelay: number | null;
    ackTimeoutMs?: number | null;
  }) => {
    logOutboxAckSummary(args.requireAck ? 'outbox ack timeout' : 'outbox ack retry', {
      messageId: args.entry.messageId,
      connId: args.entry.lastPushConnId,
      clientId: args.entry.lastPushClientId,
      err: args.requireAck ? undefined : args.entry.lastError,
      waitMs: args.requireAck ? args.ackTimeoutMs : undefined,
    });
    runtime.logInfo(
      'outbox',
      `retry-reroute ${JSON.stringify(
        buildRetryRerouteDebugInfo({
          messageId: args.entry.messageId,
          accountId: args.accountId,
          currentConnId: args.currentConnId,
          decision: args.decision,
          availableConnIds: args.availableConnIds,
        }),
      )}`,
      { debugOnly: true },
    );

    runtime.logInfo(
      'outbox',
      `schedule ${JSON.stringify(
        buildOutboxScheduleDebugInfo({
          bridgeId: runtime.bridgeId,
          accountId: args.accountId,
          messageId: args.entry.messageId,
          source: OUTBOUND_SCHEDULE_SOURCE.RETRY_REROUTE_WAIT,
          wait: computeOutboxRetryWait(args.decision.nextAttemptAt, runtime.now()),
          localNextDelay: args.localNextDelay,
        }),
      )}`,
      { debugOnly: true },
    );
  };

  return {
    logOutboxAckSummary,
    logOutboxAckWait,
    logOutboxAckReroute,
  };
}
