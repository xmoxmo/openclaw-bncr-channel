import { asSanitizedString } from '../core/value-sanitize.ts';
import type { BncrChannelConfigRoot } from './channel-runtime-types.ts';

export function createBridgeSupportRuntime(args: {
  isStopped: () => boolean;
  hasSaveTimer: () => boolean;
  setSaveTimer: (timer: NodeJS.Timeout | null) => void;
  flushState: () => Promise<void>;
  normalizeAccountId: (accountId: string) => string;
  getCounterValue: (map: Map<string, number>, accountId: string) => number;
  getRuntimeConfig: () => unknown;
  channelId: string;
  readCurrentCanonicalAgentId: () => string | null;
  resolveAgentRoute: (args: {
    cfg: BncrChannelConfigRoot;
    channel: string;
    accountId: string;
    peer?: unknown;
  }) => { agentId?: unknown } | null;
  readCachedCanonicalAgentId: () => string | null;
  writeCachedCanonicalAgentId: (agentId: string) => void;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
  readDebugVerbose: () => boolean;
  writeDebugVerbose: (value: boolean) => void;
}) {
  const scheduleSave = () => {
    if (args.isStopped()) return;
    if (args.hasSaveTimer()) return;
    args.setSaveTimer(
      setTimeout(() => {
        args.setSaveTimer(null);
        if (args.isStopped()) return;
        void args.flushState();
      }, 300),
    );
  };

  const incrementCounter = (map: Map<string, number>, accountId: string) => {
    const acc = args.normalizeAccountId(accountId);
    map.set(acc, args.getCounterValue(map, acc) + 1);
  };

  const getCounter = (map: Map<string, number>, accountId: string): number => {
    return args.getCounterValue(map, args.normalizeAccountId(accountId));
  };

  const refreshDebugFlagFromConfig = async (options?: { forceLog?: boolean }) => {
    try {
      const cfg = args.getRuntimeConfig() as {
        channels?: Record<string, { debug?: { verbose?: unknown } }>;
      };
      const raw = cfg?.channels?.[args.channelId]?.debug?.verbose;
      const next = typeof raw === 'boolean' ? raw : false;
      const changed = next !== args.readDebugVerbose();
      args.writeDebugVerbose(next);
      if (changed || options?.forceLog) {
        args.logInfo('debug', `verbose=${next}`, { debugOnly: true });
      }
    } catch {
      // ignore config read errors
    }
  };

  const syncDebugFlag = async () => {
    await refreshDebugFlagFromConfig();
  };

  const tryResolveBindingAgentId = (resolveArgs: {
    cfg: BncrChannelConfigRoot;
    accountId: string;
    peer?: unknown;
    channelId?: string;
  }): string | null => {
    try {
      const resolved = args.resolveAgentRoute({
        cfg: resolveArgs.cfg,
        channel: resolveArgs.channelId || args.channelId,
        accountId: args.normalizeAccountId(resolveArgs.accountId),
        peer: resolveArgs.peer,
      });
      const agentId = asSanitizedString(resolved?.agentId || '').trim();
      return agentId || null;
    } catch {
      return null;
    }
  };

  const initializeCanonicalAgentId = (cfg: BncrChannelConfigRoot) => {
    if (args.readCachedCanonicalAgentId()) return;
    const agentId = tryResolveBindingAgentId({
      cfg,
      accountId: 'Primary',
      channelId: args.channelId,
      peer: { kind: 'direct', id: 'bootstrap' },
    });
    if (!agentId) return;
    args.writeCachedCanonicalAgentId(agentId);
  };

  const ensureCanonicalAgentId = (resolveArgs: {
    cfg: BncrChannelConfigRoot;
    accountId: string;
    peer?: unknown;
    channelId?: string;
  }) => {
    const cached = args.readCachedCanonicalAgentId();
    if (cached) return cached;

    const agentId = tryResolveBindingAgentId(resolveArgs);
    if (agentId) {
      args.writeCachedCanonicalAgentId(agentId);
      return agentId;
    }

    args.writeCachedCanonicalAgentId('main');
    args.logWarn(
      'target',
      'binding agent unresolved; fallback to main for current process lifetime',
      {
        debugOnly: true,
      },
    );
    return 'main';
  };

  return {
    scheduleSave,
    incrementCounter,
    getCounter,
    refreshDebugFlagFromConfig,
    syncDebugFlag,
    tryResolveBindingAgentId,
    initializeCanonicalAgentId,
    ensureCanonicalAgentId,
  };
}
