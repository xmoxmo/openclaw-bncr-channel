import type { OutboxEntry } from './types.ts';

type OutboxEnqueueMessage = {
  type?: unknown;
  msg?: unknown;
};

type OutboxEnqueuePayload = {
  type?: unknown;
  message?: OutboxEnqueueMessage;
};

export function buildOutboxEnqueueDebugInfo(args: {
  bridgeId: string;
  entry: OutboxEntry;
  asString: (value: unknown) => string;
  formatDisplayScope: (route: OutboxEntry['route']) => string;
}) {
  const payload = args.entry.payload as OutboxEnqueuePayload;
  const msg = payload?.message || {};
  const type = args.asString(msg.type || payload?.type || 'unknown');
  const text = args.asString(msg.msg || '');
  return {
    bridge: args.bridgeId,
    messageId: args.entry.messageId,
    accountId: args.entry.accountId,
    sessionKey: args.entry.sessionKey,
    scope: args.formatDisplayScope(args.entry.route),
    type,
    textLen: text.length,
    textPreview: text.slice(0, 120),
  };
}
