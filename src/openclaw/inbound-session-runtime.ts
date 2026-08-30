import { recordInboundSession as sdkRecordInboundSession } from 'openclaw/plugin-sdk/conversation-runtime';
import { resolvePinnedMainDmOwnerFromAllowlist as sdkResolvePinnedMainDmOwnerFromAllowlist } from 'openclaw/plugin-sdk/security-runtime';
import {
  getSessionEntry as sdkGetSessionEntry,
  recordSessionMetaFromInbound as sdkRecordSessionMetaFromInbound,
  resolveStorePath as sdkResolveStorePath,
  updateSessionStoreEntry as sdkUpdateSessionStoreEntry,
} from 'openclaw/plugin-sdk/session-store-runtime';
import type { OpenClawChannelRuntimeApiHolder } from './channel-runtime-contracts.ts';

type ResolveStorePathFn = (
  storeConfig?: string,
  options?: { agentId?: string; env?: NodeJS.ProcessEnv },
) => string;
type RecordInboundSessionFn = typeof sdkRecordInboundSession;
type RecordSessionMetaFromInboundFn = typeof sdkRecordSessionMetaFromInbound;
type UpdateSessionStoreEntryFn = typeof sdkUpdateSessionStoreEntry;
type GetSessionEntryFn = typeof sdkGetSessionEntry;
type ReadSessionUpdatedAtFn = (params: { storePath: string; sessionKey: string }) => unknown;
type ResolvePinnedMainDmOwnerFromAllowlistFn = typeof sdkResolvePinnedMainDmOwnerFromAllowlist;

type BncrInboundSessionRuntime = {
  resolveStorePath: ResolveStorePathFn;
  recordInboundSession: RecordInboundSessionFn;
  recordSessionMetaFromInbound: RecordSessionMetaFromInboundFn;
  updateSessionStoreEntry: UpdateSessionStoreEntryFn;
  getSessionEntry: GetSessionEntryFn;
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
    getSessionEntry: testRuntimeOverride?.getSessionEntry ?? sdkGetSessionEntry,
    readSessionUpdatedAt: testRuntimeOverride?.readSessionUpdatedAt,
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
  params: Parameters<UpdateSessionStoreEntryFn>[0],
): ReturnType<UpdateSessionStoreEntryFn> {
  return resolveRuntime().updateSessionStoreEntry(params);
}

export function readBncrSessionUpdatedAt(
  api: OpenClawChannelRuntimeApiHolder,
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

export async function readBncrSessionEntry(params: {
  storePath: string;
  sessionKey: string;
}): Promise<Record<string, unknown> | undefined> {
  const runtime = resolveRuntime();
  try {
    const entry = await runtime.getSessionEntry(params);
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
