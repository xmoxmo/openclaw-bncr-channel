import type { BncrRoute, FileSendTransferState, OutboxEntry } from '../core/types.ts';
import { normalizeMessageText } from '../messaging/outbound/media-dedupe.ts';
import type {
  NormalizedReplyPayload,
  OutboundReplyTargetPolicy,
  ReplyMediaEntriesParams,
  ReplyPayloadInput,
} from '../messaging/outbound/reply-enqueue.ts';
import {
  enqueueNormalizedReplyPayload,
  enqueueReplyTextEntry,
  normalizeReplyPayload,
} from '../messaging/outbound/reply-enqueue.ts';
import {
  enqueueReplyMediaFallbackTextEntry,
  enqueueReplyMediaFileTransferEntry,
  enqueueSingleReplyMediaEntry,
} from '../messaging/outbound/reply-enqueue-media.ts';
import type { createBncrFileAckRuntime } from './file-ack-runtime.ts';
import { createBncrFileTransferOrchestrator } from './file-transfer-orchestrator.ts';
import type { createBncrFileTransferSetup } from './file-transfer-setup.ts';

type PreparedOutboundTransfer = Awaited<
  ReturnType<ReturnType<typeof createBncrFileTransferSetup>['prepareOutboundTransfer']>
>;
type FileAckPayload = Awaited<
  ReturnType<ReturnType<typeof createBncrFileAckRuntime>['waitForFileAck']>
>;

function buildReplyMediaEntryHelpers(runtime: {
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  enqueueOutbound: (entry: OutboxEntry) => void;
  buildTextOutboxEntry: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    text: string;
    kind?: 'tool' | 'block' | 'final';
    replyToId?: string;
    replyTargetPolicy?: OutboundReplyTargetPolicy;
  }) => OutboxEntry;
  buildFileTransferOutboxEntry: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
    text: string;
    asVoice: boolean;
    audioAsVoice: boolean;
    type?: string;
    extra?: Record<string, unknown>;
    kind?: 'tool' | 'block' | 'final';
    replyToId?: string;
    replyTargetPolicy?: OutboundReplyTargetPolicy;
    downloadMedia?: boolean;
  }) => OutboxEntry;
  rememberRecentMediaSend: (args: {
    sessionKey: string;
    mediaUrl: string;
    text: string;
    replyToId: string;
    createdAt: number;
  }) => void;
}) {
  return {
    enqueueReplyMediaFallbackTextEntry: (
      params: Parameters<typeof enqueueReplyMediaFallbackTextEntry>[0],
    ) =>
      enqueueReplyMediaFallbackTextEntry(params, {
        logInfo: runtime.logInfo,
        enqueueOutbound: runtime.enqueueOutbound,
        buildTextOutboxEntry: runtime.buildTextOutboxEntry,
      }),
    enqueueReplyMediaFileTransferEntry: (
      params: Parameters<typeof enqueueReplyMediaFileTransferEntry>[0],
    ) =>
      enqueueReplyMediaFileTransferEntry(params, {
        enqueueOutbound: runtime.enqueueOutbound,
        buildFileTransferOutboxEntry: runtime.buildFileTransferOutboxEntry,
        rememberRecentMediaSend: runtime.rememberRecentMediaSend,
      }),
  };
}

function buildReplyTextEntryHelper(runtime: {
  enqueueOutbound: (entry: OutboxEntry) => void;
  buildTextOutboxEntry: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    text: string;
    kind?: 'tool' | 'block' | 'final';
    replyToId?: string;
    replyTargetPolicy?: OutboundReplyTargetPolicy;
  }) => OutboxEntry;
}) {
  return (params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: NormalizedReplyPayload;
  }) =>
    enqueueReplyTextEntry(params, {
      enqueueOutbound: runtime.enqueueOutbound,
      buildTextOutboxEntry: runtime.buildTextOutboxEntry,
    });
}

function normalizeReplyOrchestratorPayload(args: {
  payload: ReplyPayloadInput;
  asString: (value: unknown, fallback?: string) => string;
  replyTargetPolicy?: OutboundReplyTargetPolicy;
}) {
  return normalizeReplyPayload(
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
  buildTextOutboxEntry: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    text: string;
    kind?: 'tool' | 'block' | 'final';
    replyToId?: string;
    replyTargetPolicy?: OutboundReplyTargetPolicy;
  }) => OutboxEntry;
  buildFileTransferOutboxEntry: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
    text: string;
    asVoice: boolean;
    audioAsVoice: boolean;
    type?: string;
    extra?: Record<string, unknown>;
    kind?: 'tool' | 'block' | 'final';
    replyToId?: string;
    replyTargetPolicy?: OutboundReplyTargetPolicy;
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

  const replyMediaEntryHelpers = buildReplyMediaEntryHelpers(runtime);
  const replyTextEntryHelper = buildReplyTextEntryHelper(runtime);

  const enqueueReplyMediaEntries = (params: ReplyMediaEntriesParams) => {
    let first = true;
    const currentTime = runtime.now();

    for (const mediaUrl of params.payload.mediaList) {
      const normalizedText = normalizeMessageText(first ? params.payload.text : '');
      const fallback = runtime.tryBuildMediaDedupeFallback({
        sessionKey: params.sessionKey,
        mediaUrl,
        text: normalizedText,
        replyToId: params.payload.replyToId,
        currentTime,
      });

      enqueueSingleReplyMediaEntry(
        {
          params,
          mediaUrl,
          normalizedText,
          text: first ? params.payload.text : '',
          fallback,
          currentTime,
        },
        replyMediaEntryHelpers,
      );

      first = false;
    }
  };

  const enqueueFromReply = (params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: ReplyPayloadInput;
    mediaLocalRoots?: readonly string[];
    replyTargetPolicy?: OutboundReplyTargetPolicy;
  }) => {
    const { accountId, sessionKey, route, payload, mediaLocalRoots, replyTargetPolicy } = params;
    const normalized = normalizeReplyOrchestratorPayload({
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
        enqueueReplyMediaEntries,
        enqueueReplyTextEntry: replyTextEntryHelper,
      },
    );
  };

  const replyMediaOrchestrator = {
    enqueueFromReply,
    enqueueReplyMediaEntries,
  };

  return {
    fileTransferOrchestrator,
    replyMediaOrchestrator,
  };
}
