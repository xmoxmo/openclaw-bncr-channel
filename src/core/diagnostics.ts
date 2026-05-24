import { buildBncrPermissionSummary } from './permissions.ts';
import { probeBncrAccount } from './probe.ts';

function finiteNumberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
    pending: finiteNumberOr(args.runtime?.meta?.pending, 0),
    deadLetter: finiteNumberOr(args.runtime?.meta?.deadLetter, 0),
    activeConnections: args.activeConnections,
    invalidOutboxSessionKeys: args.invalidOutboxSessionKeys,
    legacyAccountResidue: args.legacyAccountResidue,
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
