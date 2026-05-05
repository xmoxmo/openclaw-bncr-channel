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
  payload: Record<string, unknown> & {
    _meta?: {
      kind?: 'message' | 'file-transfer';
      retryCount?: number;
      nextAttemptAt?: number;
      mediaUrl?: string;
      mediaLocalRoots?: string[];
      text?: string;
      asVoice?: boolean;
      audioAsVoice?: boolean;
      replyToId?: string;
      finalEvent?: string;
      [key: string]: unknown;
    };
  };
  createdAt: number;
  retryCount: number;
  nextAttemptAt: number;
  lastAttemptAt?: number;
  lastError?: string;
  lastPushAt?: number;
  lastPushConnId?: string;
  lastPushClientId?: string;
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
