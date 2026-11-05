import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import {
  applySessionEntryPatch as sdkApplySessionEntryPatch,
  deleteSessionEntry as sdkDeleteSessionEntry,
  getSessionEntryAsync as sdkGetSessionEntryAsync,
  listSessionEntriesAsync as sdkListSessionEntriesAsync,
  prepareSessionEntryPatch as sdkPrepareSessionEntryPatch,
  readSessionUpdatedAtAsync as sdkReadSessionUpdatedAtAsync,
  recordSessionMetaFromInbound as sdkRecordSessionMetaFromInbound,
  resolveStorePath as sdkResolveStorePath,
} from 'openclaw/plugin-sdk/session-store-runtime';

type ResolveStorePathFn = (
  storeConfig?: string,
  options?: { agentId?: string; env?: NodeJS.ProcessEnv },
) => string;
type RecordInboundSessionFn =
  OpenClawPluginApi['runtime']['channel']['session']['recordInboundSession'];
type RecordSessionMetaFromInboundFn = typeof sdkRecordSessionMetaFromInbound;
type PrepareSessionEntryPatchFn = typeof sdkPrepareSessionEntryPatch;
type ApplySessionEntryPatchFn = typeof sdkApplySessionEntryPatch;
type GetSessionEntryAsyncFn = typeof sdkGetSessionEntryAsync;
type ReadSessionUpdatedAtAsyncFn = typeof sdkReadSessionUpdatedAtAsync;
type DeleteSessionEntryFn = typeof sdkDeleteSessionEntry;
type ListSessionEntriesAsyncFn = typeof sdkListSessionEntriesAsync;

type BncrInboundSessionRuntime = {
  resolveStorePath: ResolveStorePathFn;
  recordInboundSession: RecordInboundSessionFn;
  recordSessionMetaFromInbound: RecordSessionMetaFromInboundFn;
  prepareSessionEntryPatch: PrepareSessionEntryPatchFn;
  applySessionEntryPatch: ApplySessionEntryPatchFn;
  getSessionEntryAsync: GetSessionEntryAsyncFn;
  readSessionUpdatedAtAsync: ReadSessionUpdatedAtAsyncFn;
  deleteSessionEntry: DeleteSessionEntryFn;
  listSessionEntriesAsync: ListSessionEntriesAsyncFn;
};

type HostInboundSessionRuntime = Pick<BncrInboundSessionRuntime, 'recordInboundSession'>;

let hostRuntime: HostInboundSessionRuntime | null = null;
let testRuntimeOverride: Partial<BncrInboundSessionRuntime> | null = null;

function unavailableRecordInboundSession(): never {
  throw new Error('OpenClaw channel session recordInboundSession API is unavailable');
}

/** Bind the host-owned inbound-session runtime once per plugin API generation. */
export function configureBncrInboundSessionRuntime(api: Pick<OpenClawPluginApi, 'runtime'>): void {
  const recordInboundSession = api?.runtime?.channel?.session?.recordInboundSession;
  hostRuntime = typeof recordInboundSession === 'function' ? { recordInboundSession } : null;
}

function resolveRuntime(): BncrInboundSessionRuntime {
  return {
    resolveStorePath: testRuntimeOverride?.resolveStorePath ?? sdkResolveStorePath,
    recordInboundSession:
      testRuntimeOverride?.recordInboundSession ??
      hostRuntime?.recordInboundSession ??
      unavailableRecordInboundSession,
    recordSessionMetaFromInbound:
      testRuntimeOverride?.recordSessionMetaFromInbound ?? sdkRecordSessionMetaFromInbound,
    prepareSessionEntryPatch:
      testRuntimeOverride?.prepareSessionEntryPatch ?? sdkPrepareSessionEntryPatch,
    applySessionEntryPatch:
      testRuntimeOverride?.applySessionEntryPatch ?? sdkApplySessionEntryPatch,
    getSessionEntryAsync: testRuntimeOverride?.getSessionEntryAsync ?? sdkGetSessionEntryAsync,
    readSessionUpdatedAtAsync:
      testRuntimeOverride?.readSessionUpdatedAtAsync ?? sdkReadSessionUpdatedAtAsync,
    deleteSessionEntry: testRuntimeOverride?.deleteSessionEntry ?? sdkDeleteSessionEntry,
    listSessionEntriesAsync:
      testRuntimeOverride?.listSessionEntriesAsync ?? sdkListSessionEntriesAsync,
  };
}

export function resolveBncrInboundSessionStorePath(args: {
  storeConfig?: string;
  agentId: string;
}): string {
  return resolveRuntime().resolveStorePath(args.storeConfig, { agentId: args.agentId });
}

export function recordBncrInboundSession(
  params: Parameters<RecordInboundSessionFn>[0],
): ReturnType<RecordInboundSessionFn> {
  return resolveRuntime().recordInboundSession(params);
}

export function recordBncrSessionMetaFromInbound(
  params: Parameters<RecordSessionMetaFromInboundFn>[0],
): ReturnType<RecordSessionMetaFromInboundFn> {
  return resolveRuntime().recordSessionMetaFromInbound(params);
}

export function prepareBncrSessionEntryPatch(
  params: Parameters<PrepareSessionEntryPatchFn>[0],
): ReturnType<PrepareSessionEntryPatchFn> {
  return resolveRuntime().prepareSessionEntryPatch(params);
}

export function applyBncrSessionEntryPatch(
  params: Parameters<ApplySessionEntryPatchFn>[0],
): ReturnType<ApplySessionEntryPatchFn> {
  return resolveRuntime().applySessionEntryPatch(params);
}

export function readBncrSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): ReturnType<ReadSessionUpdatedAtAsyncFn> {
  return resolveRuntime().readSessionUpdatedAtAsync(params);
}

/** List public session metadata without opening a writable store lifecycle. */
export function listBncrSessionEntries(
  params: Parameters<ListSessionEntriesAsyncFn>[0],
): ReturnType<ListSessionEntriesAsyncFn> {
  return resolveRuntime().listSessionEntriesAsync(params);
}

/** Drop one host session without creating or migrating the inspected store. */
export function deleteBncrSessionEntry(params: {
  storePath: string;
  sessionKey: string;
  agentId?: string;
  /** Keep the session transcript file and only remove the store entry. */
  archiveTranscript?: boolean;
  expectedSessionId?: string | null;
  expectedUpdatedAt?: number;
}): ReturnType<DeleteSessionEntryFn> {
  return resolveRuntime().deleteSessionEntry(params);
}

export async function readBncrSessionEntry(params: {
  storePath: string;
  sessionKey: string;
}): Promise<Record<string, unknown> | undefined> {
  const runtime = resolveRuntime();
  try {
    const entry = await runtime.getSessionEntryAsync(params);
    return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Read one session entry without converting storage failures into a missing row. */
export async function readBncrSessionEntryStrict(params: {
  storePath: string;
  sessionKey: string;
}): Promise<Record<string, unknown> | undefined> {
  const entry = await resolveRuntime().getSessionEntryAsync(params);
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
}

/**
 * Derive a stable main-DM owner from one normalized allowlist entry.
 * Wildcards, multiple owners, and non-main DM scopes stay unpinned.
 */
export function resolveBncrPinnedMainDmOwnerFromAllowlist(params: {
  dmScope?: string | null;
  allowFrom?: Array<string | number> | null;
  normalizeEntry: (entry: string) => string | undefined;
}): string | null {
  if ((params.dmScope ?? 'main') !== 'main') return null;
  const rawAllowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : [];
  if (rawAllowFrom.some((entry) => String(entry).trim() === '*')) return null;
  const normalizedOwners = Array.from(
    new Set(
      rawAllowFrom
        .map((entry) => params.normalizeEntry(String(entry)))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
  return normalizedOwners.length === 1 ? normalizedOwners[0] : null;
}

export function setBncrInboundSessionRuntimeForTest(
  runtime: Partial<BncrInboundSessionRuntime> | null,
): () => void {
  const previous = testRuntimeOverride;
  testRuntimeOverride = runtime;
  return () => {
    testRuntimeOverride = previous;
  };
}
