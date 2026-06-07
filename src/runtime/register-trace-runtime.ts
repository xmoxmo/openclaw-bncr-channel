import {
  appendBoundedRegisterTrace,
  buildRegisterDriftSnapshot,
  buildRegisterTraceEntry,
  buildRegisterTraceSummary,
  type RegisterDriftSnapshot,
  type RegisterTraceEntry,
  type RegisterTraceSummary,
} from '../core/register-trace.ts';

export type RegisterTraceRuntimeState = {
  registerCount: number;
  apiGeneration: number;
  firstRegisterAt: number | null;
  lastRegisterAt: number | null;
  lastApiRebindAt: number | null;
  pluginSource: string | null;
  pluginVersion: string | null;
  lastApiInstanceId: string | null;
  lastRegistryFingerprint: string | null;
  lastDriftSnapshot: RegisterDriftSnapshot | null;
  registerTraceRecent: RegisterTraceEntry[];
};

export type RegisterTraceRuntimeMeta = {
  source?: string;
  pluginVersion?: string;
  apiRebound?: boolean;
  apiInstanceId?: string;
  registryFingerprint?: string;
};

export function buildRegisterTraceRuntimeSummary(args: {
  state: Pick<RegisterTraceRuntimeState, 'registerTraceRecent' | 'firstRegisterAt'>;
  warmupWindowMs: number;
}): RegisterTraceSummary {
  return buildRegisterTraceSummary({
    traceRecent: args.state.registerTraceRecent,
    firstRegisterAt: args.state.firstRegisterAt,
    warmupWindowMs: args.warmupWindowMs,
  });
}

export function noteRegisterTraceRuntime(args: {
  state: RegisterTraceRuntimeState;
  meta: RegisterTraceRuntimeMeta;
  ts: number;
  stack: string;
  bridgeId: string;
  gatewayPid: number;
  warmupWindowMs: number;
  maxTraceEntries?: number;
}): { trace: RegisterTraceEntry; summary: RegisterTraceSummary; capturedDriftSnapshot: boolean } {
  const { state, meta } = args;
  state.registerCount += 1;
  if (state.firstRegisterAt == null) state.firstRegisterAt = args.ts;
  state.lastRegisterAt = args.ts;
  if (meta.apiRebound) {
    state.apiGeneration += 1;
    state.lastApiRebindAt = args.ts;
  } else if (state.registerCount === 1 && state.apiGeneration === 0) {
    state.apiGeneration = 1;
  }
  if (meta.source) state.pluginSource = meta.source;
  if (meta.pluginVersion) state.pluginVersion = meta.pluginVersion;
  if (meta.apiInstanceId) state.lastApiInstanceId = meta.apiInstanceId;
  if (meta.registryFingerprint) state.lastRegistryFingerprint = meta.registryFingerprint;

  const trace = buildRegisterTraceEntry({
    ts: args.ts,
    bridgeId: args.bridgeId,
    gatewayPid: args.gatewayPid,
    registerCount: state.registerCount,
    apiGeneration: state.apiGeneration,
    apiRebound: meta.apiRebound === true,
    apiInstanceId: state.lastApiInstanceId,
    registryFingerprint: state.lastRegistryFingerprint,
    source: state.pluginSource,
    pluginVersion: state.pluginVersion,
    stack: args.stack,
  });
  appendBoundedRegisterTrace(state.registerTraceRecent, trace, args.maxTraceEntries ?? 12);

  const summary = buildRegisterTraceRuntimeSummary({
    state,
    warmupWindowMs: args.warmupWindowMs,
  });
  const capturedDriftSnapshot = summary.postWarmupRegisterCount > 0;
  if (capturedDriftSnapshot) {
    state.lastDriftSnapshot = buildRegisterDriftSnapshot({
      capturedAt: args.ts,
      registerCount: state.registerCount,
      apiGeneration: state.apiGeneration,
      summary,
      apiInstanceId: state.lastApiInstanceId,
      registryFingerprint: state.lastRegistryFingerprint,
      traceRecent: state.registerTraceRecent,
    });
  }

  return { trace, summary, capturedDriftSnapshot };
}
