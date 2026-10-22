import { recordInboundSession as sdkRecordInboundSession } from 'openclaw/plugin-sdk/conversation-runtime';
import { resolvePinnedMainDmOwnerFromAllowlist as sdkResolvePinnedMainDmOwnerFromAllowlist } from 'openclaw/plugin-sdk/security-runtime';
import {
  getSessionEntryAsync as sdkGetSessionEntryAsync,
  patchSessionEntry as sdkPatchSessionEntry,
  readSessionUpdatedAtAsync as sdkReadSessionUpdatedAtAsync,
  recordSessionMetaFromInbound as sdkRecordSessionMetaFromInbound,
  resolveStorePath as sdkResolveStorePath,
} from 'openclaw/plugin-sdk/session-store-runtime';

type ResolveStorePathFn = (
  storeConfig?: string,
  options?: { agentId?: string; env?: NodeJS.ProcessEnv },
) => string;
type RecordInboundSessionFn = typeof sdkRecordInboundSession;
type RecordSessionMetaFromInboundFn = typeof sdkRecordSessionMetaFromInbound;
type PatchSessionEntryFn = typeof sdkPatchSessionEntry;
type GetSessionEntryAsyncFn = typeof sdkGetSessionEntryAsync;
type ReadSessionUpdatedAtAsyncFn = typeof sdkReadSessionUpdatedAtAsync;
type ResolvePinnedMainDmOwnerFromAllowlistFn = typeof sdkResolvePinnedMainDmOwnerFromAllowlist;

type BncrInboundSessionRuntime = {
  resolveStorePath: ResolveStorePathFn;
  recordInboundSession: RecordInboundSessionFn;
  recordSessionMetaFromInbound: RecordSessionMetaFromInboundFn;
  patchSessionEntry: PatchSessionEntryFn;
  getSessionEntryAsync: GetSessionEntryAsyncFn;
  readSessionUpdatedAtAsync: ReadSessionUpdatedAtAsyncFn;
  resolvePinnedMainDmOwnerFromAllowlist: ResolvePinnedMainDmOwnerFromAllowlistFn;
};

let testRuntimeOverride: Partial<BncrInboundSessionRuntime> | null = null;

function resolveRuntime(): BncrInboundSessionRuntime {
  return {
    resolveStorePath: testRuntimeOverride?.resolveStorePath ?? sdkResolveStorePath,
    recordInboundSession: testRuntimeOverride?.recordInboundSession ?? sdkRecordInboundSession,
    recordSessionMetaFromInbound:
      testRuntimeOverride?.recordSessionMetaFromInbound ?? sdkRecordSessionMetaFromInbound,
    patchSessionEntry: testRuntimeOverride?.patchSessionEntry ?? sdkPatchSessionEntry,
    getSessionEntryAsync: testRuntimeOverride?.getSessionEntryAsync ?? sdkGetSessionEntryAsync,
    readSessionUpdatedAtAsync:
      testRuntimeOverride?.readSessionUpdatedAtAsync ?? sdkReadSessionUpdatedAtAsync,
    resolvePinnedMainDmOwnerFromAllowlist:
      testRuntimeOverride?.resolvePinnedMainDmOwnerFromAllowlist ??
      sdkResolvePinnedMainDmOwnerFromAllowlist,
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

export function updateBncrSessionStoreEntry(
  params: Parameters<PatchSessionEntryFn>[0],
): ReturnType<PatchSessionEntryFn> {
  return resolveRuntime().patchSessionEntry(params);
}

export function readBncrSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): ReturnType<ReadSessionUpdatedAtAsyncFn> {
  return resolveRuntime().readSessionUpdatedAtAsync(params);
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

export function resolveBncrPinnedMainDmOwnerFromAllowlist(
  params: Parameters<ResolvePinnedMainDmOwnerFromAllowlistFn>[0],
): ReturnType<ResolvePinnedMainDmOwnerFromAllowlistFn> {
  return resolveRuntime().resolvePinnedMainDmOwnerFromAllowlist(params);
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
