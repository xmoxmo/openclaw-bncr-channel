import { buildBncrDebugJsonMessage } from '../core/logging.ts';
import { isNoReplyDropText, isNoReplyMarkerText } from '../core/no-reply-marker.ts';
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

/** True when the payload carries media (so it is a media send). */
function hasReplyMedia(payload: NormalizedReplyPayload): boolean {
  return (
    payload.mediaList.length > 0 || Boolean(payload.mediaUrl) || Boolean(payload.mediaUrls?.length)
  );
}

/**
 * True when the payload is a pure text send whose body is the agent's NO_REPLY
 * marker. Media sends are never suppressed (their marker caption is stripped).
 */
function isNoReplyDropPayload(payload: NormalizedReplyPayload): boolean {
  if (hasReplyMedia(payload)) return false;
  return isNoReplyDropText(payload.text, payload.extra?.msg as string | undefined);
}

/**
 * Remove NO_REPLY marker text from a payload that still has a real body or media
 * to deliver. Covers media captions and the extra.msg alternate body. Returns
 * true when something was removed.
 */
function stripNoReplyMarkerFields(payload: NormalizedReplyPayload): boolean {
  let stripped = false;
  const hasMedia = hasReplyMedia(payload);
  const textIsMarker = isNoReplyMarkerText(payload.text);
  const textIsReal = payload.text.trim().length > 0 && !textIsMarker;
  const extra = payload.extra;
  const extraMsg = typeof extra?.msg === 'string' ? extra.msg.trim() : '';
  const extraIsMarker = Boolean(extraMsg) && isNoReplyMarkerText(extraMsg);

  // extra.msg overrides the outbox body, so a marker there would silence a real
  // text body or a media caption. Remove it whenever something real remains.
  if (extraIsMarker && (hasMedia || textIsReal)) {
    const next: Record<string, unknown> = { ...extra };
    delete next.msg;
    payload.extra = Object.keys(next).length > 0 ? next : undefined;
    stripped = true;
  }

  // Drop a marker caption/body when media or a real extra.msg body survives.
  if (textIsMarker && (hasMedia || (extraMsg.length > 0 && !extraIsMarker))) {
    payload.text = '';
    stripped = true;
  }
  return stripped;
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

    if (isNoReplyDropPayload(normalized)) {
      runtime.logInfo(
        'outbound',
        buildBncrDebugJsonMessage('no-reply-suppressed', {
          accountId,
          sessionKey,
          textLen: normalized.text.length,
          kind: normalized.kind,
        }),
        { debugOnly: true },
      );
      return;
    }

    if (stripNoReplyMarkerFields(normalized)) {
      runtime.logInfo(
        'outbound',
        buildBncrDebugJsonMessage('no-reply-caption-stripped', {
          accountId,
          sessionKey,
          kind: normalized.kind,
        }),
        { debugOnly: true },
      );
    }

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
