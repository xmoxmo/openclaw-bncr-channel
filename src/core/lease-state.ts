export type LeaseEventKind =
  | 'connect'
  | 'inbound'
  | 'activity'
  | 'ack'
  | 'file.init'
  | 'file.chunk'
  | 'file.complete'
  | 'file.abort';

export type LeaseObservationReason = 'missing' | 'ok' | 'mismatch';

export type LeaseObservationResult = {
  stale: boolean;
  reason: LeaseObservationReason;
};

export type StaleCounters = {
  staleConnect: number;
  staleInbound: number;
  staleActivity: number;
  staleAck: number;
  staleFileInit: number;
  staleFileChunk: number;
  staleFileComplete: number;
  staleFileAbort: number;
  lastStaleAt: number | null;
};

export function observeLeaseState(args: {
  kind: LeaseEventKind;
  params: { leaseId?: string; connectionEpoch?: number };
  currentLeaseId: string | null;
  currentConnectionEpoch: number;
  now: number;
  staleCounters: StaleCounters;
}): LeaseObservationResult {
  const leaseId = typeof args.params.leaseId === 'string' ? args.params.leaseId.trim() : '';
  const connectionEpoch =
    typeof args.params.connectionEpoch === 'number' ? args.params.connectionEpoch : undefined;
  if (!leaseId && connectionEpoch == null) return { stale: false, reason: 'missing' };

  const staleByLease = !!leaseId && args.currentLeaseId != null && leaseId !== args.currentLeaseId;
  const staleByEpoch =
    connectionEpoch != null &&
    args.currentConnectionEpoch > 0 &&
    connectionEpoch !== args.currentConnectionEpoch;
  const stale = staleByLease || staleByEpoch;
  if (!stale) return { stale: false, reason: 'ok' };

  args.staleCounters.lastStaleAt = args.now;
  switch (args.kind) {
    case 'connect':
      args.staleCounters.staleConnect += 1;
      break;
    case 'inbound':
      args.staleCounters.staleInbound += 1;
      break;
    case 'activity':
      args.staleCounters.staleActivity += 1;
      break;
    case 'ack':
      args.staleCounters.staleAck += 1;
      break;
    case 'file.init':
      args.staleCounters.staleFileInit += 1;
      break;
    case 'file.chunk':
      args.staleCounters.staleFileChunk += 1;
      break;
    case 'file.complete':
      args.staleCounters.staleFileComplete += 1;
      break;
    case 'file.abort':
      args.staleCounters.staleFileAbort += 1;
      break;
  }
  return { stale: true, reason: 'mismatch' };
}

export function matchesTransferOwner(args: {
  ownerConnId?: string;
  ownerClientId?: string;
  connId: string;
  clientId?: string;
}) {
  const sameConn = !!args.ownerConnId && args.ownerConnId === args.connId;
  const sameClient =
    !args.ownerConnId &&
    !!args.ownerClientId &&
    !!args.clientId &&
    args.ownerClientId === args.clientId;
  return sameConn || sameClient;
}
