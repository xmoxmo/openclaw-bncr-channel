import { emitBncrLogLine } from '../../core/logging.ts';
import { resolveBncrChannelPolicy } from '../../core/policy.ts';
import { formatDisplayScope } from '../../core/targets.ts';
import {
  recordBncrInboundSession,
  resolveBncrInboundSessionStorePath,
  resolveBncrPinnedMainDmOwnerFromAllowlist,
} from '../../openclaw/inbound-session-runtime.ts';
import { dispatchOpenClawReplyWithBufferedBlockDispatcher } from '../../openclaw/reply-runtime.ts';
import {
  type OpenClawResolvedAgentRoute,
  resolveOpenClawAgentRoute,
} from '../../openclaw/routing-runtime.ts';
import type {
  BncrEnqueueFromReply,
  BncrInboundApi,
  BncrInboundConfig,
  BncrInboundLogger,
  BncrRememberSessionRoute,
} from './contracts.ts';
import type { ParsedInbound } from './dispatch-prep.ts';
import { buildBncrInboundRecordUpdateLastRoute } from './last-route.ts';
import { parseBncrNativeCommand, resolveBncrNativeVerboseCommand } from './native-command.ts';
import {
  buildBncrNativeCommandSessionState,
  buildBncrNativeCommandSummary,
  buildNativeCommandHandledResult,
  buildNativeCommandRecordErrorLogger,
  createNativeCommandReplyDeliverer,
  createNativeCommandTurnContext,
  logBncrNativeCommandEvent,
  logBncrNativeCommandSummary,
  resolveNativeCommandDebugEnabled,
} from './native-command-runtime.ts';
import { buildBncrReplyConfig } from './reply-config.ts';
import { resolveBncrChannelInboundRuntime } from './runtime-compat.ts';
import {
  buildBncrInboundSessionIdentityPatch,
  recordAndPatchBncrInboundSessionEntry,
  wrapBncrInboundRecordSessionLabelCorrection,
} from './session-label.ts';

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

function buildBncrNativeCommandResolvedRoute(args: {
  api: BncrInboundApi;
  cfg: BncrInboundConfig;
  channelId: string;
  accountId: string;
  peer: ParsedInbound['peer'];
}) {
  return assertResolvedAgentRoute(
    resolveOpenClawAgentRoute(args.api, {
      cfg: args.cfg,
      channel: args.channelId,
      accountId: args.accountId,
      peer: args.peer,
    }),
  );
}

export { parseBncrNativeCommand } from './native-command.ts';

export async function handleBncrNativeCommand(params: {
  api: BncrInboundApi;
  channelId: string;
  cfg: BncrInboundConfig;
  parsed: ParsedInbound;
  canonicalAgentId: string;
  rememberSessionRoute: BncrRememberSessionRoute;
  enqueueFromReply: BncrEnqueueFromReply;
  logger?: BncrInboundLogger;
}): Promise<
  | { handled: false }
  | { handled: true; command: string; sessionKey: string; fallbackToAgent?: boolean }
> {
  const { api, channelId, cfg, parsed, canonicalAgentId, rememberSessionRoute, enqueueFromReply } =
    params;
  const { accountId, route, peer, clientId, extracted, msgId } = parsed;
  const command = parseBncrNativeCommand(extracted.text);
  if (!command) return { handled: false };
  const nativeCommandDebugEnabled = resolveNativeCommandDebugEnabled({ cfg, channelId });

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

  const resolvedRoute = buildBncrNativeCommandResolvedRoute({
    api,
    cfg,
    channelId,
    accountId,
    peer,
  });

  const { baseSessionKey, taskSessionKey, sessionKey, displayTo, originatingTo } =
    buildBncrNativeCommandSessionState({
      parsed,
      canonicalAgentId,
      resolvedRoute,
    });
  rememberSessionRoute(baseSessionKey, accountId, route);
  if (taskSessionKey && taskSessionKey !== baseSessionKey)
    rememberSessionRoute(taskSessionKey, accountId, route);
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

  const ctxPayload = await Promise.resolve(
    createNativeCommandTurnContext({
      api,
      channelId,
      accountId,
      msgId: msgId || undefined,
      peer,
      resolvedRoute,
      sessionKey,
      displayTo,
      originatingTo,
      senderIdForContext,
      senderDisplayName,
      body,
    }),
  );

  const sessionIdentityPatch = buildBncrInboundSessionIdentityPatch({
    channelId,
    accountId,
    chatType: peer.kind,
    displayTo,
    senderId: senderIdForContext,
  });

  const nativeVerbose = resolveBncrNativeVerboseCommand(command);
  if (nativeVerbose) {
    logBncrNativeCommandSummary(
      buildBncrNativeCommandSummary({
        kind: 'verbose',
        command: command.command,
        accountId,
        to: displayTo,
        msgId: msgId || null,
        result: 'handled',
      }),
    );
    logBncrNativeCommandEvent(
      'handled-verbose',
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
          dmScope: cfg?.session?.dmScope as string | undefined,
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
          recordInboundSession: recordBncrInboundSession as (
            ...args: unknown[]
          ) => Promise<unknown> | unknown,
          expectedLabel: displayTo,
        }),
        record: {
          updateLastRoute,
          onRecordError: (err: unknown) => {
            buildNativeCommandRecordErrorLogger(err);
          },
        },
        runDispatch: () =>
          dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
            ctx: ctxPayload,
            cfg: effectiveReply.replyCfg,
            dispatcherOptions: {
              deliver: createNativeCommandReplyDeliverer({
                command: command.command,
                accountId,
                sessionKey,
                to: displayTo,
                msgId: msgId || undefined,
                effectiveReply,
                route,
                enqueueFromReply,
                nativeCommandDebugEnabled,
                onResponded: () => responded,
                markResponded: () => {
                  responded = true;
                },
              }),
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
    logBncrNativeCommandSummary(
      `fallback command=${command.command}|accountId=${accountId}|to=${displayTo}|msgId=${msgId || '-'}|reason=no-payload`,
    );
    logBncrNativeCommandEvent(
      'no-payload-fallback-to-agent',
      {
        command: command.command,
        accountId,
        sessionKey,
        to: displayTo,
        msgId: msgId || null,
        fallbackToAgent: true,
      },
      { debugOnly: true, debugEnabled: nativeCommandDebugEnabled },
    );
    return buildNativeCommandHandledResult({
      command: command.command,
      sessionKey,
      fallbackToAgent: true,
    });
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
  return buildNativeCommandHandledResult({
    command: command.command,
    sessionKey,
  });
}
