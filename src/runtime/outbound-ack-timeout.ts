import type { BncrAckObservability, BncrAckStrategy } from '../core/types.ts';

type ComputeBncrRecommendedAckTimeoutArgs = {
  lateAckOkCount: number;
  recentAckTimeoutCount: number;
  lastLateAckPushLatencyMs: number | null;
  lastLateAckOkAt?: number | null;
  adaptiveAckRecoveryOkCount?: number;
  nowMs: number;
  defaultAckTimeoutMs: number;
  minAckTimeoutMs: number;
  maxAckTimeoutMs: number;
  lateAckObservationTtlMs: number;
  recoveryOkThreshold: number;
};

type ComputeBncrRecommendedAckTimeoutReasonArgs = ComputeBncrRecommendedAckTimeoutArgs & {
  recommendedAckTimeoutMs?: number;
};

function isLateAckObservationExpired(args: {
  lastLateAckOkAt?: number | null;
  nowMs: number;
  lateAckObservationTtlMs: number;
}) {
  const lastLateAckOkAt = typeof args.lastLateAckOkAt === 'number' ? args.lastLateAckOkAt : null;
  return (
    typeof lastLateAckOkAt === 'number' &&
    lastLateAckOkAt > 0 &&
    args.nowMs - lastLateAckOkAt > args.lateAckObservationTtlMs
  );
}

function isAdaptiveAckRecovered(args: {
  adaptiveAckRecoveryOkCount?: number;
  recoveryOkThreshold: number;
}) {
  return (
    typeof args.adaptiveAckRecoveryOkCount === 'number' &&
    args.adaptiveAckRecoveryOkCount >= args.recoveryOkThreshold
  );
}

export function computeBncrRecommendedAckTimeoutReason(
  args: ComputeBncrRecommendedAckTimeoutReasonArgs,
) {
  if (args.recentAckTimeoutCount <= 0) return 'no-timeout-evidence';
  if (args.lateAckOkCount <= 0) return 'no-late-ack-evidence';
  if (typeof args.lastLateAckPushLatencyMs !== 'number') return 'missing-latency';
  if (isLateAckObservationExpired(args)) return 'late-ack-expired';
  if (isAdaptiveAckRecovered(args)) return 'recovered';
  if (args.recommendedAckTimeoutMs === args.maxAckTimeoutMs) return 'capped-max';
  return 'late-ack-observed';
}

export function computeBncrRecommendedAckTimeoutMs(args: ComputeBncrRecommendedAckTimeoutArgs) {
  if (
    args.lateAckOkCount <= 0 ||
    args.recentAckTimeoutCount <= 0 ||
    typeof args.lastLateAckPushLatencyMs !== 'number' ||
    isLateAckObservationExpired(args) ||
    isAdaptiveAckRecovered(args)
  ) {
    return args.defaultAckTimeoutMs;
  }
  const recommended = Math.ceil(args.lastLateAckPushLatencyMs * 1.25);
  return Math.min(args.maxAckTimeoutMs, Math.max(args.minAckTimeoutMs, recommended));
}

export function resolveBncrRuntimeAckTimeoutDecision(args: ComputeBncrRecommendedAckTimeoutArgs) {
  const timeoutMs = computeBncrRecommendedAckTimeoutMs(args);
  const reason = computeBncrRecommendedAckTimeoutReason({
    ...args,
    recommendedAckTimeoutMs: timeoutMs,
  });
  return { timeoutMs, reason };
}

function finiteNumberOr(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

export function buildBncrRuntimeAckStrategy(args: {
  ackObservability: BncrAckObservability;
  defaultAckTimeoutMs: number;
  maxAckTimeoutMs: number;
}) {
  const { ackObservability } = args;
  const currentMs = finiteNumberOr(ackObservability.currentAckTimeoutMs, args.defaultAckTimeoutMs);
  const defaultMs = finiteNumberOr(ackObservability.defaultAckTimeoutMs, args.defaultAckTimeoutMs);
  const reason = asString(ackObservability.recommendedAckTimeoutReason || 'unknown') || 'unknown';
  return {
    mode: ackObservability.adaptiveAckTimeoutEnabled === true ? 'adaptive' : 'fixed',
    currentMs,
    defaultMs,
    maxMs: args.maxAckTimeoutMs,
    reason,
    active: currentMs > defaultMs,
    lastLateAckAgeMs: ackObservability.lastLateAckAgeMs ?? null,
    lateAckObservationTtlMs: ackObservability.lateAckObservationTtlMs ?? null,
    recovered: ackObservability.adaptiveAckRecovered === true,
  } satisfies BncrAckStrategy;
}

export function buildBncrRuntimeAckObservability(args: {
  lastAckOkAt: number | null;
  lastAckTimeoutAt: number | null;
  recentAckTimeoutCount: number;
  lateAckOkCount: number;
  lastLateAckOkAt: number | null;
  adaptiveAckRecoveryOkCount: number;
  lastAckQueueLatencyMs: number | null;
  lastAckPushLatencyMs: number | null;
  lastLateAckQueueLatencyMs: number | null;
  lastLateAckPushLatencyMs: number | null;
  adaptiveAckTimeoutEnabled: boolean;
  defaultAckTimeoutMs: number;
  currentAckTimeoutMs: number;
  minAckTimeoutMs: number;
  maxAckTimeoutMs: number;
  lateAckObservationTtlMs: number;
  recoveryOkThreshold: number;
  nowMs: number;
}) {
  const lastLateAckAgeMs =
    typeof args.lastLateAckOkAt === 'number' && args.lastLateAckOkAt > 0
      ? Math.max(0, args.nowMs - args.lastLateAckOkAt)
      : null;
  const lateAckObservationExpired =
    typeof lastLateAckAgeMs === 'number' && lastLateAckAgeMs > args.lateAckObservationTtlMs;
  const adaptiveAckRecovered = args.adaptiveAckRecoveryOkCount >= args.recoveryOkThreshold;
  const ackTimeoutDecision = resolveBncrRuntimeAckTimeoutDecision({
    lateAckOkCount: args.lateAckOkCount,
    recentAckTimeoutCount: args.recentAckTimeoutCount,
    lastLateAckPushLatencyMs: args.lastLateAckPushLatencyMs,
    lastLateAckOkAt: args.lastLateAckOkAt,
    adaptiveAckRecoveryOkCount: args.adaptiveAckRecoveryOkCount,
    nowMs: args.nowMs,
    defaultAckTimeoutMs: args.defaultAckTimeoutMs,
    minAckTimeoutMs: args.minAckTimeoutMs,
    maxAckTimeoutMs: args.maxAckTimeoutMs,
    lateAckObservationTtlMs: args.lateAckObservationTtlMs,
    recoveryOkThreshold: args.recoveryOkThreshold,
  });
  return {
    lastAckOkAt: args.lastAckOkAt,
    lastAckTimeoutAt: args.lastAckTimeoutAt,
    recentAckTimeoutCount: args.recentAckTimeoutCount,
    lateAckOkCount: args.lateAckOkCount,
    lastLateAckOkAt: args.lastLateAckOkAt,
    lastLateAckAgeMs,
    lateAckObservationTtlMs: args.lateAckObservationTtlMs,
    lateAckObservationExpired,
    adaptiveAckRecoveryOkCount: args.adaptiveAckRecoveryOkCount,
    adaptiveAckRecoveryOkThreshold: args.recoveryOkThreshold,
    adaptiveAckRecovered,
    lastAckQueueLatencyMs: args.lastAckQueueLatencyMs,
    lastAckPushLatencyMs: args.lastAckPushLatencyMs,
    lastLateAckQueueLatencyMs: args.lastLateAckQueueLatencyMs,
    lastLateAckPushLatencyMs: args.lastLateAckPushLatencyMs,
    adaptiveAckTimeoutEnabled: args.adaptiveAckTimeoutEnabled,
    defaultAckTimeoutMs: args.defaultAckTimeoutMs,
    currentAckTimeoutMs: args.currentAckTimeoutMs,
    recommendedAckTimeoutMs: ackTimeoutDecision.timeoutMs,
    recommendedAckTimeoutReason: ackTimeoutDecision.reason,
  } satisfies BncrAckObservability;
}
