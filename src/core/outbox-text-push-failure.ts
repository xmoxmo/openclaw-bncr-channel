import type { OutboxEntry } from './types.ts';
import { buildPushFailureArgs } from './outbox-push-args.ts';

export function buildTextPushFailureArgs(args: {
  entry: OutboxEntry;
}) {
  return buildPushFailureArgs({
    entry: args.entry,
  });
}
