import fs from 'node:fs';
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
import { loadInboundRemoteMedia } from './remote-media.ts';

export type ParsedInbound = ReturnType<typeof import('./parse.ts')['parseBncrInboundParams']>;

export type BncrInboundConversationResolution = {
  accountId: string;
  chatType: 'direct' | 'group';
  route: ParsedInbound['route'];
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
  originatingTo: string;
  chatType: 'direct' | 'group';
};

export type BncrPreparedInboundSessionContext = {
  storePath: string;
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
};

const INBOUND_MEDIA_MAX_BYTES = 30 * 1024 * 1024;

function assertResolvedAgentRoute(resolvedRoute: OpenClawResolvedAgentRoute): {
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

export function resolveBncrInboundConversation(args: {
  api: BncrInboundApi;
  cfg: BncrInboundConfig;
  channelId: string;
  parsed: ParsedInbound;
  canonicalAgentId: string;
}) {
  const { api, cfg, channelId, parsed, canonicalAgentId } = args;
  const { accountId, route, peer, sessionKeyfromroute, providedOriginatingTo, extracted } = parsed;

  const resolvedRoute = assertResolvedAgentRoute(
    resolveOpenClawAgentRoute(api, {
      cfg,
      channel: channelId,
      accountId,
      peer,
    }),
  );

  const baseSessionKey =
    normalizeInboundSessionKey(sessionKeyfromroute, route, canonicalAgentId) ||
    resolvedRoute.sessionKey;
  const taskSessionKey = withTaskSessionKey(baseSessionKey, extracted.taskKey);
  const dispatchSessionKey = taskSessionKey || baseSessionKey;
  const rawTo = formatRawBncrInboundTarget(route);
  const canonicalTo = formatDisplayScope(route);
  const originatingTo = providedOriginatingTo || rawTo;

  return {
    accountId,
    chatType: peer.kind,
    route,
    resolvedRoute,
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

  let mediaPath: string | undefined;
  let mediaContentType = mimeType;
  if (mediaBase64) {
    const mediaBuf = decodeInboundMediaBase64(mediaBase64);
    const saved = await saveOpenClawChannelMediaBuffer(
      api,
      mediaBuf,
      mimeType,
      'inbound',
      30 * 1024 * 1024,
      fileName,
    );
    mediaPath = saved.path;
  } else if (mediaPathFromTransfer && isHttpMediaUrl(mediaPathFromTransfer)) {
    const downloaded = await loadInboundRemoteMedia(
      api,
      mediaPathFromTransfer,
      INBOUND_MEDIA_URL_MAX_BYTES,
    );
    mediaContentType = downloaded.contentType || mimeType;
    const saved = await saveOpenClawChannelMediaBuffer(
      api,
      downloaded.buffer,
      mediaContentType,
      'inbound',
      INBOUND_MEDIA_URL_MAX_BYTES,
      fileName,
    );
    mediaPath = saved.path;
  } else if (mediaPathFromTransfer && fs.existsSync(mediaPathFromTransfer)) {
    mediaPath = mediaPathFromTransfer;
  }

  const rawBody = extracted.text || (msgType === 'text' ? '' : `[${msgType}]`);
  const body = formatOpenClawAgentEnvelope(api, {
    channel: 'Bncr',
    from: `${platform}:${groupId}:${userId}`,
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
  rememberSessionRoute: BncrRememberSessionRoute;
}) {
  const { api, channelId, cfg, parsed, canonicalAgentId, rememberSessionRoute } = args;
  const resolution = resolveBncrInboundConversation({
    api,
    cfg,
    channelId,
    parsed,
    canonicalAgentId,
  });
  const prepared = await prepareBncrInboundSessionContext({
    api,
    cfg,
    parsed,
    resolution,
    rememberSessionRoute,
  });
  const replyRouteFact = buildBncrInboundReplyRouteFact(resolution);
  const senderIdForContext = parsed.clientId || resolution.canonicalTo;
  const senderDisplayName = parsed.clientId ? 'bncr-client' : resolution.canonicalTo;

  return {
    resolution,
    prepared,
    replyRouteFact,
    senderIdForContext,
    senderDisplayName,
  } satisfies BncrInboundPreparation;
}
