import { emitBncrLogLine } from '../../core/logging.ts';

export type ConversationHistorySerialPhase =
  | 'queued'
  | 'running'
  | 'snapshot'
  | 'shard_created'
  | 'upload_start'
  | 'upload_end'
  | 'cache_delete_start'
  | 'cache_delete_done'
  | 'lock_clear_start'
  | 'lock_clear_done'
  | 'abandoned';

export type ConversationHistorySerialState = {
  historyKey: string;
  owner?: string;
  phase: ConversationHistorySerialPhase;
  updatedAt: number;
  snapshotMessageIds: string[];
  cacheKey?: string;
  uploadCompleted: boolean;
  abandoned: boolean;
};

export type ConversationHistorySerialHandle = {
  phase: (
    phase: ConversationHistorySerialPhase,
    data?: { snapshotMessageIds?: string[]; cacheKey?: string },
  ) => void;
  setCleanup: (cleanup: () => void) => void;
  isAbandoned: () => boolean;
  owner: () => string;
};

type BncrConversationHistorySerialEntry = {
  chain: Promise<void>;
  abort: (reason?: unknown) => void;
  state: ConversationHistorySerialState;
  cleanup?: () => void;
};

const bncrConversationHistoryChains = new Map<string, BncrConversationHistorySerialEntry[]>();
let bncrConversationHistorySerialOwner = 'default';

export function setConversationHistorySerialOwner(owner: string): void {
  bncrConversationHistorySerialOwner = String(owner || '').trim() || 'default';
}

export function getConversationHistorySerialOwner(): string {
  return bncrConversationHistorySerialOwner;
}

function createConversationHistorySerialHandle(entry?: BncrConversationHistorySerialEntry) {
  return {
    phase: (
      phase: ConversationHistorySerialPhase,
      data?: { snapshotMessageIds?: string[]; cacheKey?: string },
    ) => {
      if (!entry) return;
      entry.state.phase = phase;
      entry.state.updatedAt = Date.now();
      if (data?.snapshotMessageIds) {
        entry.state.snapshotMessageIds = data.snapshotMessageIds
          .map((messageId) => String(messageId || '').trim())
          .filter(Boolean);
      }
      if (data?.cacheKey) entry.state.cacheKey = data.cacheKey;
      if (phase === 'upload_end') entry.state.uploadCompleted = true;
    },
    setCleanup: (cleanup: () => void) => {
      if (entry) entry.cleanup = cleanup;
    },
    isAbandoned: () => {
      if (!entry) return false;
      return (
        entry.state.abandoned === true ||
        (Boolean(entry.state.owner) && entry.state.owner !== bncrConversationHistorySerialOwner)
      );
    },
    owner: () => entry?.state.owner || bncrConversationHistorySerialOwner,
  };
}

function isUploadCompletedPhase(state: ConversationHistorySerialState): boolean {
  return state.uploadCompleted === true;
}

export async function runConversationHistorySerial<T>(
  historyKey: string,
  task: (handle: ConversationHistorySerialHandle) => Promise<T> | T,
  meta?: { to?: string | null; debugEnabled?: boolean; owner?: string },
) {
  const key = String(historyKey || '').trim();
  if (!key) return await task(createConversationHistorySerialHandle());

  const serialEntries = bncrConversationHistoryChains.get(key) || [];
  const previous = serialEntries.at(-1)?.chain || Promise.resolve();
  // A task with no predecessor has already acquired the serial slot even before
  // its first microtask runs. Stale-lock cleanup must be able to distinguish
  // that active slot from genuinely queued work behind an earlier lock.
  const hasPredecessor = serialEntries.length > 0;
  let release!: () => void;
  let abort!: (reason?: unknown) => void;
  const current = new Promise<void>((resolve, reject) => {
    release = resolve;
    abort = reject;
  });
  const chain = previous.then(
    () => current,
    () => current,
  );
  const serialEntry: BncrConversationHistorySerialEntry = {
    chain,
    abort,
    state: {
      historyKey: key,
      owner: meta?.owner || bncrConversationHistorySerialOwner,
      phase: hasPredecessor ? 'queued' : 'running',
      updatedAt: Date.now(),
      snapshotMessageIds: [],
      uploadCompleted: false,
      abandoned: false,
    },
  };
  const handle = createConversationHistorySerialHandle(serialEntry);
  serialEntries.push(serialEntry);
  bncrConversationHistoryChains.set(key, serialEntries);

  const debugGate = () => meta?.debugEnabled === true;
  emitBncrLogLine(
    'info',
    `[bncr] conversation-history-serial queued|key=${key}|to=${String(meta?.to || '-')}`,
    { debugOnly: true },
    debugGate,
  );
  try {
    await previous.catch(() => {});
    emitBncrLogLine(
      'info',
      `[bncr] conversation-history-serial acquired|key=${key}|to=${String(meta?.to || '-')}`,
      { debugOnly: true },
      debugGate,
    );
    if (serialEntry.state.abandoned) {
      return undefined as T;
    }
    serialEntry.state.phase = 'running';
    serialEntry.state.updatedAt = Date.now();
    return await task(handle);
  } finally {
    emitBncrLogLine(
      'info',
      `[bncr] conversation-history-serial lock-clear-start|key=${key}|phase=${serialEntry.state.phase}`,
      { debugOnly: true },
      debugGate,
    );
    serialEntry.state.phase = 'lock_clear_start';
    serialEntry.state.updatedAt = Date.now();
    release();
    serialEntry.state.phase = 'lock_clear_done';
    serialEntry.state.updatedAt = Date.now();
    const currentEntries = bncrConversationHistoryChains.get(key);
    if (currentEntries) {
      const entryIndex = currentEntries.indexOf(serialEntry);
      if (entryIndex >= 0) currentEntries.splice(entryIndex, 1);
      if (currentEntries.length === 0) bncrConversationHistoryChains.delete(key);
    }
    emitBncrLogLine(
      'info',
      `[bncr] conversation-history-serial lock-clear-done|key=${key}|phase=${serialEntry.state.phase}`,
      { debugOnly: true },
      debugGate,
    );
  }
}

export function clearConversationHistorySerialLocks(reason = 'runtime-restart', owner?: string) {
  bncrConversationHistorySerialOwner =
    owner || `${reason}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
  const staleEntries = Array.from(bncrConversationHistoryChains.values()).flat();
  const staleCount = staleEntries.length;
  for (const entry of staleEntries) {
    if (entry.state.phase === 'queued') {
      // Queued work is intentionally preserved after a hot rebuild; give it
      // the new instance owner so it is not treated as stale when it runs.
      entry.state.owner = bncrConversationHistorySerialOwner;
    }
    // Upload-completed locks can safely finish snapshot cleanup before being abandoned.
    // Locks still uploading cannot prove delivery, so their local cache is preserved.
    if (isUploadCompletedPhase(entry.state) && entry.cleanup) {
      try {
        entry.cleanup();
      } catch (err) {
        emitBncrLogLine(
          'warn',
          `[bncr] conversation-history-serial stale cleanup failed|key=${entry.state.historyKey}|reason=${String(err)}`,
        );
      }
    }
    // Started locks are abandoned but remain in the chain as a barrier. A hot
    // rebuild must not let new tasks run while the old upload still owns state;
    // once the old task releases its lock it leaves the map and new work runs.
    if (entry.state.phase !== 'queued') {
      entry.state.abandoned = true;
      entry.state.phase = 'abandoned';
      entry.state.updatedAt = Date.now();
    }
  }
  // Do not clear the chain map here. Abandoned started entries stay visible to
  // readConversationHistorySerialHistoryKeys so shard recovery and the worker
  // will not race them.
  if (staleCount > 0) {
    emitBncrLogLine(
      'warn',
      `[bncr] conversation-history-serial settled stale locks|count=${staleCount}|reason=${reason}`,
    );
  }
  return staleCount;
}

export function readConversationHistorySerialStates(): readonly ConversationHistorySerialState[] {
  return Array.from(bncrConversationHistoryChains.values()).flatMap((entries) =>
    entries.map((entry) => ({
      historyKey: entry.state.historyKey,
      ...(entry.state.owner ? { owner: entry.state.owner } : {}),
      phase: entry.state.phase,
      updatedAt: entry.state.updatedAt,
      snapshotMessageIds: [...entry.state.snapshotMessageIds],
      ...(entry.state.cacheKey ? { cacheKey: entry.state.cacheKey } : {}),
      uploadCompleted: entry.state.uploadCompleted,
      abandoned: entry.state.abandoned,
    })),
  );
}

export function readConversationHistorySerialHistoryKeys(): string[] {
  return Array.from(bncrConversationHistoryChains.keys()).filter(
    (historyKey) => (bncrConversationHistoryChains.get(historyKey)?.length ?? 0) > 0,
  );
}

export function resetConversationHistorySerialForTest() {
  setConversationHistorySerialOwner('default');
  clearConversationHistorySerialLocks('test');
  // Tests must never inherit queued chains from an earlier test. Runtime
  // restarts deliberately keep queued work in the serial chain, so only the
  // test helper fully abandons those entries as well.
  for (const entry of Array.from(bncrConversationHistoryChains.values()).flat()) {
    entry.state.abandoned = true;
    entry.state.phase = 'abandoned';
    entry.state.updatedAt = Date.now();
    entry.chain.catch(() => {});
    entry.abort(new Error('conversation-history-serial test reset'));
  }
  bncrConversationHistoryChains.clear();
}
