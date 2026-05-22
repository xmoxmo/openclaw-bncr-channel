import type { OutboxEntry } from './types.ts';

export function summarizeOutboxEntry(args: {
  entry: OutboxEntry;
  asString: (value: unknown) => string;
  formatDisplayScope: (route: OutboxEntry['route']) => string;
  summarizeTextPreview: (raw: string, limit?: number) => string;
}) {
  const msg = (args.entry.payload as any)?.message || {};
  const type = args.asString(msg.type || (args.entry.payload as any)?.type || 'unknown');
  const text = args.asString(msg.msg || '');
  const preview = args.summarizeTextPreview(text);
  return [type, args.formatDisplayScope(args.entry.route), preview].join('|');
}
