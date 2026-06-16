import type { RegisterDriftSnapshot } from '../core/register-trace.ts';
import type {
  BncrConnection,
  BncrRoute,
  FileRecvTransferState,
  FileSendTransferState,
  OutboxEntry,
} from '../core/types.ts';
import { createBncrStateStore } from './state-store.ts';
import { createBncrTransientStateRuntime } from './transient-state-runtime.ts';

type StoredRouteRecord = { accountId: string; route: BncrRoute; updatedAt: number };
type StoredLastSessionRecord = { sessionKey: string; scope: string; updatedAt: number };

export function createBncrStateTransientRuntimeGroup(runtime: {
  bridgeId: string;
  getStatePath: () => string | null;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  finiteNumberOr: (value: unknown, fallback: number) => number;
  normalizeAccountId: (accountId: string) => string;
  normalizeStoredSessionKey: (
    sessionKey: string,
    canonicalAgentId?: string,
  ) => { sessionKey: string; route: BncrRoute } | null;
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
  sessionRoutes: Map<string, StoredRouteRecord>;
  routeAliases: Map<string, StoredRouteRecord>;
  lastSessionByAccount: Map<string, StoredLastSessionRecord>;
  lastActivityByAccount: Map<string, number>;
  lastInboundByAccount: Map<string, number>;
  lastOutboundByAccount: Map<string, number>;
  getLastDriftSnapshot: () => RegisterDriftSnapshot | null | undefined;
  setLastDriftSnapshot: (value: RegisterDriftSnapshot | null | undefined) => void;
  connectTtlMs: number;
  fileTransferKeepMs: number;
  fileTransferTerminalKeepMs: number;
  fileTransferAckTtlMs: number;
  connections: Map<string, BncrConnection>;
  activeConnectionByAccount: Map<string, string>;
  recentInbound: Map<string, number>;
  fileSendTransfers: Map<string, FileSendTransferState>;
  fileRecvTransfers: Map<string, FileRecvTransferState>;
  earlyFileAcks: Map<string, { at: number }>;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
}) {
  const stateStore = createBncrStateStore({
    getStatePath: runtime.getStatePath,
    now: runtime.now,
    asString: runtime.asString,
    finiteNumberOr: runtime.finiteNumberOr,
    normalizeAccountId: runtime.normalizeAccountId,
    normalizeStoredSessionKey: runtime.normalizeStoredSessionKey,
    parseRouteLike: runtime.parseRouteLike,
    routeKey: runtime.routeKey,
    formatDisplayScope: runtime.formatDisplayScope,
    canonicalAgentId: runtime.canonicalAgentId,
    normalizePersistedOutboxEntry: runtime.normalizePersistedOutboxEntry,
    maxDeadLetterEntries: runtime.maxDeadLetterEntries,
    maxSessionRouteEntries: runtime.maxSessionRouteEntries,
    maxAccountActivityEntries: runtime.maxAccountActivityEntries,
    outbox: runtime.outbox,
    getDeadLetter: runtime.getDeadLetter,
    setDeadLetter: runtime.setDeadLetter,
    sessionRoutes: runtime.sessionRoutes,
    routeAliases: runtime.routeAliases,
    lastSessionByAccount: runtime.lastSessionByAccount,
    lastActivityByAccount: runtime.lastActivityByAccount,
    lastInboundByAccount: runtime.lastInboundByAccount,
    lastOutboundByAccount: runtime.lastOutboundByAccount,
    getLastDriftSnapshot: runtime.getLastDriftSnapshot,
    setLastDriftSnapshot: runtime.setLastDriftSnapshot,
  });

  const transientStateRuntime = createBncrTransientStateRuntime({
    now: runtime.now,
    connectTtlMs: runtime.connectTtlMs,
    fileTransferKeepMs: runtime.fileTransferKeepMs,
    fileTransferTerminalKeepMs: runtime.fileTransferTerminalKeepMs,
    fileTransferAckTtlMs: runtime.fileTransferAckTtlMs,
    connections: runtime.connections,
    activeConnectionByAccount: runtime.activeConnectionByAccount,
    recentInbound: runtime.recentInbound,
    fileSendTransfers: runtime.fileSendTransfers,
    fileRecvTransfers: runtime.fileRecvTransfers,
    earlyFileAcks: runtime.earlyFileAcks,
    logInfo: runtime.logInfo,
    bridgeId: runtime.bridgeId,
  });

  return {
    stateStore,
    transientStateRuntime,
  };
}
