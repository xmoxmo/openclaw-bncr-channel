import type { OutboxEntry } from '../core/types.ts';
import {
  buildBncrAckOkTelemetryPatch,
  buildBncrAckRetryEntryPatch,
} from '../runtime/outbox-transitions.ts';

export type BncrOutboxAckOkTelemetryPatch = ReturnType<typeof buildBncrAckOkTelemetryPatch>;

export type BncrOutboxAckOutcomeRuntime = {
  now: () => number;
  defaultAckTimeoutMs: number;
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
  scheduleSave: () => void;
  resolveMessageAck: (messageId: string, result: 'acked' | 'timeout') => void;
  moveToDeadLetter: (entry: OutboxEntry, reason: string) => void;
  logOutboxAckSummary: (
    scope: 'outbox ack ok' | 'outbox ack ok late' | 'outbox ack retry' | 'outbox ack fatal',
    args: {
      messageId: string;
      connId?: string;
      clientId?: string;
      err?: string;
      queueMs?: number | null;
      pushMs?: number | null;
      waitMs?: number | null;
    },
  ) => void;
};

export function createBncrOutboxAckOutcome(runtime: BncrOutboxAckOutcomeRuntime) {
  const handleAckOk = (args: {
    accountId: string;
    messageId: string;
    connId: string;
    clientId?: string;
    stale: boolean;
    entry: OutboxEntry;
  }) => {
    runtime.markOutboundCapability({
      accountId: args.accountId,
      connId: args.connId,
      clientId: args.clientId,
      outboundReady: true,
      preferredForOutbound: true,
    });
    const telemetryPatch = buildBncrAckOkTelemetryPatch({
      entry: args.entry,
      ackAt: runtime.now(),
      defaultAckTimeoutMs: runtime.defaultAckTimeoutMs,
    });
    runtime.recordAckOkTelemetry({
      accountId: args.accountId,
      entry: args.entry,
      telemetryPatch,
    });
    runtime.deleteOutboxEntry(args.messageId);
    runtime.scheduleSave();
    runtime.resolveMessageAck(args.messageId, 'acked');
    runtime.logOutboxAckSummary(
      telemetryPatch.lateAccepted ? 'outbox ack ok late' : 'outbox ack ok',
      {
        messageId: args.messageId,
        connId: args.connId,
        clientId: args.clientId,
        queueMs: telemetryPatch.ackQueueLatencyMs,
        pushMs: telemetryPatch.ackPushLatencyMs,
        err: telemetryPatch.lateAccepted ? 'accepted-after-timeout' : undefined,
      },
    );
  };

  const handleAckFatal = (args: {
    entry: OutboxEntry;
    messageId: string;
    connId: string;
    clientId?: string;
    error: string;
  }) => {
    runtime.moveToDeadLetter(args.entry, args.error);
    runtime.logOutboxAckSummary('outbox ack fatal', {
      messageId: args.messageId,
      connId: args.connId,
      clientId: args.clientId,
      err: args.error,
    });
  };

  const handleAckRetry = (args: {
    entry: OutboxEntry;
    messageId: string;
    connId: string;
    clientId?: string;
    error: string;
  }) => {
    const nextEntry = buildBncrAckRetryEntryPatch({
      entry: args.entry,
      error: args.error,
      nextAttemptAt: runtime.now() + 1_000,
    });
    runtime.setOutboxEntry(args.messageId, nextEntry);
    runtime.scheduleSave();
    runtime.logOutboxAckSummary('outbox ack retry', {
      messageId: args.messageId,
      connId: args.connId,
      clientId: args.clientId,
      err: nextEntry.lastError,
    });
  };

  return {
    handleAckOk,
    handleAckFatal,
    handleAckRetry,
  };
}
