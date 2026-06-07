import { emitBncrLogLine } from '../../core/logging.ts';
import { resolveBncrChannelPolicy } from '../../core/policy.ts';
import {
  formatDisplayScope,
  normalizeInboundSessionKey,
  withTaskSessionKey,
} from '../../core/targets.ts';
import {
  recordBncrInboundSession,
  resolveBncrInboundSessionStorePath,
  resolveBncrPinnedMainDmOwnerFromAllowlist,
} from '../../openclaw/inbound-session-runtime.ts';
import { dispatchOpenClawReplyWithBufferedBlockDispatcher } from '../../openclaw/reply-runtime.ts';
import { resolveOpenClawAgentRoute } from '../../openclaw/routing-runtime.ts';
import type { OutboundReplyTargetPolicy } from '../outbound/reply-target-policy.ts';
import { buildBncrInboundRecordUpdateLastRoute } from './last-route.ts';
import { parseBncrNativeCommand, resolveBncrNativeVerboseCommand } from './native-command.ts';
import { buildBncrNativeReplyDeliveryPayload } from './native-reply-delivery.ts';
import { buildBncrReplyConfig } from './reply-config.ts';
import { resolveBncrChannelInboundRuntime } from './runtime-compat.ts';
import {
  buildBncrInboundSessionIdentityPatch,
  recordAndPatchBncrInboundSessionEntry,
  wrapBncrInboundRecordSessionLabelCorrection,
} from './session-label.ts';

type ParsedInbound = ReturnType<typeof import('./parse.ts')['parseBncrInboundParams']>;

function logBncrNativeCommandEvent(
  event: string,
  fields: Record<string, unknown>,
  options?: { debugOnly?: boolean; debugEnabled?: boolean },
) {
  if (options?.debugOnly && !options?.debugEnabled) return;
  emitBncrLogLine('info', `[bncr] native-command ${JSON.stringify({ event, ...fields })}`);
}

export { parseBncrNativeCommand } from './native-command.ts';

export async function handleBncrNativeCommand(params: {
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
    replyTargetPolicy?: OutboundReplyTargetPolicy;
  }) => Promise<void>;
  logger?: { warn?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<
  | { handled: false }
  | { handled: true; command: string; sessionKey: string; fallbackToAgent?: boolean }
> {
  const { api, channelId, cfg, parsed, canonicalAgentId, rememberSessionRoute, enqueueFromReply } =
    params;
  const {
    accountId,
    route,
    peer,
    sessionKeyfromroute,
    providedOriginatingTo,
    clientId,
    extracted,
    msgId,
  } = parsed;
  const command = parseBncrNativeCommand(extracted.text);
  if (!command) return { handled: false };
  const nativeCommandDebugEnabled = cfg?.channels?.[channelId]?.debug?.verbose === true;

  logBncrNativeCommandEvent(
    'detected',
    {
      command: command.command,
      accountId,
      to: formatDisplayScope(route),
      msgId: msgId || null,
    },
    { debugOnly: true, debugEnabled: nativeCommandDebugEnabled },
  );

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
  const sessionKey = taskSessionKey || baseSessionKey;
  rememberSessionRoute(baseSessionKey, accountId, route);
  if (taskSessionKey && taskSessionKey !== baseSessionKey)
    rememberSessionRoute(taskSessionKey, accountId, route);

  const displayTo = formatDisplayScope(route);
  const originatingTo = providedOriginatingTo || displayTo;
  const body = command.body;
  if (!clientId) {
    emitBncrLogLine(
      'warn',
      '[bncr] inbound missing clientId for native command identity; using route identity fallback',
    );
  }
  const senderIdForContext = clientId || displayTo;
  const senderDisplayName = clientId ? 'bncr-client' : displayTo;
  const storePath = resolveBncrInboundSessionStorePath({
    storeConfig: cfg?.session?.store,
    agentId: resolvedRoute.agentId,
  });

  const ctxPayload = resolveBncrChannelInboundRuntime(api).buildContext({
    channel: channelId,
    provider: channelId,
    surface: channelId,
    accountId,
    messageId: msgId,
    timestamp: Date.now(),
    from: senderIdForContext,
    sender: {
      id: senderIdForContext,
      name: senderDisplayName,
      username: senderDisplayName,
    },
    conversation: {
      kind: peer.kind,
      id: peer.id,
      label: displayTo,
      routePeer: {
        kind: peer.kind,
        id: peer.id,
      },
    },
    route: {
      agentId: resolvedRoute.agentId,
      accountId,
      routeSessionKey: resolvedRoute.sessionKey,
      dispatchSessionKey: sessionKey,
      mainSessionKey: resolvedRoute.mainSessionKey,
    },
    reply: {
      to: displayTo,
      originatingTo,
      replyToId: msgId,
    },
    message: {
      inboundEventKind: 'user_request',
      body,
      rawBody: body,
      bodyForAgent: body,
      commandBody: body,
      envelopeFrom: originatingTo,
      senderLabel: senderDisplayName,
    },
    commandTurn: {
      kind: 'native',
      source: 'native',
      authorized: true,
      body,
    },
    access: {
      mentions: {
        canDetectMention: true,
        wasMentioned: true,
        effectiveWasMentioned: true,
      },
      commands: {
        authorized: true,
        allowTextCommands: true,
        useAccessGroups: false,
        authorizers: [],
      },
    },
    extra: {
      OriginatingChannel: channelId,
    },
  });

  const sessionIdentityPatch = buildBncrInboundSessionIdentityPatch({
    channelId,
    accountId,
    chatType: peer.kind,
    displayTo,
    senderId: senderIdForContext,
  });

  const nativeVerbose = resolveBncrNativeVerboseCommand(command);
  if (nativeVerbose) {
    logBncrNativeCommandEvent('handled-verbose', {
      command: command.command,
      accountId,
      sessionKey,
      to: displayTo,
      msgId: msgId || null,
      fallbackToAgent: false,
    });
    await recordAndPatchBncrInboundSessionEntry({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      patch: {
        ...sessionIdentityPatch,
        ...(nativeVerbose.verboseLevel ? { verboseLevel: nativeVerbose.verboseLevel } : {}),
      },
    });
    rememberSessionRoute(baseSessionKey, accountId, route);
    await enqueueFromReply({
      accountId,
      sessionKey,
      route,
      payload: {
        text: nativeVerbose.text,
        replyToId: msgId || undefined,
      },
    });
    return { handled: true, command: command.command, sessionKey };
  }

  await recordAndPatchBncrInboundSessionEntry({
    storePath,
    sessionKey,
    ctx: ctxPayload,
    patch: sessionIdentityPatch,
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
    peerKind: peer.kind,
    senderIdForContext,
    accountId,
    to: displayTo,
    resolvedRoute,
    sessionKey,
    pinnedMainDmOwner,
  });

  let responded = false;
  logBncrNativeCommandEvent(
    'dispatch-native-turn',
    {
      command: command.command,
      accountId,
      sessionKey,
      to: displayTo,
      msgId: msgId || null,
    },
    { debugOnly: true, debugEnabled: nativeCommandDebugEnabled },
  );
  await resolveBncrChannelInboundRuntime(api).run({
    channel: channelId,
    accountId,
    raw: parsed,
    adapter: {
      ingest: () => ({
        id: msgId ?? `${displayTo}:${Date.now()}`,
        timestamp: Date.now(),
        rawText: body,
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
          expectedLabel: displayTo,
        }),
        record: {
          updateLastRoute,
          onRecordError: (err: unknown) => {
            emitBncrLogLine(
              'warn',
              `[bncr] inbound record native command session failed: ${String(err)}`,
            );
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
                const deliveryPayload = buildBncrNativeReplyDeliveryPayload({
                  payload,
                  kind,
                  effectiveReply,
                  msgId,
                });
                if (!deliveryPayload) return;
                if (!responded) {
                  logBncrNativeCommandEvent(
                    'payload-produced',
                    {
                      command: command.command,
                      accountId,
                      sessionKey,
                      to: displayTo,
                      msgId: msgId || null,
                      kind: kind || null,
                      fallbackToAgent: false,
                    },
                    { debugOnly: true, debugEnabled: nativeCommandDebugEnabled },
                  );
                }
                responded = true;
                await enqueueFromReply({
                  accountId,
                  sessionKey,
                  route,
                  payload: deliveryPayload,
                  replyTargetPolicy: 'preserve',
                });
              },
            },
            replyOptions: {
              disableBlockStreaming: !effectiveReply.blockStreaming,
              shouldEmitToolResult: effectiveReply.allowTool ? () => true : undefined,
            },
          }),
      }),
    },
  });

  if (!responded) {
    logBncrNativeCommandEvent('no-payload-fallback-to-agent', {
      command: command.command,
      accountId,
      sessionKey,
      to: displayTo,
      msgId: msgId || null,
      fallbackToAgent: true,
    });
    return { handled: true, command: command.command, sessionKey, fallbackToAgent: true };
  }

  logBncrNativeCommandEvent(
    'handled-with-payload',
    {
      command: command.command,
      accountId,
      sessionKey,
      to: displayTo,
      msgId: msgId || null,
      fallbackToAgent: false,
    },
    { debugOnly: true, debugEnabled: nativeCommandDebugEnabled },
  );
  return { handled: true, command: command.command, sessionKey };
}
