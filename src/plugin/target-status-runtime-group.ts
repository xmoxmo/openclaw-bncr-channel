import type {
  BncrAckObservability,
  BncrAckStrategy,
  BncrRoute,
  BncrRuntimeLastSession,
  OutboxEntry,
} from '../core/types.ts';
import type { MediaDedupeCacheEntry } from '../messaging/outbound/media-dedupe.ts';
import type { getOpenClawRuntimeConfigOrDefault } from '../openclaw/config-runtime.ts';
import type { BncrChannelConfigRoot } from './channel-runtime-types.ts';
import { createBncrMediaDedupeRuntime } from './media-dedupe-runtime.ts';
import { createBncrStatusRuntime } from './status-runtime.ts';
import { createBncrTargetRuntime } from './target-runtime.ts';

export function createBncrTargetStatusRuntimeGroup(runtime: {
  api: Parameters<typeof getOpenClawRuntimeConfigOrDefault>[0];
  channelId: string;
  canonicalAgentId: string | null;
  getPluginRoot: () => string | null;
  startedAt: number;
  debugVerbose: boolean;
  adaptiveAckTimeoutEnabled: boolean;
  defaultMessageAckTimeoutMs: number;
  fileAckTimeoutMs: number;
  maxAckTimeoutMs: number;
  now: () => number;
  normalizeAccountId: (accountId: string) => string;
  sessionRoutes: Map<string, { accountId: string; route: BncrRoute; updatedAt: number }>;
  routeAliases: Map<string, { accountId: string; route: BncrRoute; updatedAt: number }>;
  lastSessionByAccount: Map<string, BncrRuntimeLastSession>;
  markActivity: (accountId: string, at?: number) => void;
  scheduleSave: () => void;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  ensureCanonicalAgentId: (args: {
    cfg: BncrChannelConfigRoot;
    accountId: string;
    channelId: string;
    peer: { kind: 'direct'; id: string };
  }) => string;
  recentMediaDedupeBySession: Map<string, Map<string, MediaDedupeCacheEntry>>;
  resolveMessageAckTimeoutMs: (accountId?: string) => number;
  isOnline: (accountId: string) => boolean;
  outboxValues: () => Iterable<OutboxEntry>;
  deadLetterEntries: () => OutboxEntry[];
  sessionRouteValues: () => Iterable<{ accountId: string }>;
  countInvalidOutboxSessionKeys: (accountId: string) => number;
  countLegacyAccountResidue: (accountId: string) => number;
  connectEventsByAccount: Map<string, number>;
  inboundEventsByAccount: Map<string, number>;
  activityEventsByAccount: Map<string, number>;
  ackEventsByAccount: Map<string, number>;
  activeConnectionCount: (accountId: string) => number;
  lastActivityByAccount: Map<string, number>;
  lastInboundByAccount: Map<string, number>;
  lastOutboundByAccount: Map<string, number>;
  buildRuntimeAckObservability: (accountId: string) => BncrAckObservability;
  buildRuntimeAckStrategy: (ackObservability: BncrAckObservability) => BncrAckStrategy;
  lastAckOkByAccount: Map<string, number>;
  lastAckTimeoutByAccount: Map<string, number>;
  getAckTimeoutCount: (accountId: string) => number;
  getAccountPendingOutboxEntries: (accountId: string) => OutboxEntry[];
  getAccountDeadLetterEntries: (accountId: string) => OutboxEntry[];
  connectionsValues: () => Iterable<{ lastSeenAt: number }>;
  connectTtlMs: number;
}) {
  const targetRuntime = createBncrTargetRuntime({
    api: runtime.api,
    channelId: runtime.channelId,
    canonicalAgentId: runtime.canonicalAgentId,
    now: runtime.now,
    normalizeAccountId: runtime.normalizeAccountId,
    sessionRoutes: runtime.sessionRoutes,
    routeAliases: runtime.routeAliases,
    lastSessionByAccount: runtime.lastSessionByAccount,
    markActivity: runtime.markActivity,
    scheduleSave: runtime.scheduleSave,
    logInfo: runtime.logInfo,
    logWarn: runtime.logWarn,
    ensureCanonicalAgentId: runtime.ensureCanonicalAgentId,
  });

  const mediaDedupeRuntime = createBncrMediaDedupeRuntime({
    now: runtime.now,
    recentMediaDedupeBySession: runtime.recentMediaDedupeBySession,
  });

  const statusRuntime = createBncrStatusRuntime({
    api: runtime.api,
    getPluginRoot: runtime.getPluginRoot,
    startedAt: runtime.startedAt,
    debugVerbose: runtime.debugVerbose,
    adaptiveAckTimeoutEnabled: runtime.adaptiveAckTimeoutEnabled,
    defaultMessageAckTimeoutMs: runtime.defaultMessageAckTimeoutMs,
    fileAckTimeoutMs: runtime.fileAckTimeoutMs,
    maxAckTimeoutMs: runtime.maxAckTimeoutMs,
    now: runtime.now,
    resolveMessageAckTimeoutMs: runtime.resolveMessageAckTimeoutMs,
    isOnline: runtime.isOnline,
    outboxValues: runtime.outboxValues,
    deadLetterEntries: runtime.deadLetterEntries,
    sessionRouteValues: runtime.sessionRouteValues,
    countInvalidOutboxSessionKeys: runtime.countInvalidOutboxSessionKeys,
    countLegacyAccountResidue: runtime.countLegacyAccountResidue,
    connectEventsByAccount: runtime.connectEventsByAccount,
    inboundEventsByAccount: runtime.inboundEventsByAccount,
    activityEventsByAccount: runtime.activityEventsByAccount,
    ackEventsByAccount: runtime.ackEventsByAccount,
    activeConnectionCount: runtime.activeConnectionCount,
    lastSessionByAccount: runtime.lastSessionByAccount,
    lastActivityByAccount: runtime.lastActivityByAccount,
    lastInboundByAccount: runtime.lastInboundByAccount,
    lastOutboundByAccount: runtime.lastOutboundByAccount,
    buildRuntimeAckObservability: runtime.buildRuntimeAckObservability,
    buildRuntimeAckStrategy: runtime.buildRuntimeAckStrategy,
    lastAckOkByAccount: runtime.lastAckOkByAccount,
    lastAckTimeoutByAccount: runtime.lastAckTimeoutByAccount,
    getAckTimeoutCount: runtime.getAckTimeoutCount,
    getAccountPendingOutboxEntries: runtime.getAccountPendingOutboxEntries,
    getAccountDeadLetterEntries: runtime.getAccountDeadLetterEntries,
    connectionsValues: runtime.connectionsValues,
    connectTtlMs: runtime.connectTtlMs,
  });

  return {
    targetRuntime,
    mediaDedupeRuntime,
    statusRuntime,
  };
}
