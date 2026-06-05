import { buildPushFailureArgs } from './outbox-push-args.ts';
import type { OutboxEntry } from './types.ts';

export function buildTextPushFailureArgs(args: { entry: OutboxEntry }) {
  return buildPushFailureArgs({
    entry: args.entry,
  });
}
