import type { BncrRoute, FileSendTransferState, OutboxEntry } from '../core/types.ts';
import type {
  NormalizedReplyPayload,
  OutboundReplyTargetPolicy,
  ReplyPayloadInput,
} from '../messaging/outbound/reply-enqueue.ts';
import {
  enqueueNormalizedReplyPayload,
  normalizeReplyPayload,
} from '../messaging/outbound/reply-enqueue.ts';
import type { createBncrFileAckRuntime } from './file-ack-runtime.ts';
import { createBncrFileTransferOrchestrator } from './file-transfer-orchestrator.ts';
import type { createBncrFileTransferSetup } from './file-transfer-setup.ts';

type PreparedOutboundTransfer = Awaited<
  ReturnType<ReturnType<typeof createBncrFileTransferSetup>['prepareOutboundTransfer']>
>;
type FileAckPayload = Awaited<
  ReturnType<ReturnType<typeof createBncrFileAckRuntime>['waitForFileAck']>
>;

async function normalizeReplyOrchestratorPayload(args: {
  payload: ReplyPayloadInput;
  asString: (value: unknown, fallback?: string) => string;
  replyTargetPolicy?: OutboundReplyTargetPolicy;
}) {
  return await normalizeReplyPayload(
    args.payload,
    { asString: args.asString },
    {
      replyTargetPolicy: args.replyTargetPolicy,
    },
  );
}

export function createBncrMediaOrchestratorsRuntimeGroup(runtime: {
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  fileSendTransfers: Map<string, FileSendTransferState>;
  getGatewayContext: () => {
    broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => void;
  } | null;
  fileInitEvent: string;
  fileAbortEvent: string;
  prepareOutboundTransfer: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
    hasGatewayContext: boolean;
  }) => Promise<PreparedOutboundTransfer>;
  sendChunk: (args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
    offset: number;
    size: number;
    chunkSha256: string;
    base64: string;
    connIds: ReadonlySet<string>;
  }) => void;
  sendComplete: (args: {
    transferId: string;
    accountId: string;
    connIds: ReadonlySet<string>;
  }) => void;
  waitForFileAck: (params: {
    transferId: string;
    stage: string;
    chunkIndex?: number;
    timeoutMs: number;
  }) => Promise<FileAckPayload>;
  logFileTransferChunkAck: (args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
  }) => void;
  logFileTransferChunkAckFail: (args: {
    transferId: string;
    accountId: string;
    chunkIndex: number;
    attempt: number;
    error: unknown;
  }) => void;
  logFileTransferCompleteAck: (args: {
    transferId: string;
    accountId: string;
    payload: { path: string };
  }) => void;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logEnqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: NormalizedReplyPayload;
  }) => void;
  enqueueOutbound: (entry: OutboxEntry) => void;
  buildOutboxEntry: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    type?: string;
    msg: string;
    kind?: 'tool' | 'block' | 'final';
    replyToId?: string;
    replyTargetPolicy?: OutboundReplyTargetPolicy;
    extra?: Record<string, unknown>;
    transferMode?: 'text' | 'media';
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    asVoice?: boolean;
    audioAsVoice?: boolean;
    downloadMedia?: boolean;
  }) => OutboxEntry;
  rememberRecentMediaSend: (args: {
    sessionKey: string;
    mediaUrl: string;
    text: string;
    replyToId: string;
    createdAt: number;
  }) => void;
  tryBuildMediaDedupeFallback: (args: {
    sessionKey: string;
    mediaUrl: string;
    text: string;
    replyToId: string;
    currentTime: number;
  }) => {
    text: string;
    reason: 'same-text-sent-checkmark' | 'text-changed-downgrade';
  } | null;
}) {
  const fileTransferOrchestrator = createBncrFileTransferOrchestrator({
    now: runtime.now,
    fileSendTransfers: runtime.fileSendTransfers,
    getGatewayContext: runtime.getGatewayContext,
    fileInitEvent: runtime.fileInitEvent,
    fileAbortEvent: runtime.fileAbortEvent,
    prepareOutboundTransfer: runtime.prepareOutboundTransfer,
    sendChunk: runtime.sendChunk,
    sendComplete: runtime.sendComplete,
    waitForFileAck: runtime.waitForFileAck,
    logFileTransferChunkAck: runtime.logFileTransferChunkAck,
    logFileTransferChunkAckFail: runtime.logFileTransferChunkAckFail,
    logFileTransferCompleteAck: runtime.logFileTransferCompleteAck,
  });

  const enqueueFromReply = async (params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: ReplyPayloadInput;
    mediaLocalRoots?: readonly string[];
    replyTargetPolicy?: OutboundReplyTargetPolicy;
  }) => {
    const { accountId, sessionKey, route, payload, mediaLocalRoots, replyTargetPolicy } = params;
    const normalized = await normalizeReplyOrchestratorPayload({
      payload,
      asString: runtime.asString,
      replyTargetPolicy,
    });

    enqueueNormalizedReplyPayload(
      {
        accountId,
        sessionKey,
        route,
        payload: normalized,
        mediaLocalRoots,
      },
      {
        logEnqueueFromReply: runtime.logEnqueueFromReply,
        enqueueOutbound: runtime.enqueueOutbound,
        buildOutboxEntry: runtime.buildOutboxEntry,
        tryBuildMediaDedupeFallback: runtime.tryBuildMediaDedupeFallback,
        rememberRecentMediaSend: runtime.rememberRecentMediaSend,
        logInfo: runtime.logInfo,
      },
    );
  };

  return {
    fileTransferOrchestrator,
    replyMediaOrchestrator: {
      enqueueFromReply,
    },
  };
}
