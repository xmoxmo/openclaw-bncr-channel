import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { BncrRecentOutboundEntry } from '../core/types.ts';
import type { BncrStatusRuntimeSnapshot } from './channel-runtime-types.ts';

export const BNCR_LOCAL_BRIDGE_METHODS = [
  'bncr.methods',
  'bncr.status.channel',
  'bncr.status.account',
  'bncr.status.headline',
  'bncr.outbound.recent',
  'bncr.diagnostics',
  'bncr.deadLetter.inspect',
  'bncr.deadLetter.prune',
] as const;

export type BncrBridgeCallDiagnosticsBridge = {
  diagnostics: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deadLetterInspect: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deadLetterPrune: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

export type BncrBridgeCallBridge = {
  call: (
    method: string,
    args: Record<string, unknown>,
    accountId?: string,
  ) => Promise<Record<string, unknown>>;
};

export type BncrBridgeCallRecentOutboundBridge = {
  listRecentOutbound: (sessionKey: string) => BncrRecentOutboundEntry[];
  listRecentOutboundByAccount: (accountId: string) => BncrRecentOutboundEntry[];
};

/**
 * Runs a gateway-style handler with a captured respond callback so local
 * diagnostics/dead-letter handlers can be exposed through the message tool.
 */
export async function invokeBncrBridgeGatewayHandler(
  handler: (ctx: GatewayRequestHandlerOptions) => Promise<void>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let ok = false;
  let payload: unknown;
  const ctx = {
    params: args,
    respond: (accepted: boolean, value: unknown) => {
      ok = accepted;
      payload = value;
    },
  } as unknown as GatewayRequestHandlerOptions;

  await handler(ctx);

  if (!ok) {
    const message =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { message?: unknown }).message === 'string'
        ? (payload as { message: string }).message
        : 'bridge handler rejected request';
    throw new Error(message);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('bridge handler returned an invalid payload');
  }
  return payload as Record<string, unknown>;
}

/**
 * Local methods run inside the plugin process; any other method is forwarded
 * dynamically to the OpenClawClient RPC bridge.
 */
export function createBncrBridgeCallBridge(runtime: {
  defaultAccountId: string;
  getStatusBridge: () => {
    getChannelSummary: (
      defaultAccountId: string,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
    getAccountRuntimeSnapshot: (accountId?: string) => BncrStatusRuntimeSnapshot;
    getStatusHeadline: (accountId?: string) => string;
  };
  getDiagnosticsBridge: () => BncrBridgeCallDiagnosticsBridge;
  getRecentOutboundBridge: () => BncrBridgeCallRecentOutboundBridge;
  callClientRpc: (
    method: string,
    args: Record<string, unknown>,
    accountId: string,
  ) => Promise<Record<string, unknown>>;
}): BncrBridgeCallBridge {
  const resolveAccountId = (args: Record<string, unknown>, accountId?: string) => {
    const argsAccountId = typeof args.accountId === 'string' ? args.accountId.trim() : '';
    return accountId || argsAccountId || runtime.defaultAccountId;
  };

  const localHandlers: Record<
    string,
    (args: Record<string, unknown>, accountId: string) => Promise<Record<string, unknown>>
  > = {
    'bncr.methods': async (_args, accountId) => {
      const localMethods = [...BNCR_LOCAL_BRIDGE_METHODS];
      let clientMethods: string[] = [];
      let clientError: string | null = null;
      try {
        const clientResult = await runtime.callClientRpc('bncr.methods', { accountId }, accountId);
        const raw = (clientResult as { result?: { methods?: unknown } })?.result?.methods;
        clientMethods = Array.isArray(raw)
          ? raw.filter((item): item is string => typeof item === 'string')
          : [];
      } catch (error) {
        clientError = error instanceof Error ? error.message : String(error);
      }
      return {
        methods: [...new Set([...localMethods, ...clientMethods])],
        ...(clientError ? { clientError } : {}),
      };
    },
    'bncr.status.channel': async (_args, accountId) => ({
      value: await runtime.getStatusBridge().getChannelSummary(accountId),
    }),
    'bncr.status.account': async (_args, accountId) => ({
      value: runtime.getStatusBridge().getAccountRuntimeSnapshot(accountId),
    }),
    'bncr.status.headline': async (_args, accountId) => ({
      value: runtime.getStatusBridge().getStatusHeadline(accountId),
    }),
    'bncr.outbound.recent': async (args, accountId) => {
      const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey.trim() : '';
      const rawLimit = typeof args.limit === 'number' ? args.limit : Number(args.limit);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : undefined;
      const recentBridge = runtime.getRecentOutboundBridge();
      const entries = sessionKey
        ? recentBridge.listRecentOutbound(sessionKey)
        : recentBridge.listRecentOutboundByAccount(accountId);
      return {
        accountId,
        sessionKey: sessionKey || undefined,
        limit,
        total: entries.length,
        entries: typeof limit === 'number' ? entries.slice(0, limit) : entries,
        now: Date.now(),
      };
    },
    'bncr.diagnostics': (args) => runtime.getDiagnosticsBridge().diagnostics(args),
    'bncr.deadLetter.inspect': (args) => runtime.getDiagnosticsBridge().deadLetterInspect(args),
    'bncr.deadLetter.prune': (args) => runtime.getDiagnosticsBridge().deadLetterPrune(args),
  };

  return {
    call: async (method, args, accountId) => {
      const normalizedMethod = String(method || '').trim();
      if (!normalizedMethod) {
        throw new Error('bridge method is required');
      }
      const normalizedArgs = args ?? {};
      const resolvedAccountId = resolveAccountId(normalizedArgs, accountId);
      const localHandler = localHandlers[normalizedMethod];
      if (localHandler) {
        return {
          ok: true,
          method: normalizedMethod,
          result: await localHandler(normalizedArgs, resolvedAccountId),
        };
      }
      return runtime.callClientRpc(normalizedMethod, normalizedArgs, resolvedAccountId);
    },
  };
}
