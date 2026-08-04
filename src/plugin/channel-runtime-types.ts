import type { TSchema } from 'typebox';
import type { RegisterDriftSnapshot } from '../core/register-trace.ts';
import type {
  BncrDiagnosticsSummary,
  BncrOutboundReplayEntry,
  BncrRoute,
  OutboxEntry,
} from '../core/types.ts';
import type { OpenClawChannelToolSend, openClawJsonResult } from '../openclaw/sdk-helpers.ts';

type OpenClawJsonResultPayload = ReturnType<typeof openClawJsonResult>;

export type BncrChannelConfigRoot = {
  channels?: Record<string, BncrChannelConfigSection | undefined>;
};

export type BncrChannelConfigSection = {
  enabled?: boolean;
  name?: string;
  debug?: {
    verbose?: boolean;
  };
  accounts?: Record<string, BncrAccountConfig | undefined>;
  outboundRequireAck?: boolean;
  [key: string]: unknown;
};

export type BncrAccountConfig = {
  enabled?: boolean;
  name?: string;
  [key: string]: unknown;
};

export type BncrPersistedSessionRoute = {
  sessionKey: string;
  accountId: string;
  route: BncrRoute;
  updatedAt: number;
};

export type BncrPersistedAccountTimestamp = {
  accountId: string;
  updatedAt: number;
};

export type BncrPersistedLastSession = {
  accountId: string;
  sessionKey: string;
  scope: string;
  updatedAt: number;
};

export type BncrSceneKind = 'direct' | 'group';

export type BncrSceneStatus = 'pending' | 'allowed' | 'denied';

export type BncrGroupReplyMode = 'admin' | 'mention' | 'hybrid' | 'all';

export type BncrSceneRecord = {
  sceneKey: string;
  kind: BncrSceneKind;
  status: BncrSceneStatus;
  platform: string;
  userId?: string;
  userName?: string;
  groupId?: string;
  groupName?: string;
  agentId?: string;
  groupReplyMode?: BncrGroupReplyMode;
  historyLimit?: number;
  historyForce?: boolean;
  downloadMedia?: boolean;
  lastSeenAt: number;
};

export type BncrPersistedGroupHistoryEntry = {
  sender: string;
  senderId?: string;
  body: string;
  timestamp?: number;
  messageId?: string;
  media?: BncrPersistedGroupHistoryMediaEntry[];
};

export type BncrPersistedGroupHistoryMediaEntry = {
  path?: string;
  contentType?: string;
  kind?: 'image' | 'video' | 'audio' | 'document' | 'unknown';
  messageId?: string;
};

export type BncrPersistedGroupHistoryBucket = {
  key: string;
  entries: BncrPersistedGroupHistoryEntry[];
};

export type BncrPersistedOutboundReplayEntry = BncrOutboundReplayEntry;
export type BncrPersistedOutboundReplayMediaEntry = BncrPersistedGroupHistoryMediaEntry;
export type BncrPersistedOutboundReplayBucket = {
  key: string;
  entries: BncrPersistedOutboundReplayEntry[];
};

export type BncrStatusRuntimeSnapshot = {
  connected?: boolean;
  running?: boolean;
  mode?: string;
  pending?: number | null;
  deadLetter?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
  lastSessionKey?: string | null;
  lastSessionScope?: string | null;
  lastSessionAt?: number | null;
  lastActivityAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastSessionAgo?: string | null;
  lastActivityAgo?: string | null;
  lastInboundAgo?: string | null;
  lastOutboundAgo?: string | null;
  diagnostics?: BncrDiagnosticsSummary | Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type BncrVerifiedTarget = {
  sessionKey: string;
  route: BncrRoute;
  displayScope: string;
};

export type BncrChannelSendContext = {
  accountId?: string | null;
  to?: string;
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  type?: string;
  kind?: string;
  replyToId?: string | null;
  replyToMessageId?: string | null;
  asVoice?: boolean;
  audioAsVoice?: boolean;
  mediaLocalRoots?: readonly string[];
  payload?: Record<string, unknown>;
  sessionKey?: string;
  mirror?: { sessionKey?: string };
  threadId?: string | number | null;
  /** Pass-through fields from host - bncr plugin does NOT consume these. */
  forceDocument?: boolean;
  gifPlayback?: boolean;
  silent?: boolean;
  downloadMedia?: boolean;
  /** Extra key-value pairs from marker parsing or direct pass-through. */
  extra?: Record<string, unknown>;
};

/**
 * TypeBox schema contribution for the shared `message` tool.
 * The host wraps each property with Type.Optional before validation.
 */
export type BncrMessageToolSchemaContribution = {
  visibility?: 'current-channel' | 'all-configured';
  properties: Record<string, TSchema>;
};

export type ChannelMessageActionAdapter = {
  describeMessageTool: (ctx: { cfg: BncrChannelConfigRoot }) => {
    actions: readonly ('send' | 'delete' | 'unsend')[];
    capabilities: readonly [];
    schema?: BncrMessageToolSchemaContribution;
  } | null;
  supportsAction: (ctx: { action: string }) => boolean;
  extractToolSend: (ctx: { args: unknown }) => OpenClawChannelToolSend | null;
  handleAction: (ctx: {
    action: string;
    params: unknown;
    accountId?: string | null;
    mediaLocalRoots?: readonly string[];
  }) => Promise<OpenClawJsonResultPayload>;
};

export type PersistedState = {
  outbox: OutboxEntry[];
  deadLetter: OutboxEntry[];
  sessionRoutes: BncrPersistedSessionRoute[];
  sceneRegistry?: BncrSceneRecord[];
  groupHistories?: BncrPersistedGroupHistoryBucket[];
  outboundReplayCache?: BncrPersistedOutboundReplayBucket[];
  lastSessionByAccount?: BncrPersistedLastSession[];
  lastActivityByAccount?: BncrPersistedAccountTimestamp[];
  lastInboundByAccount?: BncrPersistedAccountTimestamp[];
  lastOutboundByAccount?: BncrPersistedAccountTimestamp[];
  lastDriftSnapshot?: RegisterDriftSnapshot | null;
};

export type BncrBridgeRuntimePaths = {
  pluginRoot?: string | null;
  pluginFile?: string | null;
};
