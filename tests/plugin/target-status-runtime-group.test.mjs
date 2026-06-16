import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrTargetStatusRuntimeGroup } from '../../src/plugin/target-status-runtime-group.ts';

function createRuntime(overrides = {}) {
  return {
    api: {},
    channelId: 'bncr',
    canonicalAgentId: 'orion',
    getPluginRoot: () => '/tmp/bncr',
    startedAt: 100,
    debugVerbose: false,
    adaptiveAckTimeoutEnabled: true,
    defaultMessageAckTimeoutMs: 30_000,
    fileAckTimeoutMs: 20_000,
    maxAckTimeoutMs: 90_000,
    now: () => 5_000,
    normalizeAccountId: (accountId) => String(accountId || '').trim(),
    sessionRoutes: new Map(),
    routeAliases: new Map(),
    lastSessionByAccount: new Map(),
    markActivity() {},
    scheduleSave() {},
    logInfo() {},
    logWarn() {},
    ensureCanonicalAgentId() {
      return 'orion';
    },
    recentMediaDedupeBySession: new Map(),
    resolveMessageAckTimeoutMs: () => 45_000,
    isOnline: () => false,
    outboxValues: () => [],
    deadLetterEntries: () => [],
    sessionRouteValues: () => [],
    countInvalidOutboxSessionKeys: () => 0,
    countLegacyAccountResidue: () => 0,
    connectEventsByAccount: new Map(),
    inboundEventsByAccount: new Map(),
    activityEventsByAccount: new Map(),
    ackEventsByAccount: new Map(),
    activeConnectionCount: () => 0,
    lastActivityByAccount: new Map(),
    lastInboundByAccount: new Map(),
    lastOutboundByAccount: new Map(),
    buildRuntimeAckObservability: () => ({ recentAckTimeoutCount: 0, currentAckTimeoutMs: 45_000 }),
    buildRuntimeAckStrategy: () => ({ mode: 'adaptive', timeoutMs: 45_000 }),
    lastAckOkByAccount: new Map(),
    lastAckTimeoutByAccount: new Map(),
    getAckTimeoutCount: () => 0,
    getAccountPendingOutboxEntries: () => [],
    getAccountDeadLetterEntries: () => [],
    connectionsValues: () => [],
    connectTtlMs: 60_000,
    ...overrides,
  };
}

test('target-status runtime group composes target media-dedupe and status runtimes', () => {
  const group = createBncrTargetStatusRuntimeGroup(createRuntime());

  group.targetRuntime.rememberSessionRoute('session-1', 'Primary', {
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
  });
  group.mediaDedupeRuntime.rememberRecentMediaSend({
    sessionKey: 'session-1',
    mediaUrl: 'https://example.com/a.png',
    text: 'hello',
    replyToId: 'mid-1',
    createdAt: 5_000,
  });

  assert.equal(group.targetRuntime.resolveRouteBySession('session-1', 'Primary')?.userId, '10001');
  assert.deepEqual(
    group.mediaDedupeRuntime.tryBuildMediaDedupeFallback({
      sessionKey: 'session-1',
      mediaUrl: 'https://example.com/a.png',
      text: 'hello',
      replyToId: 'mid-1',
      currentTime: 5_001,
    }),
    {
      text: '✅已发送',
      reason: 'same-text-sent-checkmark',
    },
  );
  assert.equal(group.statusRuntime.buildRuntimeStatusInput('Primary').channelRoot, '/tmp/bncr');
});
