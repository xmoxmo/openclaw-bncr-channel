import { normalizeAccountId } from '../core/accounts.ts';
import type { OutboxEntry } from '../core/types.ts';

function getCounter(map: Map<string, number>, accountId: string): number {
  return map.get(normalizeAccountId(accountId)) || 0;
}

export function buildRuntimeQueueSnapshot(args: {
  accountId: string;
  outboxEntries: Iterable<OutboxEntry>;
  deadLetterEntries: Iterable<OutboxEntry>;
  sessionRouteEntries: Iterable<{ accountId: string }>;
  countInvalidOutboxSessionKeys: (accountId: string) => number;
  countLegacyAccountResidue: (accountId: string) => number;
}) {
  const accountId = normalizeAccountId(args.accountId);
  const pending = Array.from(args.outboxEntries).filter((v) => v.accountId === accountId).length;
  const deadLetter = Array.from(args.deadLetterEntries).filter(
    (v) => v.accountId === accountId,
  ).length;
  const sessionRoutesCount = Array.from(args.sessionRouteEntries).filter(
    (v) => v.accountId === accountId,
  ).length;
  return {
    pending,
    deadLetter,
    sessionRoutesCount,
    invalidOutboxSessionKeys: args.countInvalidOutboxSessionKeys(accountId),
    legacyAccountResidue: args.countLegacyAccountResidue(accountId),
  };
}

export function buildRuntimeEventCounters(args: {
  accountId: string;
  connectEventsByAccount: Map<string, number>;
  inboundEventsByAccount: Map<string, number>;
  activityEventsByAccount: Map<string, number>;
  ackEventsByAccount: Map<string, number>;
}) {
  const accountId = normalizeAccountId(args.accountId);
  return {
    connectEvents: getCounter(args.connectEventsByAccount, accountId),
    inboundEvents: getCounter(args.inboundEventsByAccount, accountId),
    activityEvents: getCounter(args.activityEventsByAccount, accountId),
    ackEvents: getCounter(args.ackEventsByAccount, accountId),
  };
}

function nullableMapNumber(map: Map<string, number>, key: string): number | null {
  return map.get(key) ?? null;
}

export function buildRuntimeActivitySnapshot(args: {
  accountId: string;
  activeConnectionCount: (accountId: string) => number;
  lastSessionByAccount: Map<string, { sessionKey: string; scope: string; updatedAt: number }>;
  lastActivityByAccount: Map<string, number>;
  lastInboundByAccount: Map<string, number>;
  lastOutboundByAccount: Map<string, number>;
}) {
  const accountId = normalizeAccountId(args.accountId);
  return {
    activeConnections: args.activeConnectionCount(accountId),
    lastSession: args.lastSessionByAccount.get(accountId) || null,
    lastActivityAt: nullableMapNumber(args.lastActivityByAccount, accountId),
    lastInboundAt: nullableMapNumber(args.lastInboundByAccount, accountId),
    lastOutboundAt: nullableMapNumber(args.lastOutboundByAccount, accountId),
  };
}

export function buildRuntimeStatusSnapshots(args: {
  accountId: string;
  outboxEntries: Iterable<OutboxEntry>;
  deadLetterEntries: Iterable<OutboxEntry>;
  sessionRouteEntries: Iterable<{ accountId: string }>;
  countInvalidOutboxSessionKeys: (accountId: string) => number;
  countLegacyAccountResidue: (accountId: string) => number;
  connectEventsByAccount: Map<string, number>;
  inboundEventsByAccount: Map<string, number>;
  activityEventsByAccount: Map<string, number>;
  ackEventsByAccount: Map<string, number>;
  activeConnectionCount: (accountId: string) => number;
  lastSessionByAccount: Map<string, { sessionKey: string; scope: string; updatedAt: number }>;
  lastActivityByAccount: Map<string, number>;
  lastInboundByAccount: Map<string, number>;
  lastOutboundByAccount: Map<string, number>;
}) {
  const accountId = normalizeAccountId(args.accountId);
  return {
    queueSnapshot: buildRuntimeQueueSnapshot({
      accountId,
      outboxEntries: args.outboxEntries,
      deadLetterEntries: args.deadLetterEntries,
      sessionRouteEntries: args.sessionRouteEntries,
      countInvalidOutboxSessionKeys: args.countInvalidOutboxSessionKeys,
      countLegacyAccountResidue: args.countLegacyAccountResidue,
    }),
    eventCounters: buildRuntimeEventCounters({
      accountId,
      connectEventsByAccount: args.connectEventsByAccount,
      inboundEventsByAccount: args.inboundEventsByAccount,
      activityEventsByAccount: args.activityEventsByAccount,
      ackEventsByAccount: args.ackEventsByAccount,
    }),
    activitySnapshot: buildRuntimeActivitySnapshot({
      accountId,
      activeConnectionCount: args.activeConnectionCount,
      lastSessionByAccount: args.lastSessionByAccount,
      lastActivityByAccount: args.lastActivityByAccount,
      lastInboundByAccount: args.lastInboundByAccount,
      lastOutboundByAccount: args.lastOutboundByAccount,
    }),
  };
}
