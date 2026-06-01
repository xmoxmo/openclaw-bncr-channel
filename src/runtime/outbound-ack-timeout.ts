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

function finiteNumberOr(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

export function buildBncrRuntimeAckStrategy(args: {
  ackObservability: Record<string, any>;
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
  };
}
