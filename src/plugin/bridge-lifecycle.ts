import path from 'node:path';
import type { OpenClawPluginServiceContext } from 'openclaw/plugin-sdk/core';
import { BNCR_DEFAULT_ACCOUNT_ID } from '../core/accounts.ts';
import type { BncrChannelPolicyConfig } from '../core/policy.ts';
import { resolveBncrConfigWarnings } from '../core/policy.ts';
import type { BncrChannelConfigRoot } from './channel-runtime-types.ts';

export function buildBncrBridgeCleanupDebugInfo(args: {
  bridgeId: string;
  reason: string;
  messageAckWaiters: number;
  fileAckWaiters: number;
  earlyFileAcks: number;
  outbox: number;
  runningDrainAccounts: number;
  channelAccountWorkers: number;
  hasSaveTimer: boolean;
  hasPushTimer: boolean;
}) {
  return {
    bridge: args.bridgeId,
    reason: args.reason,
    messageAckWaiters: args.messageAckWaiters,
    fileAckWaiters: args.fileAckWaiters,
    earlyFileAcks: args.earlyFileAcks,
    outbox: args.outbox,
    runningDrainAccounts: args.runningDrainAccounts,
    channelAccountWorkers: args.channelAccountWorkers,
    hasSaveTimer: args.hasSaveTimer,
    hasPushTimer: args.hasPushTimer,
  };
}

export function startBncrBridgeService(
  runtime: {
    bridgeId: string;
    setStopped: (value: boolean) => void;
    setStatePath: (value: string) => void;
    getRuntimeConfig: () => BncrChannelConfigRoot;
    initializeCanonicalAgentId: (cfg: BncrChannelConfigRoot) => void;
    logWarn: (
      scope: string | undefined,
      message: string,
      options?: { debugOnly?: boolean },
    ) => void;
    loadState: () => Promise<void>;
    cutoverToSqlite?: () => Promise<{ backupPath: string | null; storeMode: string }>;
    setDebugFlag: (value: boolean) => void;
    refreshDebugFlagFromConfig: (options?: { forceLog?: boolean }) => Promise<void>;
    buildIntegratedDiagnostics: (accountId: string) => {
      regression: { totalKnownRoutes: number; ok: boolean };
      health: { pending: number; deadLetter: number };
    };
    logInfo: (
      scope: string | undefined,
      message: string,
      options?: { debugOnly?: boolean },
    ) => void;
    getChannelConfigRoot: (
      cfg: BncrChannelConfigRoot,
    ) => BncrChannelPolicyConfig | null | undefined;
  },
  ctx: OpenClawPluginServiceContext,
  debug?: boolean,
) {
  runtime.setStopped(false);
  runtime.setStatePath(path.join(ctx.stateDir, 'bncr-bridge-state.json'));
  return (async () => {
    try {
      const cfg = runtime.getRuntimeConfig();
      runtime.initializeCanonicalAgentId(cfg);
      for (const warning of resolveBncrConfigWarnings(runtime.getChannelConfigRoot(cfg))) {
        runtime.logWarn('config', warning);
      }
    } catch {
      // ignore startup canonical agent initialization errors
    }
    await runtime.loadState();
    if (process.env.BNCR_SQLITE_CUTOVER === '1' && runtime.cutoverToSqlite) {
      const cutover = await runtime.cutoverToSqlite();
      runtime.logInfo(
        'sqlite',
        `cutover completed backup=${cutover.backupPath || 'none'} storeMode=${cutover.storeMode}`,
      );
    }
    if (typeof debug === 'boolean') runtime.setDebugFlag(debug);
    await runtime.refreshDebugFlagFromConfig({ forceLog: true });
    const bootDiag = runtime.buildIntegratedDiagnostics(BNCR_DEFAULT_ACCOUNT_ID);
    runtime.logInfo(
      'startup',
      `bridge=${runtime.bridgeId} routes=${bootDiag.regression.totalKnownRoutes}`,
    );
    runtime.logInfo(
      'debug',
      `service started bridge=${runtime.bridgeId} diag.ok=${bootDiag.regression.ok} routes=${bootDiag.regression.totalKnownRoutes} pending=${bootDiag.health.pending} dead=${bootDiag.health.deadLetter}`,
      { debugOnly: true },
    );
  })();
}

export function cleanupBncrBridgeRuntime(
  runtime: {
    bridgeId: string;
    logInfo: (
      scope: string | undefined,
      message: string,
      options?: { debugOnly?: boolean },
    ) => void;
    setStopped: (value: boolean) => void;
    clearAllChannelAccountWorkers: (reason: string) => void;
    getMessageAckWaiterCount: () => number;
    getFileAckWaiterCount: () => number;
    getEarlyFileAckCount: () => number;
    getOutboxCount: () => number;
    getRunningDrainAccountCount: () => number;
    getChannelAccountWorkerCount: () => number;
    hasSaveTimer: () => boolean;
    hasPushTimer: () => boolean;
    clearSaveTimer: () => void;
    clearPushTimer: () => void;
    clearAllMessageAckWaiters: (result: 'timeout') => void;
    clearAllFileAckWaiters: (reason: string) => void;
  },
  reason: string,
) {
  runtime.logInfo(
    'lifecycle',
    `cleanup ${JSON.stringify(
      buildBncrBridgeCleanupDebugInfo({
        bridgeId: runtime.bridgeId,
        reason,
        messageAckWaiters: runtime.getMessageAckWaiterCount(),
        fileAckWaiters: runtime.getFileAckWaiterCount(),
        earlyFileAcks: runtime.getEarlyFileAckCount(),
        outbox: runtime.getOutboxCount(),
        runningDrainAccounts: runtime.getRunningDrainAccountCount(),
        channelAccountWorkers: runtime.getChannelAccountWorkerCount(),
        hasSaveTimer: runtime.hasSaveTimer(),
        hasPushTimer: runtime.hasPushTimer(),
      }),
    )}`,
    { debugOnly: true },
  );
  runtime.setStopped(true);
  runtime.clearAllChannelAccountWorkers(reason);
  runtime.clearSaveTimer();
  runtime.clearPushTimer();
  runtime.clearAllMessageAckWaiters('timeout');
  runtime.clearAllFileAckWaiters(reason);
}

export async function stopBncrBridgeService(runtime: {
  cleanupRuntime: (reason: string) => void;
  flushState: () => Promise<void>;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
}) {
  runtime.cleanupRuntime('service stopped');
  await runtime.flushState();
  runtime.logInfo('debug', 'service stopped', { debugOnly: true });
}

export function shutdownBncrBridgeService(runtime: { cleanupRuntime: (reason: string) => void }) {
  runtime.cleanupRuntime('shutdown');
}
