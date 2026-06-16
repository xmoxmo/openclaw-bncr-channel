import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { OutboxEntry } from '../core/types.ts';
import { buildBncrGatewayEventContext } from './gateway-event-context.ts';

export type MessageAckWaitResult = 'acked' | 'timeout';

export type MessageAckWaiter = {
  promise: Promise<MessageAckWaitResult>;
  resolve: (result: MessageAckWaitResult) => void;
  timer: NodeJS.Timeout;
};

export function createBncrMessageAckRuntime(runtime: {
  asString: (value: unknown, fallback?: string) => string;
  now: () => number;
  clampFiniteNumber: (value: unknown, fallback: number, min: number, max: number) => number;
  normalizeAccountId: (accountId: string) => string;
  recommendedAckTimeoutMaxMs: number;
  messageAckWaiters: Map<string, MessageAckWaiter>;
  stopped: () => boolean;
  outbox: Map<string, OutboxEntry>;
  observeLease: (
    kind:
      | 'connect'
      | 'inbound'
      | 'activity'
      | 'ack'
      | 'file.init'
      | 'file.chunk'
      | 'file.complete'
      | 'file.abort',
    payload: Record<string, unknown>,
  ) => { stale: boolean };
  rememberGatewayContext: (context: GatewayRequestHandlerOptions['context']) => void;
  markSeen: (accountId: string, connId: string, clientId?: string) => void;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  handleAckOk: (args: {
    accountId: string;
    messageId: string;
    connId: string;
    clientId?: string;
    stale: boolean;
    entry: OutboxEntry;
  }) => void;
  handleAckFatal: (args: {
    entry: OutboxEntry;
    messageId: string;
    connId: string;
    clientId?: string;
    error: string;
  }) => void;
  handleAckRetry: (args: {
    entry: OutboxEntry;
    messageId: string;
    connId: string;
    clientId?: string;
    error: string;
  }) => void;
  flushPushQueueBestEffort: (args?: {
    accountId?: string;
    trigger?: string;
    reason?: string;
  }) => void;
  outboundFlushTriggerAckOk: string;
  outboundFlushReasonMessageAcked: string;
}) {
  function clearAllMessageAckWaiters(result: MessageAckWaitResult = 'timeout') {
    for (const waiter of runtime.messageAckWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
    runtime.messageAckWaiters.clear();
  }

  function resolveMessageAck(messageId: string, result: MessageAckWaitResult = 'acked') {
    const key = runtime.asString(messageId).trim();
    if (!key) return false;
    const waiter = runtime.messageAckWaiters.get(key);
    if (!waiter) return false;
    runtime.messageAckWaiters.delete(key);
    clearTimeout(waiter.timer);
    waiter.resolve(result);
    return true;
  }

  async function waitForMessageAck(
    messageId: string,
    waitMs: number,
  ): Promise<MessageAckWaitResult> {
    const key = runtime.asString(messageId).trim();
    const timeoutMs = runtime.clampFiniteNumber(waitMs, 0, 0, runtime.recommendedAckTimeoutMaxMs);
    if (!key || !timeoutMs) return 'timeout';

    const existing = runtime.messageAckWaiters.get(key);
    if (existing) {
      runtime.logWarn('outbox', `message-ack-waiter-reuse ${JSON.stringify({ messageId: key })}`, {
        debugOnly: true,
      });
      return await existing.promise;
    }

    let timer: NodeJS.Timeout;
    let resolveWaiter!: (result: MessageAckWaitResult) => void;
    const promise = new Promise<MessageAckWaitResult>((resolve) => {
      resolveWaiter = resolve;
      timer = setTimeout(() => {
        runtime.messageAckWaiters.delete(key);
        resolve('timeout');
      }, timeoutMs);
    });

    runtime.messageAckWaiters.set(key, { promise, resolve: resolveWaiter, timer: timer! });
    return await promise;
  }

  function prepareAckHandling(args: {
    params: GatewayRequestHandlerOptions['params'];
    respond: GatewayRequestHandlerOptions['respond'];
    client: GatewayRequestHandlerOptions['client'];
    context: GatewayRequestHandlerOptions['context'];
  }): {
    accountId: string;
    connId: string;
    clientId?: string;
    messageId: string;
    entry: OutboxEntry;
    staleObserved: { stale: boolean };
  } | null {
    const { params, respond, client, context } = args;
    const gatewayContext = buildBncrGatewayEventContext({
      params,
      client,
      context,
      asString: runtime.asString,
      normalizeAccountId: runtime.normalizeAccountId,
      now: runtime.now,
    });
    const { accountId, connId, clientId } = gatewayContext;
    const messageId = runtime.asString(params?.messageId || '').trim();
    const staleObserved = runtime.observeLease('ack', params ?? {});

    runtime.logInfo(
      'outbox',
      `ack ${JSON.stringify({
        accountId,
        messageId,
        ok: params?.ok !== false,
        fatal: params?.fatal === true,
        error: runtime.asString(params?.error || ''),
        stale: staleObserved.stale,
      })}`,
      { debugOnly: true },
    );
    if (!messageId) {
      respond(false, { error: 'messageId required' });
      return null;
    }

    if (runtime.stopped()) {
      respond(true, { ok: true, ignored: true, reason: 'service-stopped' });
      return null;
    }

    const entry = runtime.outbox.get(messageId);
    if (!entry) {
      respond(true, { ok: true, message: 'already-acked-or-missing', stale: staleObserved.stale });
      return null;
    }

    if (entry.accountId !== accountId) {
      respond(false, { error: 'account mismatch' });
      return null;
    }

    if (staleObserved.stale) {
      const sameConn = !!entry.lastPushConnId && entry.lastPushConnId === connId;
      const sameClient =
        !entry.lastPushConnId &&
        !!entry.lastPushClientId &&
        !!clientId &&
        entry.lastPushClientId === clientId;
      if (!(sameConn || sameClient)) {
        runtime.logWarn(
          'stale',
          `ignore kind=ack accountId=${accountId} connId=${connId} clientId=${clientId || '-'} messageId=${messageId} reason=owner-mismatch lastPushConnId=${entry.lastPushConnId || '-'} lastPushClientId=${entry.lastPushClientId || '-'}`,
          { debugOnly: true },
        );
        respond(true, { ok: true, stale: true, ignored: true });
        return null;
      }
    } else {
      runtime.rememberGatewayContext(gatewayContext.context);
      runtime.markSeen(accountId, connId, clientId);
    }

    return {
      accountId,
      connId,
      clientId,
      messageId,
      entry,
      staleObserved,
    };
  }

  function respondAckResult(
    respond: GatewayRequestHandlerOptions['respond'],
    stale: boolean,
    result: { ok: true; movedToDeadLetter?: true; willRetry?: true },
  ) {
    respond(true, stale ? { ...result, stale: true, staleAccepted: true } : result);
  }

  function handleAckOutcome(args: {
    params: GatewayRequestHandlerOptions['params'];
    respond: GatewayRequestHandlerOptions['respond'];
    accountId: string;
    connId: string;
    clientId?: string;
    messageId: string;
    entry: OutboxEntry;
    staleObserved: { stale: boolean };
  }) {
    const { params, respond, accountId, connId, clientId, messageId, entry, staleObserved } = args;
    const ok = params?.ok !== false;
    const fatal = params?.fatal === true;

    if (ok) {
      runtime.handleAckOk({
        accountId,
        messageId,
        connId,
        clientId,
        stale: staleObserved.stale,
        entry,
      });
      respondAckResult(respond, staleObserved.stale, { ok: true });
      runtime.flushPushQueueBestEffort({
        accountId,
        trigger: runtime.outboundFlushTriggerAckOk,
        reason: runtime.outboundFlushReasonMessageAcked,
      });
      return;
    }

    if (fatal) {
      const error = runtime.asString(params?.error || 'fatal-ack');
      runtime.handleAckFatal({
        entry,
        messageId,
        connId,
        clientId,
        error,
      });
      respondAckResult(respond, staleObserved.stale, {
        ok: true,
        movedToDeadLetter: true,
      });
      return;
    }

    runtime.handleAckRetry({
      entry,
      messageId,
      connId,
      clientId,
      error: runtime.asString(params?.error || 'retryable-ack'),
    });

    respondAckResult(respond, staleObserved.stale, {
      ok: true,
      willRetry: true,
    });
  }

  return {
    clearAllMessageAckWaiters,
    resolveMessageAck,
    waitForMessageAck,
    prepareAckHandling,
    handleAckOutcome,
  };
}
