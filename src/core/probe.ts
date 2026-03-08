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

  if (!params.connected) issues.push('not-connected');
  if (params.pending > 20) issues.push('pending-high');
  if (params.deadLetter > 0) issues.push('dead-letter');
  if (params.activeConnections > 3) issues.push('too-many-connections');
  if (params.invalidOutboxSessionKeys > 0) issues.push('invalid-session-keys');
  if (params.legacyAccountResidue > 0) issues.push('legacy-account-residue');

  let level: 'ok' | 'warn' | 'error' = 'ok';
  if (issues.length > 0) level = 'warn';
  if (!params.connected && (params.deadLetter > 0 || params.invalidOutboxSessionKeys > 0)) level = 'error';

  return {
    ok: level === 'ok',
    level,
    summary: issues.length ? issues.join(', ') : 'healthy',
    details: {
      accountId: params.accountId,
      connected: params.connected,
      pending: params.pending,
      deadLetter: params.deadLetter,
      activeConnections: params.activeConnections,
      invalidOutboxSessionKeys: params.invalidOutboxSessionKeys,
      legacyAccountResidue: params.legacyAccountResidue,
      lastActivityAt: params.lastActivityAt ?? null,
      structure: params.structure ?? null,
    },
  };
}
