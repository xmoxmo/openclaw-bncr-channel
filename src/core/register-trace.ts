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

export type RegisterDriftSnapshot = {
  capturedAt: number;
  registerCount: number;
  apiGeneration: number;
  postWarmupRegisterCount: number;
  apiInstanceId: string | null;
  registryFingerprint: string | null;
  dominantBucket: string | null;
  sourceBuckets: Record<string, number>;
  traceWindowSize: number;
  traceRecent: Array<Record<string, unknown>>;
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

export function normalizeRegisterDriftSnapshot(raw: unknown): RegisterDriftSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const finiteOrNull = (value: unknown): number | null => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const cleanString = (value: unknown): string | null => {
    const text = value == null ? '' : String(value);
    return text.trim() || null;
  };

  return {
    capturedAt: finiteNumberOr(data.capturedAt, 0),
    registerCount: finiteOrNull(data.registerCount),
    apiGeneration: finiteOrNull(data.apiGeneration),
    postWarmupRegisterCount: finiteOrNull(data.postWarmupRegisterCount),
    apiInstanceId: cleanString(data.apiInstanceId),
    registryFingerprint: cleanString(data.registryFingerprint),
    dominantBucket: cleanString(data.dominantBucket),
    sourceBuckets:
      data.sourceBuckets && typeof data.sourceBuckets === 'object'
        ? { ...(data.sourceBuckets as Record<string, number>) }
        : {},
    traceWindowSize: finiteNumberOr(data.traceWindowSize, 0),
    traceRecent: Array.isArray(data.traceRecent)
      ? [...(data.traceRecent as Array<Record<string, unknown>>)]
      : [],
  };
}

export function dumpRegisterDriftSnapshot(snapshot: RegisterDriftSnapshot | null) {
  return snapshot
    ? {
        capturedAt: snapshot.capturedAt,
        registerCount: snapshot.registerCount,
        apiGeneration: snapshot.apiGeneration,
        postWarmupRegisterCount: snapshot.postWarmupRegisterCount,
        apiInstanceId: snapshot.apiInstanceId,
        registryFingerprint: snapshot.registryFingerprint,
        dominantBucket: snapshot.dominantBucket,
        sourceBuckets: { ...snapshot.sourceBuckets },
        traceWindowSize: snapshot.traceWindowSize,
        traceRecent: snapshot.traceRecent.map((trace) => ({ ...trace })),
      }
    : null;
}

export function buildRegisterTraceEntry(args: {
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
}): RegisterTraceEntry {
  return {
    ts: args.ts,
    bridgeId: args.bridgeId,
    gatewayPid: args.gatewayPid,
    registerCount: args.registerCount,
    apiGeneration: args.apiGeneration,
    apiRebound: args.apiRebound,
    apiInstanceId: args.apiInstanceId,
    registryFingerprint: args.registryFingerprint,
    source: args.source,
    pluginVersion: args.pluginVersion,
    stack: args.stack,
    stackBucket: classifyRegisterTrace(args.stack),
  };
}

export function appendBoundedRegisterTrace(
  traceRecent: RegisterTraceEntry[],
  trace: RegisterTraceEntry,
  maxEntries = 12,
) {
  traceRecent.push(trace);
  const cap = Math.max(0, Math.floor(finiteNumberOr(maxEntries, 12)));
  if (cap === 0) {
    traceRecent.splice(0, traceRecent.length);
    return;
  }
  if (traceRecent.length > cap) traceRecent.splice(0, traceRecent.length - cap);
}

export function buildRegisterDriftSnapshot(args: {
  capturedAt: number;
  registerCount: number;
  apiGeneration: number;
  summary: RegisterTraceSummary;
  apiInstanceId: string | null;
  registryFingerprint: string | null;
  traceRecent: RegisterTraceEntry[];
}): RegisterDriftSnapshot {
  return {
    capturedAt: args.capturedAt,
    registerCount: args.registerCount,
    apiGeneration: args.apiGeneration,
    postWarmupRegisterCount: args.summary.postWarmupRegisterCount,
    apiInstanceId: args.apiInstanceId,
    registryFingerprint: args.registryFingerprint,
    dominantBucket: args.summary.dominantBucket,
    sourceBuckets: { ...args.summary.sourceBuckets },
    traceWindowSize: args.traceRecent.length,
    traceRecent: args.traceRecent.map((trace) => ({ ...trace })),
  };
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
