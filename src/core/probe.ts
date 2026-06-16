import { finiteNumberOrNull, nonNegativeFiniteNumberOr } from './value-sanitize.ts';

export function probeBncrAccount(params: {
  accountId: string;
  connected: boolean;
  pending: number;
  deadLetter: number;
  activeConnections: number;
  invalidOutboxSessionKeys: number;
  legacyAccountResidue: number;
  lastActivityAt?: number | null;
  structure?: {
    coreComplete: boolean;
    inboundComplete: boolean;
    outboundComplete: boolean;
  };
}) {
  const issues: string[] = [];
  const pending = nonNegativeFiniteNumberOr(params.pending, 0);
  const deadLetter = nonNegativeFiniteNumberOr(params.deadLetter, 0);
  const activeConnections = nonNegativeFiniteNumberOr(params.activeConnections, 0);
  const invalidOutboxSessionKeys = nonNegativeFiniteNumberOr(params.invalidOutboxSessionKeys, 0);
  const legacyAccountResidue = nonNegativeFiniteNumberOr(params.legacyAccountResidue, 0);

  if (!params.connected) issues.push('not-connected');
  if (pending > 20) issues.push('pending-high');
  if (deadLetter > 0) issues.push('dead-letter');
  if (activeConnections > 3) issues.push('too-many-connections');
  if (invalidOutboxSessionKeys > 0) issues.push('invalid-session-keys');
  if (legacyAccountResidue > 0) issues.push('legacy-account-residue');

  let level: 'ok' | 'warn' | 'error' = 'ok';
  if (issues.length > 0) level = 'warn';
  if (!params.connected && (deadLetter > 0 || invalidOutboxSessionKeys > 0)) level = 'error';

  return {
    ok: level === 'ok',
    level,
    summary: issues.length ? issues.join(', ') : 'healthy',
    details: {
      accountId: params.accountId,
      connected: params.connected,
      pending,
      deadLetter,
      activeConnections,
      invalidOutboxSessionKeys,
      legacyAccountResidue,
      lastActivityAt: finiteNumberOrNull(params.lastActivityAt),
      structure: params.structure ?? null,
    },
  };
}

export type BncrAccountProbe = ReturnType<typeof probeBncrAccount>;
