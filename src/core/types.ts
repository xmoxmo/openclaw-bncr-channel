export type BncrRoute = {
  platform: string;
  groupId: string;
  userId: string;
};

export type BncrConnection = {
  accountId: string;
  connId: string;
  clientId?: string;
  connectedAt: number;
  lastSeenAt: number;
  inboundOnly?: boolean;
  outboundReady?: boolean;
  preferredForOutbound?: boolean;
};

export type BncrGatewayCapabilityFlags = {
  outboundReady: boolean;
  preferredForOutbound: boolean;
  inboundOnly: boolean;
};

type FileRecvTransferBase = {
  transferId: string;
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  fileName: string;
  mimeType: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  fileSha256: string;
  startedAt: number;
  bufferByChunk: Map<number, Buffer>;
  receivedChunks: Set<number>;
  ownerConnId?: string;
  ownerClientId?: string;
};

export type FileRecvTransferInitState = FileRecvTransferBase & {
  status: 'init';
};

export type FileRecvTransferTransferringState = FileRecvTransferBase & {
  status: 'transferring';
};

export type FileRecvTransferCompletedState = FileRecvTransferBase & {
  status: 'completed';
  completedPath: string;
  terminalAt: number;
};

export type FileRecvTransferAbortedState = FileRecvTransferBase & {
  status: 'aborted';
  terminalAt: number;
  error: string;
};

export type FileRecvTransferState =
  | FileRecvTransferInitState
  | FileRecvTransferTransferringState
  | FileRecvTransferCompletedState
  | FileRecvTransferAbortedState;

export type FileSendTransferStatus = 'init' | 'transferring' | 'completed' | 'aborted';

export type FileSendTransferState = {
  transferId: string;
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  fileName: string;
  mimeType: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  fileSha256: string;
  startedAt: number;
  status: FileSendTransferStatus;
  ackedChunks: Set<number>;
  failedChunks: Map<number, string>;
  ownerConnId?: string;
  ownerClientId?: string;
  completedPath?: string;
  terminalAt?: number;
  error?: string;
};

export type PendingAdmission = {
  clientId: string;
  route: BncrRoute;
  routes: BncrRoute[];
  firstSeenAt: number;
  lastSeenAt: number;
  attempts: number;
};

export type OutboxEntry = {
  messageId: string;
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  payload: Record<string, unknown>;
  createdAt: number;
  retryCount: number;
  nextAttemptAt: number;
  lastAttemptAt?: number;
  lastError?: string;
  lastPushAt?: number;
  lastPushConnId?: string;
  lastPushClientId?: string;
  routeAttemptConnIds?: string[];
  routeAttemptRound?: number;
  fastReroutePending?: boolean;
  awaitingRetryPush?: boolean;
};

export type BncrDiagnosticsSummary = {
  health: {
    connected: boolean;
    pending: number;
    pendingAdmissions: number;
    deadLetter: number;
    activeConnections: number;
    connectEvents: number;
    inboundEvents: number;
    activityEvents: number;
    ackEvents: number;
    uptimeSec: number;
  };
  regression: {
    pluginFilesPresent: boolean;
    pluginIndexExists: boolean;
    pluginChannelExists: boolean;
    totalKnownRoutes: number;
    invalidOutboxSessionKeys: number;
    legacyAccountResidue: number;
    ok: boolean;
  };
};

export type BncrDeadLetterDiagnosticsSummary = {
  total: number;
  allAccountsTotal: number;
  sinceStart: number;
  cappedAt: number;
  oldestAt: number | null;
  newestAt: number | null;
  topReasons: Array<{ reason: string; count: number }>;
};

export type BncrDeadLetterEntrySummary = {
  messageId: string;
  accountId: string;
  sessionKey: string;
  route: string;
  kind: string;
  createdAt: number | null;
  retryCount: number;
  lastError: string | null;
  textPreview: string;
};

export type BncrDownlinkHealthSummary = {
  pendingOutbox: number;
  oldestPendingCreatedAt: number | null;
  oldestPendingAgeMs: number;
  lastAckOkAt: number | null;
  lastAckTimeoutAt: number | null;
  recentAckTimeoutCount: number;
  activeConnectionCount: number;
  recentInboundReachable: boolean;
  onlineByConn: boolean;
  ackStalled: boolean;
  recommendReconnect: boolean;
  recommendReason: string;
};

export type BncrAckObservability = {
  lastAckOkAt: number | null;
  lastAckTimeoutAt: number | null;
  recentAckTimeoutCount: number;
  lateAckOkCount: number;
  lastLateAckOkAt: number | null;
  lastLateAckAgeMs: number | null;
  lateAckObservationTtlMs: number;
  lateAckObservationExpired: boolean;
  adaptiveAckRecoveryOkCount: number;
  adaptiveAckRecoveryOkThreshold: number;
  adaptiveAckRecovered: boolean;
  lastAckQueueLatencyMs: number | null;
  lastAckPushLatencyMs: number | null;
  lastLateAckQueueLatencyMs: number | null;
  lastLateAckPushLatencyMs: number | null;
  adaptiveAckTimeoutEnabled: boolean;
  defaultAckTimeoutMs: number;
  currentAckTimeoutMs: number;
  recommendedAckTimeoutMs: number;
  recommendedAckTimeoutReason: string;
};

export type BncrAckStrategy = {
  mode: 'adaptive' | 'fixed';
  currentMs: number;
  defaultMs: number;
  maxMs: number;
  reason: string;
  active: boolean;
  lastLateAckAgeMs: number | null;
  lateAckObservationTtlMs: number | null;
  recovered: boolean;
};

export type BncrStaleCounterSummary = {
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

export type BncrRuntimeLastSession = {
  sessionKey: string;
  scope: string;
  updatedAt: number;
};

export type BncrOutboxQueueDiagnostics = {
  pending: number;
  pendingAllAccounts: number;
  oldestPendingAt: number | null;
  newestPendingAt: number | null;
  lastAttemptAt: number | null;
  lastPushAt: number | null;
  lastPushError: string | null;
  activeOutboundConnection: boolean;
  activeOutboundConnectionCount: number;
};

export type BncrOutboxIncidentAckSummary = {
  lastQueueLatencyMs: number | null;
  lastPushLatencyMs: number | null;
  lastLateQueueLatencyMs: number | null;
  lastLatePushLatencyMs: number | null;
  lastLateAckAgeMs: number | null;
  adaptiveTimeoutMs: number | null;
  adaptiveTimeoutReason: string | null;
};

export type BncrOutboxIncidentSummary = {
  active: boolean;
  type: string;
  severity: 'ok' | 'warning' | 'critical';
  recommendedAction: string;
  pending: number;
  oldestPendingAgeMs: number | null;
  lastAttemptAgeMs: number | null;
  lastPushAgeMs: number | null;
  lastPushError: string | null;
  hasGatewayContext: boolean;
  activeOutboundConnection: boolean;
  activeOutboundConnectionCount: number;
  prePushGuardSkipCount: number;
  lastPrePushGuardSkipAgeMs: number | null;
  lastPrePushGuardSkipReason: string | null;
  ack: BncrOutboxIncidentAckSummary;
};

export type BncrExtendedOutboundDiagnostics = BncrOutboxQueueDiagnostics & {
  enqueueCount: number;
  lastEnqueueAt: number | null;
  prePushGuardSkipCount: number;
  lastPrePushGuardSkipAt: number | null;
  lastPrePushGuardSkipReason: string | null;
  hasGatewayContext: boolean;
  lastGatewayContextAt: number | null;
  incident: BncrOutboxIncidentSummary;
};
