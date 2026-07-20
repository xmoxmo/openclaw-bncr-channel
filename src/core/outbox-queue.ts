import type { OutboxEntry } from './types.ts';

export function buildDeadLetterEntry(entry: OutboxEntry, reason: string): OutboxEntry {
  return {
    ...entry,
    lastError: reason,
  };
}

export function appendDeadLetter(args: {
  deadLetter: OutboxEntry[];
  entry: OutboxEntry;
  maxEntries: number;
}): OutboxEntry[] {
  const next = [...args.deadLetter, args.entry];
  if (next.length <= args.maxEntries) return next;
  return next.slice(-args.maxEntries);
}

export function collectDueOutboxEntries(args: {
  outbox: Iterable<OutboxEntry>;
  accountId: string;
  now: number;
  maxBatch: number;
  maxRetry: number;
  backoffMs: (retryCount: number) => number;
}): {
  duePayloads: Array<Record<string, unknown>>;
  updatedEntries: OutboxEntry[];
  deadLetterEntries: OutboxEntry[];
} {
  const duePayloads: Array<Record<string, unknown>> = [];
  const updatedEntries: OutboxEntry[] = [];
  const deadLetterEntries: OutboxEntry[] = [];

  for (const originalEntry of args.outbox) {
    if (originalEntry.accountId !== args.accountId) continue;
    if (originalEntry.nextAttemptAt > args.now) continue;

    const nextAttempt = originalEntry.retryCount + 1;
    if (nextAttempt > args.maxRetry) {
      deadLetterEntries.push(buildDeadLetterEntry(originalEntry, 'retry-limit'));
      continue;
    }

    const updatedEntry: OutboxEntry = {
      ...originalEntry,
      retryCount: nextAttempt,
      lastAttemptAt: args.now,
      nextAttemptAt: args.now + args.backoffMs(nextAttempt),
    };
    updatedEntries.push(updatedEntry);
    duePayloads.push(updatedEntry.payload);

    if (duePayloads.length >= args.maxBatch) break;
  }

  return {
    duePayloads,
    updatedEntries,
    deadLetterEntries,
  };
}
