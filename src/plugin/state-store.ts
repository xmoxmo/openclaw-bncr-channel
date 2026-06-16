import {
  dumpRegisterDriftSnapshot,
  normalizeRegisterDriftSnapshot,
} from '../core/register-trace.ts';
import type { BncrRoute, OutboxEntry } from '../core/types.ts';
import {
  readOpenClawJsonFileWithFallback,
  writeOpenClawJsonFileAtomically,
} from '../openclaw/sdk-helpers.ts';
import type {
  BncrPersistedAccountTimestamp,
  BncrPersistedLastSession,
  BncrPersistedSessionRoute,
  PersistedState as BncrPersistedState,
} from './channel-runtime-types.ts';

type BncrPersistedStateStoreInput = {
  outbox?: unknown;
  deadLetter?: unknown;
  sessionRoutes?: unknown;
  lastSessionByAccount?: unknown;
  lastActivityByAccount?: unknown;
  lastInboundByAccount?: unknown;
  lastOutboundByAccount?: unknown;
  lastDriftSnapshot?: unknown;
};

type PersistedAccountTimestampInput = Partial<BncrPersistedAccountTimestamp>;
type PersistedLastSessionInput = Partial<BncrPersistedLastSession>;
type PersistedSessionRouteInput = Partial<BncrPersistedSessionRoute>;

export function createBncrStateStore(runtime: {
  getStatePath: () => string | null;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  finiteNumberOr: (value: unknown, fallback: number) => number;
  normalizeAccountId: (accountId: string) => string;
  normalizeStoredSessionKey: (
    sessionKey: string,
    canonicalAgentId?: string,
  ) => {
    sessionKey: string;
    route: BncrRoute;
  } | null;
  parseRouteLike: (value: unknown) => BncrRoute | null;
  routeKey: (accountId: string, route: BncrRoute) => string;
  formatDisplayScope: (route: BncrRoute) => string;
  canonicalAgentId: () => string;
  normalizePersistedOutboxEntry: (entry: unknown) => OutboxEntry | null;
  maxDeadLetterEntries: number;
  maxSessionRouteEntries: number;
  maxAccountActivityEntries: number;
  outbox: Map<string, OutboxEntry>;
  getDeadLetter: () => OutboxEntry[];
  setDeadLetter: (entries: OutboxEntry[]) => void;
  sessionRoutes: Map<string, { accountId: string; route: BncrRoute; updatedAt: number }>;
  routeAliases: Map<string, { accountId: string; route: BncrRoute; updatedAt: number }>;
  lastSessionByAccount: Map<string, { sessionKey: string; scope: string; updatedAt: number }>;
  lastActivityByAccount: Map<string, number>;
  lastInboundByAccount: Map<string, number>;
  lastOutboundByAccount: Map<string, number>;
  getLastDriftSnapshot: () => BncrPersistedState['lastDriftSnapshot'];
  setLastDriftSnapshot: (value: BncrPersistedState['lastDriftSnapshot']) => void;
}) {
  function loadPersistedAccountTimestampMap(target: Map<string, number>, persisted: unknown): void {
    target.clear();
    const items = Array.isArray(persisted)
      ? (persisted.slice(-runtime.maxAccountActivityEntries) as PersistedAccountTimestampInput[])
      : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const accountId = runtime.normalizeAccountId(runtime.asString(item.accountId || ''));
      const updatedAt = runtime.finiteNumberOr(item.updatedAt, 0);
      if (updatedAt <= 0) continue;
      target.set(accountId, updatedAt);
    }
  }

  function dumpPersistedAccountTimestampMap(source: Map<string, number>) {
    return Array.from(source.entries())
      .map(([accountId, updatedAt]) => ({
        accountId,
        updatedAt,
      }))
      .slice(-runtime.maxAccountActivityEntries);
  }

  function loadPersistedLastSessionMap(persisted: unknown): void {
    runtime.lastSessionByAccount.clear();
    const items = Array.isArray(persisted)
      ? (persisted.slice(-runtime.maxAccountActivityEntries) as PersistedLastSessionInput[])
      : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const accountId = runtime.normalizeAccountId(runtime.asString(item.accountId || ''));
      const normalized = runtime.normalizeStoredSessionKey(
        runtime.asString(item.sessionKey || ''),
        runtime.canonicalAgentId(),
      );
      const updatedAt = runtime.finiteNumberOr(item.updatedAt, 0);
      if (!normalized || updatedAt <= 0) continue;

      runtime.lastSessionByAccount.set(accountId, {
        sessionKey: normalized.sessionKey,
        scope: runtime.formatDisplayScope(normalized.route),
        updatedAt,
      });
    }
  }

  function dumpPersistedLastSessionMap() {
    return Array.from(runtime.lastSessionByAccount.entries())
      .map(([accountId, v]) => ({
        accountId,
        sessionKey: v.sessionKey,
        scope: v.scope,
        updatedAt: v.updatedAt,
      }))
      .slice(-runtime.maxAccountActivityEntries);
  }

  function loadPersistedSessionRoutes(persisted: unknown): void {
    runtime.sessionRoutes.clear();
    runtime.routeAliases.clear();
    const items = Array.isArray(persisted)
      ? (persisted.slice(-runtime.maxSessionRouteEntries) as PersistedSessionRouteInput[])
      : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const normalized = runtime.normalizeStoredSessionKey(
        runtime.asString(item.sessionKey || ''),
        runtime.canonicalAgentId(),
      );
      if (!normalized) continue;

      const route = runtime.parseRouteLike(item.route) || normalized.route;
      const accountId = runtime.normalizeAccountId(runtime.asString(item.accountId || ''));
      const updatedAt = runtime.finiteNumberOr(item.updatedAt, runtime.now());
      const info = { accountId, route, updatedAt };

      runtime.sessionRoutes.set(normalized.sessionKey, info);
      runtime.routeAliases.set(runtime.routeKey(accountId, route), info);
    }
  }

  function dumpPersistedSessionRoutes() {
    return Array.from(runtime.sessionRoutes.entries())
      .map(([sessionKey, v]) => ({
        sessionKey,
        accountId: v.accountId,
        route: v.route,
        updatedAt: v.updatedAt,
      }))
      .slice(-runtime.maxSessionRouteEntries);
  }

  function backfillAccountActivityFromSessionRoutes(): void {
    if (runtime.lastSessionByAccount.size > 0 || runtime.sessionRoutes.size === 0) return;

    for (const [sessionKey, info] of runtime.sessionRoutes.entries()) {
      const acc = runtime.normalizeAccountId(info.accountId);
      const updatedAt = runtime.finiteNumberOr(info.updatedAt, 0);
      if (updatedAt <= 0) continue;

      const current = runtime.lastSessionByAccount.get(acc);
      if (!current || updatedAt >= current.updatedAt) {
        runtime.lastSessionByAccount.set(acc, {
          sessionKey,
          scope: runtime.formatDisplayScope(info.route),
          updatedAt,
        });
      }

      const lastAct = runtime.lastActivityByAccount.get(acc) || 0;
      if (updatedAt > lastAct) runtime.lastActivityByAccount.set(acc, updatedAt);

      const lastIn = runtime.lastInboundByAccount.get(acc) || 0;
      if (updatedAt > lastIn) runtime.lastInboundByAccount.set(acc, updatedAt);
    }
  }

  async function loadState() {
    const statePath = runtime.getStatePath();
    if (!statePath) return;
    const loaded = await readOpenClawJsonFileWithFallback(statePath, {
      outbox: [],
      deadLetter: [],
      sessionRoutes: [],
    });
    const data = loaded.value as BncrPersistedStateStoreInput;

    runtime.outbox.clear();
    for (const entry of Array.isArray(data.outbox) ? data.outbox : []) {
      const migratedEntry = runtime.normalizePersistedOutboxEntry(entry);
      if (!migratedEntry) continue;
      runtime.outbox.set(migratedEntry.messageId, migratedEntry);
    }

    const deadLetter: OutboxEntry[] = [];
    const persistedDeadLetter = Array.isArray(data.deadLetter)
      ? data.deadLetter.slice(-runtime.maxDeadLetterEntries)
      : [];
    for (const entry of persistedDeadLetter) {
      const migratedEntry = runtime.normalizePersistedOutboxEntry(entry);
      if (!migratedEntry) continue;
      deadLetter.push(migratedEntry);
    }
    runtime.setDeadLetter(deadLetter);

    loadPersistedSessionRoutes(data.sessionRoutes);
    loadPersistedLastSessionMap(data.lastSessionByAccount);
    loadPersistedAccountTimestampMap(runtime.lastActivityByAccount, data.lastActivityByAccount);
    loadPersistedAccountTimestampMap(runtime.lastInboundByAccount, data.lastInboundByAccount);
    loadPersistedAccountTimestampMap(runtime.lastOutboundByAccount, data.lastOutboundByAccount);

    runtime.setLastDriftSnapshot(normalizeRegisterDriftSnapshot(data.lastDriftSnapshot));
    backfillAccountActivityFromSessionRoutes();
  }

  async function flushState() {
    const statePath = runtime.getStatePath();
    if (!statePath) return;

    const data: BncrPersistedState = {
      outbox: Array.from(runtime.outbox.values()),
      deadLetter: runtime.getDeadLetter().slice(-runtime.maxDeadLetterEntries),
      sessionRoutes: dumpPersistedSessionRoutes(),
      lastSessionByAccount: dumpPersistedLastSessionMap(),
      lastActivityByAccount: dumpPersistedAccountTimestampMap(runtime.lastActivityByAccount),
      lastInboundByAccount: dumpPersistedAccountTimestampMap(runtime.lastInboundByAccount),
      lastOutboundByAccount: dumpPersistedAccountTimestampMap(runtime.lastOutboundByAccount),
      lastDriftSnapshot: dumpRegisterDriftSnapshot(runtime.getLastDriftSnapshot() ?? null),
    };

    await writeOpenClawJsonFileAtomically(statePath, data);
  }

  return {
    loadPersistedAccountTimestampMap,
    dumpPersistedAccountTimestampMap,
    loadPersistedLastSessionMap,
    dumpPersistedLastSessionMap,
    loadPersistedSessionRoutes,
    dumpPersistedSessionRoutes,
    backfillAccountActivityFromSessionRoutes,
    loadState,
    flushState,
  };
}
