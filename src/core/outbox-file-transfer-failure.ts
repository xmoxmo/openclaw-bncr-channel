/*
 * Intentionally separate from outbox-text-push-failure.ts.
 * File transfer failure adds retryable-state resolution logic
 * that text push doesn't need (no chunk-level retry semantics).
 */
import { buildPushFailureArgs } from './outbox-push-args.ts';
import type { OutboxEntry } from './types.ts';

export function resolveFileTransferFailureState(args: {
  entry: OutboxEntry;
  error: unknown;
  isRetryableFileTransferError: (error: unknown) => boolean;
}) {
  const retryable = args.isRetryableFileTransferError(args.error);
  return {
    retryable,
    deadLetterReason: args.entry.lastError || 'file-transfer-failed',
  };
}

export function buildFileTransferPushFailureArgs(args: { entry: OutboxEntry; retryable: boolean }) {
  return buildPushFailureArgs({
    entry: args.entry,
    retryable: args.retryable,
    kind: 'file-transfer',
  });
}
