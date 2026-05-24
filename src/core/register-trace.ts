const DEFAULT_REGISTER_WARMUP_WINDOW_MS = 30_000;

function finiteNumberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export type RegisterTraceEntry = {
  ts: number;
  bridgeId: string;
  gatewayPid: number;
  registerCount: number;
  apiGeneration: number;
  apiRebound: boolean;
  apiInstanceId: string | null;
  registryFingerprint: string | null;
  source: string | null;
  pluginVersion: string | null;
  stack: string;
  stackBucket: string;
};

export type RegisterTraceSummary = {
  startupWindowMs: number;
  traceWindowSize: number;
  sourceBuckets: Record<string, number>;
  dominantBucket: string | null;
  warmupRegisterCount: number;
  postWarmupRegisterCount: number;
  unexpectedRegisterAfterWarmup: boolean;
  lastUnexpectedRegisterAt: number | null;
  likelyRuntimeRegistryDrift: boolean;
  likelyStartupFanoutOnly: boolean;
};

export function classifyRegisterTrace(stack: string) {
  if (
    stack.includes('prepareSecretsRuntimeSnapshot') ||
    stack.includes('resolveRuntimeWebTools') ||
    stack.includes('resolvePluginWebSearchProviders')
  ) {
    return 'runtime/webtools';
  }
  if (stack.includes('startGatewayServer') || stack.includes('loadGatewayPlugins')) {
    return 'gateway/startup';
  }
  if (stack.includes('resolvePluginImplicitProviders')) {
    return 'provider/discovery/implicit';
  }
  if (stack.includes('resolvePluginDiscoveryProviders')) {
    return 'provider/discovery/discovery';
  }
  if (stack.includes('resolvePluginProviders')) {
    return 'provider/discovery/providers';
  }
  return 'other';
}

export function dominantRegisterBucket(sourceBuckets: Record<string, number>) {
  let winner: string | null = null;
  let winnerCount = -1;
  for (const [bucket, count] of Object.entries(sourceBuckets)) {
    if (count > winnerCount) {
      winner = bucket;
      winnerCount = count;
    }
  }
  return winner;
}

export function buildRegisterTraceSummary(args: {
  traceRecent: RegisterTraceEntry[];
  firstRegisterAt: number | null;
  warmupWindowMs?: number;
}): RegisterTraceSummary {
  const warmupWindowMs = Math.max(
    0,
    finiteNumberOr(args.warmupWindowMs, DEFAULT_REGISTER_WARMUP_WINDOW_MS),
  );
  const buckets: Record<string, number> = {};
  let warmupCount = 0;
  let postWarmupCount = 0;
  let unexpectedRegisterAfterWarmup = false;
  let lastUnexpectedRegisterAt: number | null = null;
  const baseline = args.firstRegisterAt;

  for (const trace of args.traceRecent) {
    buckets[trace.stackBucket] = (buckets[trace.stackBucket] || 0) + 1;
    const isWarmup = baseline != null && trace.ts - baseline <= warmupWindowMs;
    if (isWarmup) {
      warmupCount += 1;
    } else {
      postWarmupCount += 1;
      unexpectedRegisterAfterWarmup = true;
      lastUnexpectedRegisterAt = trace.ts;
    }
  }

  const dominantBucket = dominantRegisterBucket(buckets);
  const likelyRuntimeRegistryDrift = postWarmupCount > 0;
  const likelyStartupFanoutOnly = warmupCount > 0 && postWarmupCount === 0;

  return {
    startupWindowMs: warmupWindowMs,
    traceWindowSize: args.traceRecent.length,
    sourceBuckets: buckets,
    dominantBucket,
    warmupRegisterCount: warmupCount,
    postWarmupRegisterCount: postWarmupCount,
    unexpectedRegisterAfterWarmup,
    lastUnexpectedRegisterAt,
    likelyRuntimeRegistryDrift,
    likelyStartupFanoutOnly,
  };
}
