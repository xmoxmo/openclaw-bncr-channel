import { normalizeAccountId } from '../core/accounts.ts';

type StatusWorkerContext = {
  accountId: string;
  getStatus?: () => Record<string, any>;
  setStatus?: (status: Record<string, any>) => void;
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
};

type StatusWorkerHooks = {
  isOnline: (accountId: string) => boolean;
  hasRecentInboundReachability: (accountId: string) => boolean;
  getLastActivityAt: (accountId: string, previous: Record<string, any>) => number | null;
  getActiveConnectionKey: (accountId: string) => string | null;
  getActiveConnections: (accountId: string) => Array<Record<string, unknown>>;
  buildStatusMeta: (accountId: string) => Record<string, any>;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logInfoDedup: (
    scope: string | undefined,
    message: string,
    options: { key: string; sig: string; debugOnly?: boolean; windowMs?: number },
  ) => void;
};

type StatusWorkerRuntime = {
  workers: Map<string, ChannelAccountWorkerHandle>;
  bridgeId: string;
  hooks: StatusWorkerHooks;
};

export function clearBncrStatusWorker(
  runtime: StatusWorkerRuntime,
  accountId: string,
  reason: string,
) {
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

export async function startBncrStatusWorker(runtime: StatusWorkerRuntime, ctx: StatusWorkerContext) {
  const accountId = normalizeAccountId(ctx.accountId);
  clearBncrStatusWorker(runtime, accountId, 'start-replace');

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
    runtime.hooks.logInfoDedup(
      'health',
      `status-tick ${accountId}|changed|${connected ? 'linked' : 'configured'}|onlineByConn=${onlineByConn}|recentInboundReachable=${recentInboundReachable}|conns=${conns}`,
      {
        key: `health-status-tick:${accountId}`,
        sig: healthSig,
      },
    );
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

  tick();
  const timer = setInterval(tick, 5_000);
  let worker!: ChannelAccountWorkerHandle;
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

    worker = { timer, finish };
    runtime.workers.set(accountId, worker);

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

export async function stopBncrStatusWorker(runtime: StatusWorkerRuntime, ctx: Partial<StatusWorkerContext>) {
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
