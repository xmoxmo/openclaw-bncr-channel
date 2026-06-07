import { buildBncrPermissionSummary } from './permissions.ts';
import { probeBncrAccount } from './probe.ts';

function finiteNumberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nonNegativeFiniteNumberOr(value: unknown, fallback: number): number {
  return Math.max(0, finiteNumberOr(value, fallback));
}

type DiagnosticsPayloadArgs = {
  cfg: any;
  channelId: string;
  accountId: string;
  runtime: any;
  diagnostics: any;
  downlinkHealth: any;
  runtimeFlags: any;
  waiters: { messageAck: number; fileAck: number };
  activeConnections: number;
  invalidOutboxSessionKeys: number;
  legacyAccountResidue: number;
  now: number;
};

export function buildDiagnosticsPayload(args: DiagnosticsPayloadArgs) {
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
