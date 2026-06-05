import fs from 'node:fs';
import { emitBncrLogLine } from '../../core/logging.ts';
import { resolveBncrChannelPolicy } from '../../core/policy.ts';
import {
  formatDisplayScope,
  normalizeInboundSessionKey,
  withTaskSessionKey,
} from '../../core/targets.ts';
import {
  readBncrSessionUpdatedAt,
  recordBncrInboundSession,
  resolveBncrInboundSessionStorePath,
  resolveBncrPinnedMainDmOwnerFromAllowlist,
} from '../../openclaw/inbound-session-runtime.ts';
import { saveOpenClawChannelMediaBuffer } from '../../openclaw/media-runtime.ts';
import {
  dispatchOpenClawReplyWithBufferedBlockDispatcher,
  formatOpenClawAgentEnvelope,
  resolveOpenClawEnvelopeFormatOptions,
} from '../../openclaw/reply-runtime.ts';
import {
  resolveOpenClawAgentRoute,
  resolveOpenClawInboundLastRouteSessionKey,
} from '../../openclaw/routing-runtime.ts';
import { handleBncrNativeCommand } from './commands.ts';
import {
  buildBncrPromptVisibleContextFacts,
  buildBncrStructuredContextFactsFromInboundParts,
} from './context-facts.ts';
import { buildBncrReplyConfig } from './reply-config.ts';
import { resolveBncrChannelInboundRuntime } from './runtime-compat.ts';
import { wrapBncrInboundRecordSessionLabelCorrection } from './session-label.ts';

type ParsedInbound = ReturnType<typeof import('./parse.ts')['parseBncrInboundParams']>;

type BncrInboundConversationResolution = {
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

type BncrInboundReplyRouteFact = {
  accountId: string;
  sessionKey: string;
  route: ParsedInbound['route'];
  canonicalTo: string;
  originatingTo: string;
  chatType: 'direct' | 'group';
};

const INBOUND_MEDIA_MAX_BYTES = 30 * 1024 * 1024;

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

function formatRawBncrInboundTarget(route: ParsedInbound['route']): string {
  return `Bncr:${String(route.platform || '').trim()}:${String(route.groupId || '').trim()}:${String(route.userId || '').trim()}`;
}

export function resolveBncrInboundConversation(args: {
  api: any;
  cfg: any;
  channelId: string;
  parsed: ParsedInbound;
  canonicalAgentId: string;
}) {
  const { api, cfg, channelId, parsed, canonicalAgentId } = args;
  const { accountId, route, peer, sessionKeyfromroute, providedOriginatingTo, extracted } = parsed;

  const resolvedRoute = resolveOpenClawAgentRoute(api, {
    cfg,
    channel: channelId,
    accountId,
    peer,
  });

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

async function prepareBncrInboundSessionContext(args: {
  api: any;
  cfg: any;
  parsed: ParsedInbound;
  resolution: BncrInboundConversationResolution;
  rememberSessionRoute: (sessionKey: string, accountId: string, route: any) => void;
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
    rawBody,
    body,
  };
}

function buildBncrInboundTurnContext(args: {
  api: any;
  channelId: string;
  parsed: ParsedInbound;
  msgId?: string | null;
  mimeType?: string;
  mediaPath?: string;
  peer: ParsedInbound['peer'];
  senderIdForContext: string;
  senderDisplayName: string;
  resolution: BncrInboundConversationResolution;
  prepared: {
    rawBody: string;
    body: string;
  };
}) {
  const {
    api,
    channelId,
    parsed,
    msgId,
    mimeType,
    mediaPath,
    peer,
    senderIdForContext,
    senderDisplayName,
    resolution,
    prepared,
  } = args;
  const structuredContextFacts = buildBncrStructuredContextFactsFromInboundParts({
    channelId,
    parsed,
    resolution,
    prepared: {
      rawBody: prepared.rawBody,
      body: prepared.body,
      mediaPath,
    },
    senderIdForContext,
    senderDisplayName,
  });
  const promptVisibleContextFacts = buildBncrPromptVisibleContextFacts(structuredContextFacts);
  const supplementalUntrustedContext = Object.keys(promptVisibleContextFacts).length
    ? [
        {
          label: 'Bncr inbound context',
          source: channelId,
          type: 'bncr.inbound_context',
          payload: promptVisibleContextFacts,
        },
      ]
    : [];

  return resolveBncrChannelInboundRuntime(api).buildContext({
    channel: channelId,
    provider: channelId,
    surface: channelId,
    accountId: resolution.accountId,
    messageId: msgId,
    timestamp: Date.now(),
    from: senderIdForContext,
    sender: {
      id: senderIdForContext,
      name: senderDisplayName,
      username: senderDisplayName,
    },
    conversation: {
      kind: resolution.chatType,
      id: peer.id,
      label: resolution.canonicalTo,
      routePeer: {
        kind: peer.kind,
        id: peer.id,
      },
    },
    route: {
      agentId: resolution.resolvedRoute.agentId,
      accountId: resolution.accountId,
      routeSessionKey: resolution.resolvedRoute.sessionKey,
      dispatchSessionKey: resolution.dispatchSessionKey,
      mainSessionKey: resolution.resolvedRoute.mainSessionKey,
    },
    reply: {
      to: resolution.canonicalTo,
      originatingTo: resolution.originatingTo,
    },
    message: {
      inboundEventKind: 'user_request',
      body: prepared.body,
      rawBody: prepared.rawBody,
      bodyForAgent: prepared.rawBody,
      commandBody: prepared.rawBody,
      envelopeFrom: resolution.originatingTo,
      senderLabel: senderDisplayName,
    },
    media: mediaPath
      ? [
          {
            path: mediaPath,
            contentType: mimeType,
            kind: mimeType?.startsWith('image/')
              ? 'image'
              : mimeType?.startsWith('video/')
                ? 'video'
                : mimeType?.startsWith('audio/')
                  ? 'audio'
                  : 'document',
            messageId: msgId ?? undefined,
          },
        ]
      : [],
    supplemental: {
      untrustedContext: supplementalUntrustedContext,
    },
    extra: {
      OriginatingChannel: channelId,
      BncrStructuredContextFacts: structuredContextFacts,
      StructuredContextFacts: structuredContextFacts,
    },
  });
}

function buildBncrInboundRecordUpdateLastRoute(args: {
  channelId: string;
  peer: ParsedInbound['peer'];
  senderIdForContext: string;
  resolution: BncrInboundConversationResolution;
  pinnedMainDmOwner: string | null;
}) {
  const { channelId, peer, senderIdForContext, resolution, pinnedMainDmOwner } = args;
  if (peer.kind !== 'direct') return undefined;

  const sessionKey = resolveOpenClawInboundLastRouteSessionKey({
    route: resolution.resolvedRoute,
    sessionKey: resolution.dispatchSessionKey,
  });

  return {
    sessionKey,
    channel: channelId,
    to: resolution.canonicalTo,
    accountId: resolution.accountId,
    mainDmOwnerPin:
      sessionKey === resolution.resolvedRoute.mainSessionKey && pinnedMainDmOwner
        ? {
            ownerRecipient: pinnedMainDmOwner,
            senderRecipient: senderIdForContext,
          }
        : undefined,
  };
}

function buildBncrInboundReplyRouteFact(
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

export async function dispatchBncrInbound(params: {
  api: any;
  channelId: string;
  cfg: any;
  parsed: ParsedInbound;
  canonicalAgentId: string;
  rememberSessionRoute: (sessionKey: string, accountId: string, route: any) => void;
  enqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: any;
    payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
    mediaLocalRoots?: readonly string[];
  }) => Promise<void>;
  setInboundActivity: (accountId: string, at: number) => void;
  scheduleSave: () => void;
  logger?: { warn?: (msg: string) => void; error?: (msg: string) => void };
}) {
  const {
    api,
    channelId,
    cfg,
    parsed,
    canonicalAgentId,
    rememberSessionRoute,
    enqueueFromReply,
    setInboundActivity,
    scheduleSave,
    logger,
  } = params;
  const { accountId, clientId, msgId, extracted, mimeType, peer } = parsed;

  const nativeCommand = await handleBncrNativeCommand({
    api,
    channelId,
    cfg,
    parsed,
    canonicalAgentId,
    rememberSessionRoute,
    enqueueFromReply,
    logger,
  });
  if (nativeCommand.handled && !nativeCommand.fallbackToAgent) {
    const inboundAt = Date.now();
    setInboundActivity(accountId, inboundAt);
    scheduleSave();
    return {
      accountId,
      sessionKey: nativeCommand.sessionKey,
      taskKey: extracted.taskKey ?? null,
      msgId: msgId ?? null,
    };
  }

  const resolution = resolveBncrInboundConversation({
    api,
    cfg,
    channelId,
    parsed,
    canonicalAgentId,
  });
  const { resolvedRoute, canonicalTo, dispatchSessionKey: sessionKey } = resolution;
  const prepared = await prepareBncrInboundSessionContext({
    api,
    cfg,
    parsed,
    resolution,
    rememberSessionRoute,
  });
  const { storePath, mediaPath, rawBody } = prepared;
  const replyRouteFact = buildBncrInboundReplyRouteFact(resolution);
  if (!clientId) {
    emitBncrLogLine(
      'warn',
      '[bncr] inbound missing clientId for chat identity; using route identity fallback',
    );
  }
  const senderIdForContext = clientId || canonicalTo;
  const senderDisplayName = clientId ? 'bncr-client' : canonicalTo;
  const ctxPayload = buildBncrInboundTurnContext({
    api,
    channelId,
    parsed,
    msgId,
    mimeType,
    mediaPath,
    peer,
    senderIdForContext,
    senderDisplayName,
    resolution,
    prepared,
  });

  const effectiveReply = buildBncrReplyConfig(cfg);
  const channelPolicy = resolveBncrChannelPolicy(cfg?.channels?.bncr || {});
  const pinnedMainDmOwner =
    peer.kind === 'direct'
      ? resolveBncrPinnedMainDmOwnerFromAllowlist({
          dmScope: cfg?.session?.dmScope,
          allowFrom: channelPolicy.allowFrom,
          normalizeEntry: (entry: string) => String(entry || '').trim(),
        })
      : null;
  const updateLastRoute = buildBncrInboundRecordUpdateLastRoute({
    channelId,
    peer,
    senderIdForContext,
    resolution,
    pinnedMainDmOwner,
  });

  await resolveBncrChannelInboundRuntime(api).run({
    channel: channelId,
    accountId,
    raw: parsed,
    adapter: {
      ingest: () => ({
        id: msgId ?? `${canonicalTo}:${Date.now()}`,
        timestamp: Date.now(),
        rawText: rawBody,
        textForAgent: ctxPayload.BodyForAgent,
        textForCommands: ctxPayload.CommandBody,
        raw: parsed,
      }),
      resolveTurn: () => ({
        channel: channelId,
        accountId,
        routeSessionKey: resolvedRoute.sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession: wrapBncrInboundRecordSessionLabelCorrection({
          recordInboundSession: recordBncrInboundSession,
          expectedLabel: canonicalTo,
        }),
        record: {
          updateLastRoute,
          onRecordError: (err: unknown) => {
            emitBncrLogLine('warn', `[bncr] inbound record session failed: ${String(err)}`);
          },
        },
        runDispatch: () =>
          dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
            ctx: ctxPayload,
            cfg: effectiveReply.replyCfg,
            dispatcherOptions: {
              deliver: async (
                payload: {
                  text?: string;
                  mediaUrl?: string;
                  mediaUrls?: string[];
                  audioAsVoice?: boolean;
                },
                info?: { kind?: 'tool' | 'block' | 'final' },
              ) => {
                const kind = info?.kind;
                const shouldForwardTool = effectiveReply.blockStreaming && effectiveReply.allowTool;

                if (kind === 'tool' && !shouldForwardTool) {
                  return;
                }

                await enqueueFromReply({
                  accountId: replyRouteFact.accountId,
                  sessionKey: replyRouteFact.sessionKey,
                  route: replyRouteFact.route,
                  payload: {
                    ...payload,
                    kind: kind as 'tool' | 'block' | 'final' | undefined,
                    replyToId: msgId || undefined,
                  },
                });
              },
              onError: (err: unknown) => {
                emitBncrLogLine('error', `[bncr] outbound reply failed: ${String(err)}`);
              },
            },
            replyOptions: {
              disableBlockStreaming: !effectiveReply.blockStreaming,
              shouldEmitToolResult: effectiveReply.allowTool ? () => true : undefined,
            },
          }),
      }),
      onFinalize: () => {
        const inboundAt = Date.now();
        setInboundActivity(accountId, inboundAt);
        scheduleSave();
      },
    },
  });

  return {
    accountId,
    sessionKey,
    taskKey: extracted.taskKey ?? null,
    msgId: msgId ?? null,
  };
}
