import { normalizeAccountId } from '../core/accounts.ts';
import type { BncrDiagnosticsSummary } from '../core/types.ts';
import { finiteNumberOr, nonNegativeFiniteNumberOr } from '../core/value-sanitize.ts';

type StatusRuntimeMeta = {
  pending?: number;
  pendingAdmissionsCount?: number;
  pendingAdmissions?: unknown[];
  deadLetter?: number;
  lastSessionScope?: string | null;
  lastSessionAt?: number | null;
  lastSessionAgo?: string | null;
  lastActivityAt?: number | null;
  lastActivityAgo?: string | null;
  lastInboundAt?: number | null;
  lastInboundAgo?: string | null;
  lastOutboundAt?: number | null;
  lastOutboundAgo?: string | null;
  diagnostics?: BncrDiagnosticsSummary | Record<string, unknown>;
};

type StatusRuntimeState = {
  accountId?: string;
  running?: boolean;
  connected?: boolean;
  restartPending?: boolean;
  lastEventAt?: number | null;
  lastStopAt?: number | null;
  mode?: 'linked' | 'configured' | string;
  lastError?: string | null;
  meta?: StatusRuntimeMeta;
};

type StatusWorkerContext = {
  accountId: string;
  getStatus?: () => StatusRuntimeState;
  setStatus?: (status: StatusRuntimeState) => void;
  abortSignal?: {
    aborted?: boolean;
    addEventListener?: (event: 'abort', listener: () => void, options?: { once?: boolean }) => void;
    removeEventListener?: (event: 'abort', listener: () => void) => void;
  };
};

export type ChannelAccountWorkerHandle = {
  timer: NodeJS.Timeout;
  finish: (reason: string) => void;
  cleanupAbortListener?: () => void;
  healthLogState?: HealthStatusLogState;
};

const HEALTH_STATUS_STABLE_WINDOW_MS = 10_000;

export type HealthStatusLogState = {
  emittedSig: string | null;
  pendingSig: string | null;
  pendingSince: number;
};

export function createHealthStatusLogState(): HealthStatusLogState {
  return { emittedSig: null, pendingSig: null, pendingSince: 0 };
}

export function updateHealthStatusLogState(args: {
  state: HealthStatusLogState;
  sig: string;
  nowMs: number;
  stableWindowMs?: number;
}): 'pending' | 'stable' | 'unchanged' {
  const stableWindowMs = nonNegativeFiniteNumberOr(
    args.stableWindowMs,
    HEALTH_STATUS_STABLE_WINDOW_MS,
  );
  const nowMs = finiteNumberOr(args.nowMs, 0);
  if (args.state.emittedSig === args.sig) {
    args.state.pendingSig = null;
    args.state.pendingSince = 0;
    return 'unchanged';
  }
  if (args.state.pendingSig !== args.sig) {
    args.state.pendingSig = args.sig;
    args.state.pendingSince = nowMs;
    if (stableWindowMs > 0) return 'pending';
  }
  if (nowMs - args.state.pendingSince < stableWindowMs) return 'pending';
  args.state.emittedSig = args.sig;
  args.state.pendingSig = null;
  args.state.pendingSince = 0;
  return 'stable';
}

type StatusWorkerHooks = {
  isOnline: (accountId: string) => boolean;
  hasRecentInboundReachability: (accountId: string) => boolean;
  getLastActivityAt: (accountId: string, previous: StatusRuntimeState) => number | null;
  getActiveConnectionKey: (accountId: string) => string | null;
  getActiveConnections: (accountId: string) => Array<Record<string, unknown>>;
  buildStatusMeta: (accountId: string) => StatusRuntimeMeta;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logInfoDedup: (
    scope: string | undefined,
    message: string,
    options: { key: string; sig: string; debugOnly?: boolean; windowMs?: number },
  ) => void;
  now?: () => number;
  healthStableWindowMs?: number;
};

type StatusWorkerRuntime = {
  workers: Map<string, ChannelAccountWorkerHandle>;
  bridgeId: string;
  hooks: StatusWorkerHooks;
};

function clearBncrStatusWorker(runtime: StatusWorkerRuntime, accountId: string, reason: string) {
  const worker = runtime.workers.get(accountId);
  if (!worker) return false;
  worker.finish(reason);
  runtime.hooks.logInfo(
    'health',
    `status-worker cleared ${JSON.stringify({ bridge: runtime.bridgeId, accountId, reason })}`,
    { debugOnly: true },
  );
  return true;
}

export function clearAllBncrStatusWorkers(runtime: StatusWorkerRuntime, reason: string) {
  for (const accountId of Array.from(runtime.workers.keys())) {
    clearBncrStatusWorker(runtime, accountId, reason);
  }
}

export async function startBncrStatusWorker(
  runtime: StatusWorkerRuntime,
  ctx: StatusWorkerContext,
) {
  const accountId = normalizeAccountId(ctx.accountId);
  clearBncrStatusWorker(runtime, accountId, 'start-replace');
  let worker!: ChannelAccountWorkerHandle;

  const tick = () => {
    const previous = ctx.getStatus?.() || {};
    const onlineByConn = runtime.hooks.isOnline(accountId);
    const recentInboundReachable = runtime.hooks.hasRecentInboundReachability(accountId);
    const connected = onlineByConn || recentInboundReachable;
    const lastActAt = runtime.hooks.getLastActivityAt(accountId, previous);
    const activeConnections = runtime.hooks.getActiveConnections(accountId);
    const healthSig = JSON.stringify({
      bridge: runtime.bridgeId,
      accountId,
      connected,
      onlineByConn,
      recentInboundReachable,
      activeConnectionKey: runtime.hooks.getActiveConnectionKey(accountId),
      activeConnections,
    });
    const conns = activeConnections.length;
    const healthLogState = worker.healthLogState || createHealthStatusLogState();
    worker.healthLogState = healthLogState;
    const healthLogDecision = updateHealthStatusLogState({
      state: healthLogState,
      sig: healthSig,
      nowMs: runtime.hooks.now?.() ?? Date.now(),
      stableWindowMs: runtime.hooks.healthStableWindowMs,
    });
    if (healthLogDecision === 'stable') {
      runtime.hooks.logInfo(
        'health',
        `status-tick ${accountId}|stable|${connected ? 'linked' : 'configured'}|onlineByConn=${onlineByConn}|recentInboundReachable=${recentInboundReachable}|conns=${conns}`,
      );
    }
    runtime.hooks.logInfoDedup('health', `status-tick ${healthSig}`, {
      key: `health-status-tick-debug:${accountId}`,
      sig: healthSig,
      debugOnly: true,
    });

    ctx.setStatus?.({
      ...previous,
      accountId,
      running: true,
      connected,
      lastEventAt: lastActAt,
      // 状态映射：在线=linked，离线=configured
      mode: connected ? 'linked' : 'configured',
      lastError: previous?.lastError ?? null,
      meta: runtime.hooks.buildStatusMeta(accountId),
    });
  };

  const timer = setInterval(tick, 5_000);
  const done = new Promise<void>((resolve) => {
    let settled = false;
    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      const activeWorker = runtime.workers.get(accountId);
      if (activeWorker === worker) {
        runtime.workers.delete(accountId);
      }
      clearInterval(timer);
      worker.cleanupAbortListener?.();
      worker.cleanupAbortListener = undefined;
      runtime.hooks.logInfo(
        'health',
        `status-worker finished ${JSON.stringify({ bridge: runtime.bridgeId, accountId, reason })}`,
        { debugOnly: true },
      );
      runtime.hooks.logInfo('health', `status-worker finished ${accountId}|${reason}`);
      resolve();
    };

    worker = { timer, finish, healthLogState: createHealthStatusLogState() };
    runtime.workers.set(accountId, worker);

    tick();

    const onAbort = () => finish('abort');
    const abortSignal = ctx.abortSignal;

    if (abortSignal?.aborted) {
      onAbort();
      return;
    }

    abortSignal?.addEventListener?.('abort', onAbort, { once: true });
    if (abortSignal?.removeEventListener) {
      worker.cleanupAbortListener = () => abortSignal.removeEventListener?.('abort', onAbort);
    }
  });
  await done;
}

export async function stopBncrStatusWorker(
  runtime: StatusWorkerRuntime,
  ctx: Partial<StatusWorkerContext>,
) {
  const accountId = normalizeAccountId(ctx?.accountId);
  const cleared = clearBncrStatusWorker(runtime, accountId, 'explicit-stop');
  const previous = ctx?.getStatus?.() || {};
  ctx?.setStatus?.({
    ...previous,
    accountId,
    running: false,
    restartPending: false,
    lastStopAt: Date.now(),
    meta: runtime.hooks.buildStatusMeta(accountId),
  });
  runtime.hooks.logInfo(
    'health',
    `status-stop ${JSON.stringify({ bridge: runtime.bridgeId, accountId, cleared })}`,
    { debugOnly: true },
  );
  runtime.hooks.logInfo('health', `status-stop ${accountId}|cleared=${cleared}`);
}
