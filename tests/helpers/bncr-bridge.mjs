import { createBncrBridge } from '../../src/channel.ts';

export const TEST_SESSION_KEY = 'agent:orion:bncr:direct:demo';
export const TEST_ACCOUNT_ID = 'Primary';
export const TEST_ROUTE = { platform: 'tgBot', groupId: '-1001', userId: '10001' };

export function createApiStub(logs = null) {
  const options = logs && typeof logs === 'object' && !Array.isArray(logs) ? logs : {};
  const sink = Array.isArray(logs) ? logs : options.logs || null;
  const currentConfig = {};
  return {
    logger: {
      info(scope, message) {
        sink?.push?.({ level: 'info', scope, message });
      },
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {
      config: {
        current() {
          return currentConfig;
        },
        get() {
          return currentConfig;
        },
        async loadConfig() {
          return currentConfig;
        },
      },
      channel: {
        routing: {
          resolveAgentRoute() {
            return options.routeResult || { sessionKey: TEST_SESSION_KEY, agentId: 'orion' };
          },
        },
      },
    },
    ...(options.apiOverrides || {}),
  };
}

export function createBridge(logs = null, options = {}) {
  return createBncrBridge(createApiStub(Array.isArray(logs) ? { ...options, logs } : logs));
}

export function makeEntry(messageId, text = messageId, overrides = {}) {
  return {
    messageId,
    accountId: overrides.accountId || TEST_ACCOUNT_ID,
    sessionKey: overrides.sessionKey || TEST_SESSION_KEY,
    route: { ...TEST_ROUTE, ...(overrides.routePatch || {}) },
    payload: {
      type: 'message.outbound',
      messageId,
      idempotencyKey: messageId,
      sessionKey: overrides.sessionKey || TEST_SESSION_KEY,
      message: {
        ...TEST_ROUTE,
        type: 'text',
        msg: text,
        path: '',
        base64: '',
        fileName: '',
      },
      ...(overrides.payloadPatch || {}),
      ts: Date.now(),
    },
    createdAt: overrides.createdAt ?? Date.now(),
    retryCount: 0,
    nextAttemptAt: Date.now(),
    ...(overrides.entryPatch || {}),
  };
}

export function settleBridgeTimers() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function setGatewayContextRecorder(bridge, sink) {
  bridge.gatewayContext = {
    broadcastToConnIds(event, payload, connIds) {
      sink.push({ event, payload, connIds: Array.from(connIds) });
    },
  };
  return sink;
}

export function cleanupBridge(bridge) {
  bridge.stopped = true;

  if (bridge.saveTimer) {
    clearTimeout(bridge.saveTimer);
    bridge.saveTimer = null;
  }
  if (bridge.pushTimer) {
    clearTimeout(bridge.pushTimer);
    bridge.pushTimer = null;
  }

  for (const waiter of bridge.messageAckWaiters?.values?.() || []) {
    clearTimeout(waiter.timer);
  }
  bridge.messageAckWaiters?.clear?.();

  for (const waiter of bridge.fileAckWaiters?.values?.() || []) {
    clearTimeout(waiter.timer);
  }
  bridge.fileAckWaiters?.clear?.();

  bridge.earlyFileAckCache?.clear?.();
  bridge.fileTransfers?.clear?.();
}
