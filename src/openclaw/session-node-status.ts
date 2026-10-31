import type { SessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

export type BncrSessionNodeStatus = {
  exists: boolean;
  /** Set when the operator archived this session from the UI. */
  archivedAt: number | null;
  /** Last store write for the session; the host refreshes it on activity. */
  updatedAt: number | null;
};

export type BncrSessionNodeEntry = { sessionKey: string; entry: SessionEntry };

function toTimeOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function classifyBncrSessionEntry(entry: SessionEntry | undefined): BncrSessionNodeStatus {
  if (!entry) return { exists: false, archivedAt: null, updatedAt: null };
  return {
    exists: true,
    archivedAt: toTimeOrNull(entry.archivedAt),
    updatedAt: toTimeOrNull(entry.updatedAt),
  };
}

/**
 * Build the sessionKey index for one agent.
 *
 * `undefined` means the answer cannot be trusted. The host SDK returns an empty
 * list both for "this agent has no sessions" and for a store it could not open,
 * so an empty answer must stay unknown: reading it as "every key is gone"
 * would turn every scene row into a prune target.
 */
export function buildBncrSessionNodeIndex(
  entries: readonly BncrSessionNodeEntry[] | undefined,
): Map<string, BncrSessionNodeStatus> | undefined {
  if (!entries || entries.length === 0) return undefined;
  const index = new Map<string, BncrSessionNodeStatus>();
  for (const { sessionKey, entry } of entries) {
    if (!sessionKey) continue;
    index.set(sessionKey, classifyBncrSessionEntry(entry));
  }
  return index.size > 0 ? index : undefined;
}
