import type { BncrRuntimeFlags } from '../runtime/outbound-flags.ts';
import type { BncrExtendedDiagnostics } from './extended-diagnostics.ts';
import type { BncrPermissionSummary } from './permissions.ts';
import { buildBncrPermissionSummary } from './permissions.ts';
import type { BncrAccountProbe } from './probe.ts';
import { probeBncrAccount } from './probe.ts';
import type { BncrAccountRuntimeSnapshot } from './status.ts';
import type { BncrDownlinkHealthSummary } from './types.ts';
import { nonNegativeFiniteNumberOr } from './value-sanitize.ts';

export type BncrDiagnosticsWaiters = {
  messageAck: number;
  fileAck: number;
};

type DiagnosticsPayloadArgs = {
  cfg: unknown;
  channelId: string;
  accountId: string;
  runtime: BncrAccountRuntimeSnapshot;
  diagnostics: BncrExtendedDiagnostics;
  downlinkHealth: BncrDownlinkHealthSummary;
  runtimeFlags: BncrRuntimeFlags;
  waiters: BncrDiagnosticsWaiters;
  activeConnections: number;
  invalidOutboxSessionKeys: number;
  legacyAccountResidue: number;
  now: number;
};

export type BncrDiagnosticsPayload = {
  channel: string;
  accountId: string;
  runtime: BncrAccountRuntimeSnapshot;
  diagnostics: BncrExtendedDiagnostics;
  downlinkHealth: BncrDownlinkHealthSummary;
  runtimeFlags: BncrRuntimeFlags;
  waiters: BncrDiagnosticsWaiters;
  permissions: BncrPermissionSummary;
  probe: BncrAccountProbe;
  now: number;
};

export function buildDiagnosticsPayload(args: DiagnosticsPayloadArgs): BncrDiagnosticsPayload {
  const permissions = buildBncrPermissionSummary(args.cfg ?? {});
  const probe = probeBncrAccount({
    accountId: args.accountId,
    connected: Boolean(args.runtime?.connected),
    pending: nonNegativeFiniteNumberOr(args.runtime?.meta?.pending, 0),
    deadLetter: nonNegativeFiniteNumberOr(args.runtime?.meta?.deadLetter, 0),
    activeConnections: nonNegativeFiniteNumberOr(args.activeConnections, 0),
    invalidOutboxSessionKeys: nonNegativeFiniteNumberOr(args.invalidOutboxSessionKeys, 0),
    legacyAccountResidue: nonNegativeFiniteNumberOr(args.legacyAccountResidue, 0),
    lastActivityAt: args.runtime?.meta?.lastActivityAt ?? null,
    structure: {
      coreComplete: true,
      inboundComplete: true,
      outboundComplete: true,
    },
  });

  return {
    channel: args.channelId,
    accountId: args.accountId,
    runtime: args.runtime,
    diagnostics: args.diagnostics,
    downlinkHealth: args.downlinkHealth,
    runtimeFlags: args.runtimeFlags,
    waiters: args.waiters,
    permissions,
    probe,
    now: args.now,
  };
}
