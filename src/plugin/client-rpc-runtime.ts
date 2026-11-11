import { randomUUID } from 'node:crypto';
import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import {
  classifyOutboundFailure,
  OUTBOUND_FAILURE_KIND,
  type OutboundFailureKind,
} from '../core/outbound-connection-health.ts';

export const BNCR_CLIENT_RPC_REQUEST_EVENT = 'plugin.bncr.rpc.request';
export const BNCR_CLIENT_RPC_RESPONSE_METHOD = 'bncr.rpc.response';
export const BNCR_CLIENT_RPC_TIMEOUT_MS = 15000;

type BncrClientRpcPending = {
  method: string;
  accountId: string;
  connId: string;
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
  resolvePushOwnerConnId: (accountId: string) => string | null | undefined;
  broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => void;
  commitOutboundOwner?: (accountId: string, connId: string) => unknown;
  markOutboundAckSuccess?: (args: { accountId: string; connId: string }) => unknown;
  recordOutboundFailure?: (args: {
    accountId: string;
    connIds: Iterable<string>;
    kind: OutboundFailureKind;
  }) => unknown;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  timeoutMs?: number;
}): BncrClientRpcRuntime {
  const pending = new Map<string, BncrClientRpcPending>();
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

    const targetConnId = String(runtime.resolvePushOwnerConnId(accountId) || '').trim();
    if (!targetConnId) {
      return Promise.reject(new Error(`no active bncr client connection for account ${accountId}`));
    }
    const targetConnIds = new Set([targetConnId]);

    // A BNCR result may return after a reconnect, so connId is only the current
    // transport route. The unguessable requestId is this RPC's delivery proof.
    const requestId = `rpc_${randomUUID()}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup(requestId);
        runtime.recordOutboundFailure?.({
          accountId,
          connIds: targetConnIds,
          kind: OUTBOUND_FAILURE_KIND.RPC_TRANSPORT_TIMEOUT,
        });
        reject(
          new Error(
            `bncr client RPC timeout method=${normalizedMethod}|accountId=${accountId}|timeoutMs=${timeoutMs}`,
          ),
        );
      }, timeoutMs);
      pending.set(requestId, {
        method: normalizedMethod,
        accountId,
        connId: targetConnId,
        resolve,
        reject,
        timer,
      });
      try {
        runtime.broadcastToConnIds(
          BNCR_CLIENT_RPC_REQUEST_EVENT,
          {
            requestId,
            method: normalizedMethod,
            args: args ?? {},
          },
          targetConnIds,
        );
        runtime.commitOutboundOwner?.(accountId, targetConnId);
      } catch (error) {
        cleanup(requestId);
        runtime.recordOutboundFailure?.({
          accountId,
          connIds: targetConnIds,
          kind: classifyOutboundFailure({ error, stage: 'rpc' }),
        });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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
      // A successful result is outbound evidence. A business rejection is not:
      // it proves the client answered, but must not erase transport-failure
      // history that may still affect route selection.
      runtime.markOutboundAckSuccess?.({
        accountId: entry.accountId,
        connId: entry.connId,
      });
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
