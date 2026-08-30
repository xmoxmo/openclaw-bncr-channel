import fs from 'node:fs';
import { hasControlCommand } from 'openclaw/plugin-sdk/command-auth';
import {
  formatDisplayScope,
  normalizeInboundSessionKey,
  withTaskSessionKey,
} from '../../core/targets.ts';
import {
  readBncrSessionUpdatedAt,
  resolveBncrInboundSessionStorePath,
} from '../../openclaw/inbound-session-runtime.ts';
import { saveOpenClawChannelMediaBuffer } from '../../openclaw/media-runtime.ts';
import {
  formatOpenClawAgentEnvelope,
  resolveOpenClawEnvelopeFormatOptions,
} from '../../openclaw/reply-runtime.ts';
import {
  type OpenClawResolvedAgentRoute,
  resolveOpenClawAgentRoute,
} from '../../openclaw/routing-runtime.ts';
import type { BncrInboundApi, BncrInboundConfig, BncrRememberSessionRoute } from './contracts.ts';
import { INBOUND_MEDIA_URL_MAX_BYTES, isHttpMediaUrl } from './media-url-download.ts';
import { parseBncrNativeCommand, resolveBncrNativeCommandParseOptions } from './native-command.ts';
import { loadInboundRemoteMedia } from './remote-media.ts';

export type ParsedInbound = ReturnType<typeof import('./parse.ts')['parseBncrInboundParams']>;

export type BncrInboundConversationResolution = {
  accountId: string;
  chatType: 'direct' | 'group';
  route: ParsedInbound['route'];
  originalResolvedRouteSessionKey: string;
  resolvedRoute: {
    sessionKey: string;
    agentId: string;
    mainSessionKey?: string;
  };
  canonicalTo: string;
  rawTo: string;
  originatingTo: string;
  baseSessionKey: string;
  taskSessionKey?: string;
  dispatchSessionKey: string;
};

export type BncrInboundReplyRouteFact = {
  accountId: string;
  sessionKey: string;
  route: ParsedInbound['route'];
  canonicalTo: string;
  rawTo: string;
  originatingTo: string;
  chatType: 'direct' | 'group';
};

export type BncrPreparedInboundSessionContext = {
  storePath: string;
  mediaItems: Array<{
    path: string;
    contentType?: string;
    fileName?: string;
    kind: 'image' | 'video' | 'audio' | 'document';
    transferId?: string;
  }>;
  mediaPath?: string;
  mediaContentType?: string;
  rawBody: string;
  body: string;
};

export type BncrInboundPreparation = {
  resolution: BncrInboundConversationResolution;
  prepared: BncrPreparedInboundSessionContext;
  replyRouteFact: BncrInboundReplyRouteFact;
  senderIdForContext: string;
  senderDisplayName: string;
  ownerAllowFrom?: string[];
  bridgeSenderId?: string;
  bridgeSenderName?: string;
};

const INBOUND_MEDIA_MAX_BYTES = 30 * 1024 * 1024;

const BNCR_GENERIC_MEDIA_TEXTS = new Set([
  '收到媒体文件',
  '收到图片',
  '收到视频',
  '收到语音',
  '收到音频',
  '收到文件',
  '[图片]',
  '[视频]',
  '[语音]',
  '[音频]',
  '[文件]',
]);

export function assertResolvedAgentRoute(resolvedRoute: OpenClawResolvedAgentRoute): {
  sessionKey: string;
  agentId: string;
  mainSessionKey?: string;
} {
  const sessionKey =
    typeof resolvedRoute.sessionKey === 'string' ? resolvedRoute.sessionKey.trim() : '';
  const agentId = typeof resolvedRoute.agentId === 'string' ? resolvedRoute.agentId.trim() : '';
  if (!sessionKey) throw new Error('OpenClaw resolveAgentRoute returned empty sessionKey');
  if (!agentId) throw new Error('OpenClaw resolveAgentRoute returned empty agentId');
  return {
    sessionKey,
    agentId,
    ...(typeof resolvedRoute.mainSessionKey === 'string' && resolvedRoute.mainSessionKey.trim()
      ? { mainSessionKey: resolvedRoute.mainSessionKey }
      : {}),
  };
}

function formatRawBncrInboundTarget(route: ParsedInbound['route']): string {
  return `Bncr:${String(route.platform || '').trim()}:${String(route.groupId || '').trim()}:${String(route.userId || '').trim()}`;
}

function inferBncrInboundMediaKind(args: {
  msgType?: string;
  mediaContentType?: string;
}): 'image' | 'video' | 'audio' | 'document' {
  const msgType = String(args.msgType || '')
    .trim()
    .toLowerCase();
  const contentType = String(args.mediaContentType || '')
    .trim()
    .toLowerCase();
  if (msgType === 'image' || contentType.startsWith('image/')) return 'image';
  if (msgType === 'video' || contentType.startsWith('video/')) return 'video';
  if (msgType === 'audio' || msgType === 'voice' || contentType.startsWith('audio/'))
    return 'audio';
  return 'document';
}

function isBncrGenericMediaText(value: string): boolean {
  const normalized = String(value || '').trim();
  if (!normalized) return true;
  return BNCR_GENERIC_MEDIA_TEXTS.has(normalized);
}

function resolveBncrInboundRawBody(args: {
  extractedText?: string;
  msgType?: string;
  mediaItems?: Array<{ contentType?: string; kind?: string }>;
}) {
  const text = String(args.extractedText || '').trim();
  if (
    String(args.msgType || 'text')
      .trim()
      .toLowerCase() === 'text'
  )
    return text;
  if (text && !isBncrGenericMediaText(text)) return text;
  const items = Array.isArray(args.mediaItems) ? args.mediaItems : [];
  if (items.length === 0) {
    const mediaKind = inferBncrInboundMediaKind({
      msgType: args.msgType,
      mediaContentType: undefined,
    });
    return `<media:${mediaKind}>`;
  }
  const kinds = items
    .map((item) =>
      String(item?.kind || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  const contentTypes = items.map((item) => String(item?.contentType || '').trim()).filter(Boolean);
  const firstKind =
    kinds[0] ||
    inferBncrInboundMediaKind({
      msgType: args.msgType,
      mediaContentType: contentTypes[0],
    });
  const uniformKind =
    kinds.length > 0 && kinds.every((candidate) => candidate === firstKind)
      ? firstKind
      : 'document';
  const count = Math.max(items.length, 1);
  if (count <= 1) return `<media:${uniformKind}>`;
  if (uniformKind === 'image') return `<media:image> (${count} images)`;
  if (uniformKind === 'video') return `<media:video> (${count} videos)`;
  if (uniformKind === 'audio') return `<media:audio> (${count} audio attachments)`;
  return `<media:document> (${count} attachments)`;
}

async function saveBncrInboundMediaItem(args: {
  api: BncrInboundApi;
  item: ParsedInbound['mediaItems'][number];
}) {
  const pathFromTransfer = String(args.item?.path || '').trim();
  const base64 = String(args.item?.base64 || '').trim();
  const mimeType = String(args.item?.mimeType || '').trim() || undefined;
  const fileName = String(args.item?.fileName || '').trim() || undefined;
  const transferId = String(args.item?.transferId || '').trim() || undefined;
  let mediaPath: string | undefined;
  let mediaContentType = mimeType;
  if (base64) {
    const mediaBuf = decodeInboundMediaBase64(base64);
    const saved = await saveOpenClawChannelMediaBuffer(
      args.api,
      mediaBuf,
      mimeType,
      'inbound',
      30 * 1024 * 1024,
      fileName,
    );
    mediaPath = saved.path;
  } else if (pathFromTransfer && isHttpMediaUrl(pathFromTransfer)) {
    const downloaded = await loadInboundRemoteMedia(
      args.api,
      pathFromTransfer,
      INBOUND_MEDIA_URL_MAX_BYTES,
    );
    mediaContentType = downloaded.contentType || mimeType;
    const saved = await saveOpenClawChannelMediaBuffer(
      args.api,
      downloaded.buffer,
      mediaContentType,
      'inbound',
      INBOUND_MEDIA_URL_MAX_BYTES,
      fileName,
    );
    mediaPath = saved.path;
  } else if (pathFromTransfer && fs.existsSync(pathFromTransfer)) {
    mediaPath = pathFromTransfer;
  }
  if (!mediaPath) return null;
  const kind = inferBncrInboundMediaKind({
    msgType: String(args.item?.type || '').trim(),
    mediaContentType: mediaContentType || mimeType,
  });
  return {
    path: mediaPath,
    ...(mediaContentType ? { contentType: mediaContentType } : {}),
    ...(fileName ? { fileName } : {}),
    kind,
    ...(transferId ? { transferId } : {}),
  };
}

export function resolveBncrInboundConversation(args: {
  api: BncrInboundApi;
  cfg: BncrInboundConfig;
  channelId: string;
  parsed: ParsedInbound;
  canonicalAgentId: string;
  resolvedAgentId?: string;
}) {
  const { api, cfg, channelId, parsed, canonicalAgentId, resolvedAgentId } = args;
  const { accountId, route, peer, sessionKeyfromroute, providedOriginatingTo, extracted } = parsed;

  const resolvedRoute = assertResolvedAgentRoute(
    resolveOpenClawAgentRoute(api, {
      cfg,
      channel: channelId,
      accountId,
      peer,
    }),
  );

  const targetAgentId = (resolvedAgentId || '').trim() || resolvedRoute.agentId || canonicalAgentId;
  const baseSessionKey =
    normalizeInboundSessionKey(sessionKeyfromroute, route, targetAgentId) ||
    resolvedRoute.sessionKey;
  const taskSessionKey = withTaskSessionKey(baseSessionKey, extracted.taskKey);
  const dispatchSessionKey = taskSessionKey || baseSessionKey;
  const rawTo = formatRawBncrInboundTarget(route);
  const canonicalTo = formatDisplayScope(route);
  const originatingTo = providedOriginatingTo || canonicalTo;

  return {
    accountId,
    chatType: peer.kind,
    route,
    originalResolvedRouteSessionKey: resolvedRoute.sessionKey,
    resolvedRoute: {
      ...resolvedRoute,
      agentId: targetAgentId || resolvedRoute.agentId,
      sessionKey: baseSessionKey || resolvedRoute.sessionKey,
    },
    canonicalTo,
    rawTo,
    originatingTo,
    baseSessionKey,
    ...(taskSessionKey ? { taskSessionKey } : {}),
    dispatchSessionKey,
  } satisfies BncrInboundConversationResolution;
}

export function estimateBase64DecodedBytes(value: string): number {
  const normalized = String(value || '').replace(/\s+/g, '');
  if (!normalized) return 0;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

export function assertInboundMediaBase64Size(value: string, maxBytes = INBOUND_MEDIA_MAX_BYTES) {
  const estimatedBytes = estimateBase64DecodedBytes(value);
  if (estimatedBytes > maxBytes) {
    throw new Error(
      `inbound media too large: estimated ${estimatedBytes} bytes exceeds ${maxBytes} bytes`,
    );
  }
}

export function decodeInboundMediaBase64(
  value: string,
  maxBytes = INBOUND_MEDIA_MAX_BYTES,
): Buffer {
  assertInboundMediaBase64Size(value, maxBytes);
  const normalized = String(value || '').replace(/\s+/g, '');
  const mediaBuf = Buffer.from(normalized, 'base64');
  if (!mediaBuf.length) {
    throw new Error('inbound media base64 decoded to empty buffer');
  }
  if (mediaBuf.length > maxBytes) {
    throw new Error(
      `inbound media too large: decoded ${mediaBuf.length} bytes exceeds ${maxBytes} bytes`,
    );
  }
  return mediaBuf;
}

export async function prepareBncrInboundSessionContext(args: {
  api: BncrInboundApi;
  cfg: BncrInboundConfig;
  parsed: ParsedInbound;
  resolution: BncrInboundConversationResolution;
  rememberSessionRoute: BncrRememberSessionRoute;
}) {
  const { api, cfg, parsed, resolution, rememberSessionRoute } = args;
  const {
    msgType,
    mediaBase64,
    mediaPathFromTransfer,
    mimeType,
    fileName,
    extracted,
    platform,
    groupId,
    userId,
  } = parsed;
  const { accountId, route, resolvedRoute, baseSessionKey, taskSessionKey, dispatchSessionKey } =
    resolution;

  rememberSessionRoute(baseSessionKey, accountId, route);
  if (taskSessionKey && taskSessionKey !== baseSessionKey) {
    rememberSessionRoute(taskSessionKey, accountId, route);
  }

  const storePath = resolveBncrInboundSessionStorePath({
    storeConfig: cfg?.session?.store,
    agentId: resolvedRoute.agentId,
  });

  const parsedMediaItems = Array.isArray(parsed.mediaItems) ? parsed.mediaItems : [];
  const fallbackMediaItems =
    parsedMediaItems.length > 0
      ? parsedMediaItems
      : [
          {
            ...(mediaPathFromTransfer ? { path: mediaPathFromTransfer } : {}),
            ...(mediaBase64 ? { base64: mediaBase64 } : {}),
            ...(mimeType ? { mimeType } : {}),
            ...(fileName ? { fileName } : {}),
            ...(msgType ? { type: msgType } : {}),
          },
        ];
  const mediaItems = (
    await Promise.all(
      fallbackMediaItems.map((item) =>
        saveBncrInboundMediaItem({
          api,
          item,
        }),
      ),
    )
  ).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const primaryMedia = mediaItems[0];
  const mediaPath = primaryMedia?.path;
  const mediaContentType = primaryMedia?.contentType || mimeType;

  const rawBody = resolveBncrInboundRawBody({
    extractedText: extracted.text,
    msgType,
    mediaItems,
  });
  const body = formatOpenClawAgentEnvelope(api, {
    channel: 'Bncr',
    from:
      (parsed.userId
        ? `${parsed.userName} (${parsed.userId})`
        : parsed.userName || `${platform}:${groupId}:${userId}`) +
      (parsed.msgId ? ` #${parsed.msgId}` : ''),
    timestamp: Date.now(),
    previousTimestamp: readBncrSessionUpdatedAt(api, {
      storePath,
      sessionKey: dispatchSessionKey,
    }),
    envelope: resolveOpenClawEnvelopeFormatOptions(api, cfg),
    body: rawBody,
  });

  return {
    storePath,
    mediaItems,
    mediaPath,
    mediaContentType,
    rawBody,
    body,
  } satisfies BncrPreparedInboundSessionContext;
}

export function buildBncrInboundReplyRouteFact(
  resolution: BncrInboundConversationResolution,
): BncrInboundReplyRouteFact {
  return {
    accountId: resolution.accountId,
    sessionKey: resolution.dispatchSessionKey,
    route: resolution.route,
    canonicalTo: resolution.canonicalTo,
    rawTo: resolution.rawTo,
    originatingTo: resolution.originatingTo,
    chatType: resolution.chatType,
  };
}

export async function prepareBncrInboundDispatch(args: {
  api: BncrInboundApi;
  channelId: string;
  cfg: BncrInboundConfig;
  parsed: ParsedInbound;
  canonicalAgentId: string;
  resolvedAgentId?: string;
  rememberSessionRoute: BncrRememberSessionRoute;
}) {
  const { api, channelId, cfg, parsed, canonicalAgentId, resolvedAgentId, rememberSessionRoute } =
    args;
  const resolution = resolveBncrInboundConversation({
    api,
    cfg,
    channelId,
    parsed,
    canonicalAgentId,
    resolvedAgentId,
  });
  const prepared = await prepareBncrInboundSessionContext({
    api,
    cfg,
    parsed,
    resolution,
    rememberSessionRoute,
  });
  const replyRouteFact = buildBncrInboundReplyRouteFact(resolution);
  const senderIdForContext = parsed.userId || parsed.clientId || resolution.canonicalTo;
  const senderDisplayName = parsed.userName || resolution.canonicalTo;
  const isBncrNativeCommand =
    parseBncrNativeCommand(
      parsed.extracted.text,
      resolveBncrNativeCommandParseOptions({
        isAdmin: parsed.isAdmin,
        peerKind: parsed.peer.kind as 'direct' | 'group',
      }),
    ) !== null;
  const isOpenClawNativeCommand =
    !isBncrNativeCommand &&
    hasControlCommand(parsed.extracted.text, cfg as Parameters<typeof hasControlCommand>[1]);
  const ownerAllowFrom =
    parsed.isAdmin === true && isOpenClawNativeCommand && senderIdForContext
      ? [senderIdForContext]
      : undefined;

  return {
    resolution,
    prepared,
    replyRouteFact,
    senderIdForContext,
    senderDisplayName,
    ...(ownerAllowFrom ? { ownerAllowFrom } : {}),
    bridgeSenderId: parsed.bridgeId || parsed.clientId,
    bridgeSenderName: parsed.bridgeName || 'Bncr',
  } satisfies BncrInboundPreparation;
}
