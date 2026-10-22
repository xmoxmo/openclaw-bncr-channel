import { normalizeAccountId } from './accounts.ts';
import { parseStrictBncrSessionKey } from './targets.ts';
import type { OutboxEntry } from './types.ts';

export type AccountResidueSessionRoute = { accountId?: string | null };

function hasMismatchedAccountId(raw: unknown, expectedAccountId: string): boolean {
  const text = String(raw || '').trim();
  return Boolean(text) && normalizeAccountId(text) !== expectedAccountId;
}

export function countInvalidOutboxSessionKeys(args: {
  accountId: string;
  outboxEntries: Iterable<OutboxEntry>;
}): number {
  const accountId = normalizeAccountId(args.accountId);
  let count = 0;
  for (const entry of args.outboxEntries) {
    if (normalizeAccountId(entry.accountId) !== accountId) continue;
    if (!parseStrictBncrSessionKey(entry.sessionKey)) count += 1;
  }
  return count;
}

/**
 * Legacy-account residue is counted on delivery/routing truth only (outbox, dead letter,
 * session routes). The lastSession/lastActivity/lastInbound/lastOutbound diagnostic
 * timestamp maps never drive delivery; legacy keys in them are not delivery risk, so
 * they are excluded from residue (one-shot startup alias normalization keeps the stored
 * truth tables canonical).
 */
export function countLegacyAccountResidue(args: {
  accountId: string;
  outboxEntries: Iterable<Pick<OutboxEntry, 'accountId'>>;
  deadLetterEntries: Iterable<Pick<OutboxEntry, 'accountId'>>;
  sessionRoutes: Iterable<AccountResidueSessionRoute>;
}): number {
  const accountId = normalizeAccountId(args.accountId);
  let count = 0;

  for (const entry of args.outboxEntries) {
    if (hasMismatchedAccountId(entry.accountId, accountId)) count += 1;
  }
  for (const entry of args.deadLetterEntries) {
    if (hasMismatchedAccountId(entry.accountId, accountId)) count += 1;
  }
  for (const info of args.sessionRoutes) {
    if (hasMismatchedAccountId(info.accountId, accountId)) count += 1;
  }

  return count;
}
