import { createBncrBridge } from '../../src/channel.ts';

export const TEST_SESSION_KEY = 'agent:orion:bncr:direct:demo';
export const TEST_ACCOUNT_ID = 'Primary';
export const TEST_ROUTE = { platform: 'tgBot', groupId: '-1001', userId: '10001' };

export function createApiStub(logs = null) {
  const currentConfig = {};
  return {
    logger: {
      info(scope, message) {
        logs?.push?.({ level: 'info', scope, message });
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
            return { sessionKey: TEST_SESSION_KEY, agentId: 'orion' };
          },
        },
      },
    },
  };
}

export function createBridge(logs = null) {
  return createBncrBridge(createApiStub(logs));
}

export function makeEntry(messageId, text = messageId) {
  return {
    messageId,
    accountId: TEST_ACCOUNT_ID,
    sessionKey: TEST_SESSION_KEY,
    route: { ...TEST_ROUTE },
    payload: {
      type: 'message.outbound',
      messageId,
      idempotencyKey: messageId,
      sessionKey: TEST_SESSION_KEY,
      message: {
        ...TEST_ROUTE,
        type: 'text',
        msg: text,
        path: '',
        base64: '',
        fileName: '',
      },
      ts: Date.now(),
    },
    createdAt: Date.now(),
    retryCount: 0,
    nextAttemptAt: Date.now(),
  };
}

export function cleanupBridge(bridge) {
  if (bridge.saveTimer) clearTimeout(bridge.saveTimer);
  if (bridge.pushTimer) clearTimeout(bridge.pushTimer);

  for (const waiter of bridge.messageAckWaiters?.values?.() || []) {
    clearTimeout(waiter.timer);
  }
  bridge.messageAckWaiters?.clear?.();

  for (const waiter of bridge.fileAckWaiters?.values?.() || []) {
    clearTimeout(waiter.timer);
  }
  bridge.fileAckWaiters?.clear?.();
}
