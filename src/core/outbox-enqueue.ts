import type { OutboxEntry } from './types.ts';

export function buildOutboxEnqueueDebugInfo(args: {
  bridgeId: string;
  entry: OutboxEntry;
  asString: (value: unknown) => string;
  formatDisplayScope: (route: OutboxEntry['route']) => string;
}) {
  const msg = (args.entry.payload as any)?.message || {};
  const type = args.asString(msg.type || (args.entry.payload as any)?.type || 'unknown');
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
