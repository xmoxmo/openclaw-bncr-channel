import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import { BNCR_DEFAULT_ACCOUNT_ID, normalizeAccountId } from '../core/accounts.ts';
import {
  parseDeadLetterLimit,
  parseDeadLetterOffset,
  parseDeadLetterOlderThan,
  summarizeDeadLetterEntry,
} from '../core/dead-letter-diagnostics.ts';
import { buildDiagnosticsPayload } from '../core/diagnostics.ts';
import type { BncrExtendedDiagnostics } from '../core/extended-diagnostics.ts';
import type {
  BncrAccountRuntimeSnapshot,
  buildIntegratedDiagnostics as buildIntegratedDiagnosticsFromRuntime,
} from '../core/status.ts';
import type {
  BncrDeadLetterDiagnosticsSummary,
  BncrDownlinkHealthSummary,
  OutboxEntry,
} from '../core/types.ts';
import { getOpenClawRuntimeConfig } from '../openclaw/config-runtime.ts';
import type { BncrRuntimeFlags } from '../runtime/outbound-flags.ts';

type RuntimeStatusInput = Parameters<typeof buildIntegratedDiagnosticsFromRuntime>[0];
type IntegratedDiagnostics = ReturnType<typeof buildIntegratedDiagnosticsFromRuntime>;
type DiagnosticsRuntimeStatusOverrides = {
  running: boolean;
  invalidOutboxSessionKeys?: number;
  legacyAccountResidue?: number;
};
type DiagnosticsRuntimeStatusInput = RuntimeStatusInput & {
  running: boolean | undefined;
  channelRoot: string;
};

type RuntimeApiHolder = {
  runtime?: {
    config?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type BncrDiagnosticsHandlerRuntime = {
  getApi: () => RuntimeApiHolder;
  channelId: string;
  asString: (value: unknown, fallback?: string) => string;
  now: () => number;
  countInvalidOutboxSessionKeys: (accountId: string) => number;
  countLegacyAccountResidue: (accountId: string) => number;
  buildRuntimeStatusInput: (
    accountId: string,
    overrides: DiagnosticsRuntimeStatusOverrides,
  ) => DiagnosticsRuntimeStatusInput;
  getAccountRuntimeSnapshot: (
    accountId: string,
    runtimeStatusInput: DiagnosticsRuntimeStatusInput,
  ) => BncrAccountRuntimeSnapshot;
  buildIntegratedDiagnostics: (
    accountId: string,
    runtimeStatusInput: DiagnosticsRuntimeStatusInput,
  ) => IntegratedDiagnostics;
  buildExtendedDiagnostics: (
    accountId: string,
    args: {
      runtimeStatusInput: DiagnosticsRuntimeStatusInput;
      integratedDiagnostics: IntegratedDiagnostics;
    },
  ) => BncrExtendedDiagnostics;
  buildDownlinkHealth: (accountId: string) => BncrDownlinkHealthSummary;
  buildRuntimeFlags: (accountId: string) => BncrRuntimeFlags;
  activeConnectionCount: (accountId: string) => number;
  getMessageAckWaiterCount: () => number;
  getFileAckWaiterCount: () => number;
  filterDeadLetterEntries: (args: {
    accountId: string;
    reason: string | null;
    olderThan: number | null;
  }) => OutboxEntry[];
  listDeadLetterEntries: () => OutboxEntry[];
  buildDeadLetterDiagnostics: (accountId: string) => BncrDeadLetterDiagnosticsSummary;
  replaceDeadLetterEntries: (nextEntries: OutboxEntry[]) => void;
  scheduleSave: () => void;
  logDeadLetterSummary: (accountId: string, args: { force: boolean; source: string }) => void;
};

export function createBncrDiagnosticsHandlers(runtime: BncrDiagnosticsHandlerRuntime) {
  return {
    handleDiagnostics: async ({ params, respond }: GatewayRequestHandlerOptions) => {
      const accountId = normalizeAccountId(runtime.asString(params?.accountId || ''));
      const cfg = getOpenClawRuntimeConfig(runtime.getApi());
      const invalidOutboxSessionKeys = runtime.countInvalidOutboxSessionKeys(accountId);
      const legacyAccountResidue = runtime.countLegacyAccountResidue(accountId);
      const runtimeStatusInput = runtime.buildRuntimeStatusInput(accountId, {
        running: true,
        invalidOutboxSessionKeys,
        legacyAccountResidue,
      });
      const runtimeSnapshot = runtime.getAccountRuntimeSnapshot(accountId, runtimeStatusInput);
      const integratedDiagnostics = runtime.buildIntegratedDiagnostics(
        accountId,
        runtimeStatusInput,
      );
      const diagnostics = runtime.buildExtendedDiagnostics(accountId, {
        runtimeStatusInput,
        integratedDiagnostics,
      });

      respond(
        true,
        buildDiagnosticsPayload({
          cfg,
          channelId: runtime.channelId,
          accountId,
          runtime: runtimeSnapshot,
          diagnostics,
          downlinkHealth: runtime.buildDownlinkHealth(accountId),
          runtimeFlags: runtime.buildRuntimeFlags(accountId),
          waiters: {
            messageAck: runtime.getMessageAckWaiterCount(),
            fileAck: runtime.getFileAckWaiterCount(),
          },
          activeConnections: runtime.activeConnectionCount(accountId),
          invalidOutboxSessionKeys,
          legacyAccountResidue,
          now: runtime.now(),
        }),
      );
    },

    handleDeadLetterInspect: async ({ params, respond }: GatewayRequestHandlerOptions) => {
      const accountId = normalizeAccountId(
        runtime.asString(params?.accountId || BNCR_DEFAULT_ACCOUNT_ID),
      );
      const reason = runtime.asString(params?.reason || '').trim() || null;
      const olderThan = parseDeadLetterOlderThan(params?.olderThan);
      const limit = parseDeadLetterLimit(params?.limit, 20);
      const offset = parseDeadLetterOffset(params?.offset, 0);
      const matches = runtime
        .filterDeadLetterEntries({ accountId, reason, olderThan })
        .slice()
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

      respond(true, {
        ok: true,
        accountId,
        filters: { reason, olderThan },
        total: matches.length,
        offset,
        limit,
        entries: matches
          .slice(offset, offset + limit)
          .map((entry) => summarizeDeadLetterEntry(entry)),
        summary: runtime.buildDeadLetterDiagnostics(accountId),
        now: runtime.now(),
      });
    },

    handleDeadLetterPrune: async ({ params, respond }: GatewayRequestHandlerOptions) => {
      const accountId = normalizeAccountId(
        runtime.asString(params?.accountId || BNCR_DEFAULT_ACCOUNT_ID),
      );
      const reason = runtime.asString(params?.reason || '').trim() || null;
      const olderThan = parseDeadLetterOlderThan(params?.olderThan);
      const limit = parseDeadLetterLimit(params?.limit, 100);
      const dryRun = params?.dryRun !== false;
      const hasDestructiveFilter = Boolean(reason || olderThan !== null);
      if (!dryRun && !hasDestructiveFilter) {
        respond(false, {
          ok: false,
          error: 'deadLetter-prune-requires-filter',
          message: 'dryRun=false requires at least one destructive filter: reason or olderThan',
          dryRun,
          accountId,
          filters: { reason, olderThan },
          summary: runtime.buildDeadLetterDiagnostics(accountId),
          now: runtime.now(),
        });
        return;
      }
      const matches = runtime
        .filterDeadLetterEntries({ accountId, reason, olderThan })
        .slice()
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
      const selected = matches.slice(0, limit);
      const selectedEntries = new Set(selected);

      if (!dryRun && selectedEntries.size > 0) {
        const nextEntries = runtime
          .listDeadLetterEntries()
          .filter((entry) => !selectedEntries.has(entry));
        runtime.replaceDeadLetterEntries(nextEntries);
        runtime.scheduleSave();
        runtime.logDeadLetterSummary(accountId, { force: true, source: 'prune' });
      }

      respond(true, {
        ok: true,
        dryRun,
        accountId,
        filters: { reason, olderThan },
        matched: matches.length,
        pruned: dryRun ? 0 : selected.length,
        wouldPrune: selected.length,
        limit,
        entries: selected.map((entry) => summarizeDeadLetterEntry(entry)),
        summary: runtime.buildDeadLetterDiagnostics(accountId),
        now: runtime.now(),
      });
    },
  };
}
