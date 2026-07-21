export type LogDedupeStateEntry = {
  at: number;
  sig: string;
};

export type LogDedupeState = Map<string, LogDedupeStateEntry>;

const LOG_DEDUPE_STATE_TTL_MS = 10 * 60 * 1000;
const LOG_DEDUPE_STATE_MAX_ENTRIES = 1_000;

function pruneLogDedupeState(
  state: LogDedupeState,
  currentTime: number,
  options?: {
    ttlMs?: number;
    maxEntries?: number;
  },
) {
  const ttlMs = options?.ttlMs ?? LOG_DEDUPE_STATE_TTL_MS;
  const maxEntries = options?.maxEntries ?? LOG_DEDUPE_STATE_MAX_ENTRIES;

  for (const [key, entry] of state.entries()) {
    if (currentTime - entry.at > ttlMs) {
      state.delete(key);
    }
  }

  while (state.size > maxEntries) {
    const oldestKey = state.keys().next().value;
    if (!oldestKey) break;
    state.delete(oldestKey);
  }
}

export function shouldEmitDedupLog(args: {
  state: LogDedupeState;
  key: string;
  sig: string;
  nowMs: number;
  windowMs?: number;
  ttlMs?: number;
  maxEntries?: number;
}) {
  const windowMs = args.windowMs ?? 5 * 60 * 1000;
  const pruneOptions = {
    ttlMs: args.ttlMs,
    maxEntries: args.maxEntries,
  };

  pruneLogDedupeState(args.state, args.nowMs, pruneOptions);
  const prev = args.state.get(args.key) || null;
  if (prev && prev.sig === args.sig && args.nowMs - prev.at < windowMs) return false;
  args.state.set(args.key, { at: args.nowMs, sig: args.sig });
  pruneLogDedupeState(args.state, args.nowMs, pruneOptions);
  return true;
}
