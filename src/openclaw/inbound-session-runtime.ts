import { recordInboundSession as sdkRecordInboundSession } from 'openclaw/plugin-sdk/conversation-runtime';
import { resolvePinnedMainDmOwnerFromAllowlist as sdkResolvePinnedMainDmOwnerFromAllowlist } from 'openclaw/plugin-sdk/security-runtime';
import {
  recordSessionMetaFromInbound as sdkRecordSessionMetaFromInbound,
  resolveStorePath as sdkResolveStorePath,
  updateSessionStoreEntry as sdkUpdateSessionStoreEntry,
} from 'openclaw/plugin-sdk/session-store-runtime';

type ResolveStorePathFn = (storeConfig: unknown, options: { agentId: string }) => string;
type RecordInboundSessionFn = typeof sdkRecordInboundSession;
type RecordSessionMetaFromInboundFn = typeof sdkRecordSessionMetaFromInbound;
type UpdateSessionStoreEntryFn = typeof sdkUpdateSessionStoreEntry;
type ReadSessionUpdatedAtFn = (params: { storePath: string; sessionKey: string }) => unknown;
type ResolvePinnedMainDmOwnerFromAllowlistFn = typeof sdkResolvePinnedMainDmOwnerFromAllowlist;

type BncrInboundSessionRuntime = {
  resolveStorePath: ResolveStorePathFn;
  recordInboundSession: RecordInboundSessionFn;
  recordSessionMetaFromInbound: RecordSessionMetaFromInboundFn;
  updateSessionStoreEntry: UpdateSessionStoreEntryFn;
  readSessionUpdatedAt?: ReadSessionUpdatedAtFn;
  resolvePinnedMainDmOwnerFromAllowlist: ResolvePinnedMainDmOwnerFromAllowlistFn;
};

let testRuntimeOverride: Partial<BncrInboundSessionRuntime> | null = null;

function resolveRuntime(): BncrInboundSessionRuntime {
  return {
    resolveStorePath: testRuntimeOverride?.resolveStorePath ?? sdkResolveStorePath,
    recordInboundSession: testRuntimeOverride?.recordInboundSession ?? sdkRecordInboundSession,
    recordSessionMetaFromInbound:
      testRuntimeOverride?.recordSessionMetaFromInbound ?? sdkRecordSessionMetaFromInbound,
    updateSessionStoreEntry:
      testRuntimeOverride?.updateSessionStoreEntry ?? sdkUpdateSessionStoreEntry,
    readSessionUpdatedAt: testRuntimeOverride?.readSessionUpdatedAt,
    resolvePinnedMainDmOwnerFromAllowlist:
      testRuntimeOverride?.resolvePinnedMainDmOwnerFromAllowlist ??
      sdkResolvePinnedMainDmOwnerFromAllowlist,
  };
}

export function resolveBncrInboundSessionStorePath(args: {
  storeConfig: unknown;
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
  params: Parameters<UpdateSessionStoreEntryFn>[0],
): ReturnType<UpdateSessionStoreEntryFn> {
  return resolveRuntime().updateSessionStoreEntry(params);
}

export function readBncrSessionUpdatedAt(
  api: { runtime?: { channel?: { session?: { readSessionUpdatedAt?: ReadSessionUpdatedAtFn } } } },
  params: { storePath: string; sessionKey: string },
): unknown {
  const runtime = resolveRuntime();
  if (runtime.readSessionUpdatedAt) return runtime.readSessionUpdatedAt(params);
  const readSessionUpdatedAt = api?.runtime?.channel?.session?.readSessionUpdatedAt;
  if (typeof readSessionUpdatedAt !== 'function') {
    throw new Error('OpenClaw channel session readSessionUpdatedAt API is unavailable');
  }
  return readSessionUpdatedAt(params);
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
