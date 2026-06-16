import type { BncrAckObservability, BncrAckStrategy } from '../core/types.ts';
import {
  buildBncrRuntimeAckStrategy,
  resolveBncrRuntimeAckTimeoutDecision,
} from '../runtime/outbound-ack-timeout.ts';
import type { createBncrFileAckRuntime } from './file-ack-runtime.ts';

type FileAckRuntime = ReturnType<typeof createBncrFileAckRuntime>;
type FileAckWaitParams = Parameters<FileAckRuntime['waitForFileAck']>[0];
type FileAckWaitResult = Awaited<ReturnType<FileAckRuntime['waitForFileAck']>>;

export function createBncrBridgeAckFacade(runtime: {
  normalizeAccountId: (accountId: string) => string;
  now: () => number;
  pushAckTimeoutMs: number;
  adaptiveAckTimeoutDefaultEnabled: boolean;
  adaptiveAckTimeoutLogThrottleMs: number;
  adaptiveAckTimeoutObservationTtlMs: number;
  adaptiveAckTimeoutRecoveryOkThreshold: number;
  recommendedAckTimeoutMinMs: number;
  recommendedAckTimeoutMaxMs: number;
  getCounter: (map: Map<string, number>, accountId: string) => number;
  ackTimeoutCountByAccount: Map<string, number>;
  lateAckOkCountByAccount: Map<string, number>;
  lastLateAckPushLatencyMsByAccount: Map<string, number>;
  lastLateAckOkByAccount: Map<string, number>;
  adaptiveAckRecoveryOkCountByAccount: Map<string, number>;
  adaptiveAckTimeoutLogStateByAccount: Map<
    string,
    { at: number; timeoutMs: number; reason: string }
  >;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  buildRuntimeAckObservability: (accountId: string) => BncrAckObservability;
  buildRuntimeAckStrategy?: (ackObservability: BncrAckObservability) => unknown;
  waitForMessageAck: (messageId: string, waitMs: number) => Promise<'acked' | 'timeout'>;
  resolveMessageAck: (messageId: string, result?: 'acked' | 'timeout') => boolean;
  fileAckKey: (transferId: string, stage: string, chunkIndex?: number) => string;
  waitForFileAck: (params: FileAckWaitParams) => Promise<FileAckWaitResult>;
  resolveFileAck: (params: {
    transferId: string;
    stage: string;
    chunkIndex?: number;
    payload: Record<string, unknown>;
    ok: boolean;
  }) => boolean;
}) {
  const maybeLogAdaptiveAckTimeout = (args: {
    accountId: string;
    timeoutMs: number;
    reason: string;
    lastLateAckPushLatencyMs: number | null;
    nowMs?: number;
  }) => {
    if (args.timeoutMs <= runtime.pushAckTimeoutMs) return;
    const t = typeof args.nowMs === 'number' ? args.nowMs : runtime.now();
    const previous = runtime.adaptiveAckTimeoutLogStateByAccount.get(args.accountId);
    if (
      previous &&
      previous.timeoutMs === args.timeoutMs &&
      previous.reason === args.reason &&
      t - previous.at < runtime.adaptiveAckTimeoutLogThrottleMs
    ) {
      return;
    }
    runtime.adaptiveAckTimeoutLogStateByAccount.set(args.accountId, {
      at: t,
      timeoutMs: args.timeoutMs,
      reason: args.reason,
    });
    const parts = [
      args.accountId,
      `current=${args.timeoutMs}`,
      `default=${runtime.pushAckTimeoutMs}`,
      `reason=${args.reason}`,
    ];
    if (typeof args.lastLateAckPushLatencyMs === 'number')
      parts.push(`latePushMs=${args.lastLateAckPushLatencyMs}`);
    runtime.logInfo('outbox ack timeout-adaptive', parts.join('|'));
  };

  const resolveMessageAckTimeoutMs = (accountId?: string) => {
    if (!runtime.adaptiveAckTimeoutDefaultEnabled) return runtime.pushAckTimeoutMs;
    const acc = runtime.normalizeAccountId(accountId || 'default');
    const lateAckOkCount = runtime.getCounter(runtime.lateAckOkCountByAccount, acc);
    const recentAckTimeoutCount = runtime.getCounter(runtime.ackTimeoutCountByAccount, acc);
    const lastLateAckPushLatencyMs = runtime.lastLateAckPushLatencyMsByAccount.get(acc) || null;
    const lastLateAckOkAt = runtime.lastLateAckOkByAccount.get(acc) || null;
    const adaptiveAckRecoveryOkCount = runtime.getCounter(
      runtime.adaptiveAckRecoveryOkCountByAccount,
      acc,
    );
    const nowMs = runtime.now();
    const { timeoutMs, reason } = resolveBncrRuntimeAckTimeoutDecision({
      lateAckOkCount,
      recentAckTimeoutCount,
      lastLateAckPushLatencyMs,
      lastLateAckOkAt,
      adaptiveAckRecoveryOkCount,
      nowMs,
      defaultAckTimeoutMs: runtime.pushAckTimeoutMs,
      minAckTimeoutMs: runtime.recommendedAckTimeoutMinMs,
      maxAckTimeoutMs: runtime.recommendedAckTimeoutMaxMs,
      lateAckObservationTtlMs: runtime.adaptiveAckTimeoutObservationTtlMs,
      recoveryOkThreshold: runtime.adaptiveAckTimeoutRecoveryOkThreshold,
    });
    maybeLogAdaptiveAckTimeout({
      accountId: acc,
      timeoutMs,
      reason,
      lastLateAckPushLatencyMs,
      nowMs,
    });
    return timeoutMs;
  };

  return {
    maybeLogAdaptiveAckTimeout,
    resolveMessageAckTimeoutMs,
    buildRuntimeAckObservability: (accountId: string) =>
      runtime.buildRuntimeAckObservability(accountId),
    buildRuntimeAckStrategy: (ackObservability: BncrAckObservability): BncrAckStrategy => {
      if (runtime.buildRuntimeAckStrategy) {
        return runtime.buildRuntimeAckStrategy(ackObservability) as BncrAckStrategy;
      }
      return buildBncrRuntimeAckStrategy({
        ackObservability,
        defaultAckTimeoutMs: runtime.pushAckTimeoutMs,
        maxAckTimeoutMs: runtime.recommendedAckTimeoutMaxMs,
      });
    },
    fileAckKey: runtime.fileAckKey,
    waitForFileAck: runtime.waitForFileAck,
    resolveFileAck: runtime.resolveFileAck,
    resolveMessageAck: runtime.resolveMessageAck,
    waitForMessageAck: runtime.waitForMessageAck,
  };
}
