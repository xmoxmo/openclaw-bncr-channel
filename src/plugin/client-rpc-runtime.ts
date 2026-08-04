import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';

export const BNCR_CLIENT_RPC_REQUEST_EVENT = 'plugin.bncr.rpc.request';
export const BNCR_CLIENT_RPC_RESPONSE_METHOD = 'bncr.rpc.response';
export const BNCR_CLIENT_RPC_TIMEOUT_MS = 15000;

type BncrClientRpcPending = {
  method: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type BncrClientRpcRuntime = {
  call: (
    method: string,
    args: Record<string, unknown>,
    accountId: string,
  ) => Promise<Record<string, unknown>>;
  handleResponse: (ctx: GatewayRequestHandlerOptions) => void;
  pendingCount: () => number;
  shutdown: () => void;
};

export function createBncrClientRpcRuntime(runtime: {
  resolvePushConnIds: (accountId: string) => ReadonlySet<string>;
  broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => void;
  now: () => number;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  timeoutMs?: number;
}): BncrClientRpcRuntime {
  const pending = new Map<string, BncrClientRpcPending>();
  let requestSeq = 0;
  const timeoutMs = Math.max(Number(runtime.timeoutMs ?? BNCR_CLIENT_RPC_TIMEOUT_MS), 1);

  const cleanup = (requestId: string) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(requestId);
  };

  const call = (method: string, args: Record<string, unknown>, accountId: string) => {
    const normalizedMethod = String(method || '').trim();
    if (!normalizedMethod) {
      return Promise.reject(new Error('bncr client RPC requires a method name'));
    }

    const connIds = runtime.resolvePushConnIds(accountId);
    if (!connIds.size) {
      return Promise.reject(new Error(`no active bncr client connection for account ${accountId}`));
    }
    const targetConnIds = new Set([Array.from(connIds)[0]]);

    const requestId = `rpc_${runtime.now().toString(36)}_${String(process.pid)}_${++requestSeq}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup(requestId);
        reject(
          new Error(
            `bncr client RPC timeout method=${normalizedMethod}|accountId=${accountId}|timeoutMs=${timeoutMs}`,
          ),
        );
      }, timeoutMs);
      pending.set(requestId, {
        method: normalizedMethod,
        resolve,
        reject,
        timer,
      });
      runtime.broadcastToConnIds(
        BNCR_CLIENT_RPC_REQUEST_EVENT,
        {
          requestId,
          method: normalizedMethod,
          args: args ?? {},
        },
        targetConnIds,
      );
    });
  };

  const handleResponse = (ctx: GatewayRequestHandlerOptions) => {
    const params =
      ctx.params && typeof ctx.params === 'object' ? (ctx.params as Record<string, unknown>) : {};
    const requestId = typeof params.requestId === 'string' ? params.requestId.trim() : '';
    const entry = requestId ? pending.get(requestId) : undefined;
    if (!entry) {
      runtime.logInfo('client-rpc', `rpc response ignored requestId=${requestId || '(missing)'}`, {
        debugOnly: true,
      });
      ctx.respond(true, { ok: true, consumed: false, requestId });
      return;
    }

    cleanup(requestId);
    if (params.ok === true) {
      const result =
        params.result && typeof params.result === 'object'
          ? (params.result as Record<string, unknown>)
          : { value: params.result };
      entry.resolve({
        ok: true,
        method: entry.method,
        result,
      });
    } else {
      const message =
        typeof params.error === 'string'
          ? params.error
          : `bncr client RPC failed method=${entry.method}`;
      entry.reject(new Error(message));
    }
    ctx.respond(true, { ok: true, consumed: true, requestId });
  };

  return {
    call,
    handleResponse,
    pendingCount: () => pending.size,
    shutdown: () => {
      for (const [requestId, entry] of pending.entries()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`bncr client RPC cancelled method=${entry.method}`));
        pending.delete(requestId);
      }
    },
  };
}
