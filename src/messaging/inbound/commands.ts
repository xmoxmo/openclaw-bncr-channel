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
import {
  parseBncrNativeCommand,
  parseBncrUnsupportedDirectCommand,
  resolveBncrNativeHelpCommand,
  resolveBncrNativeSessionResetCommand,
  resolveBncrNativeStatusCommand,
  resolveBncrNativeVerboseCommand,
  resolveBncrNativeWhoamiCommand,
} from './native-command.ts';
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
import { executeSceneAdminCommand, parseSceneAdminCommand } from './scene-admin.ts';
import {
  buildBncrInboundSessionIdentityPatch,
  recordAndPatchBncrInboundSessionEntry,
  wrapBncrInboundRecordSessionLabelCorrection,
} from './session-label.ts';
import { createBncrSessionMetaTaskBarrier } from './session-meta-task.ts';

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
  resolvedAgentId?: string;
}) {
  const resolvedRoute = assertResolvedAgentRoute(
    resolveOpenClawAgentRoute(args.api, {
      cfg: args.cfg,
      channel: args.channelId,
      accountId: args.accountId,
      peer: args.peer,
    }),
  );

  const agentId = (args.resolvedAgentId || '').trim() || resolvedRoute.agentId;
  if (!agentId || agentId === resolvedRoute.agentId) return resolvedRoute;

  return {
    ...resolvedRoute,
    agentId,
  };
}

export { parseBncrNativeCommand } from './native-command.ts';

export async function handleBncrNativeCommand(params: {
  api: BncrInboundApi;
  channelId: string;
  cfg: BncrInboundConfig;
  parsed: ParsedInbound;
  canonicalAgentId: string;
  resolvedAgentId?: string;
  sceneRegistry: Map<string, import('../../plugin/channel-runtime-types.ts').BncrSceneRecord>;
  defaultAdminAgentId: string;
  defaultPublicAgentId: string;
  now: () => number;
  rememberSessionRoute: BncrRememberSessionRoute;
  enqueueFromReply: BncrEnqueueFromReply;
  logger?: BncrInboundLogger;
}): Promise<
  | { handled: false }
  | { handled: true; command: string; sessionKey: string; fallbackToAgent?: boolean }
> {
  const {
    api,
    channelId,
    cfg,
    parsed,
    canonicalAgentId,
    resolvedAgentId,
    sceneRegistry,
    defaultAdminAgentId,
    defaultPublicAgentId,
    now,
    rememberSessionRoute,
    enqueueFromReply,
  } = params;
  const { accountId, route, peer, clientId, extracted, msgId } = parsed;
  const command = parseBncrNativeCommand(extracted.text, {
    allowBareWhoami: parsed.isAdmin !== true,
    allowBareStatus: parsed.isAdmin !== true && parsed.peer.kind === 'direct',
    allowBareSessionReset: parsed.isAdmin !== true && parsed.peer.kind === 'direct',
  });
  if (!command && parsed.peer.kind === 'direct') {
    const unsupportedDirectCommand = parseBncrUnsupportedDirectCommand(extracted.text);
    if (unsupportedDirectCommand) {
      const rejectedRoute = buildBncrNativeCommandResolvedRoute({
        api,
        cfg,
        channelId,
        accountId,
        peer,
        resolvedAgentId,
      });
      const { baseSessionKey, sessionKey } = buildBncrNativeCommandSessionState({
        parsed,
        sessionAgentId: rejectedRoute.agentId || canonicalAgentId,
        resolvedRoute: rejectedRoute,
      });
      const displayTo = formatDisplayScope(route);
      logBncrNativeCommandSummary(
        buildBncrNativeCommandSummary({
          kind: 'unsupported',
          command: unsupportedDirectCommand.command,
          accountId,
          to: displayTo,
          msgId: msgId || null,
          result: 'rejected',
        }),
      );
      await enqueueFromReply({
        accountId,
        sessionKey: baseSessionKey,
        route,
        payload: {
          text: `Unsupported private-chat command: /${unsupportedDirectCommand.command}`,
          replyToId: msgId || undefined,
        },
      });
      return { handled: true, command: unsupportedDirectCommand.command, sessionKey };
    }
  }
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
    resolvedAgentId,
  });

  const { baseSessionKey, taskSessionKey, sessionKey, displayTo, originatingTo } =
    buildBncrNativeCommandSessionState({
      parsed,
      sessionAgentId: resolvedRoute.agentId || canonicalAgentId,
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
  const senderIdForContext = parsed.userId || clientId || displayTo;
  const senderDisplayName = parsed.userName || displayTo;
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
  const nativeHelp = resolveBncrNativeHelpCommand(command);
  const nativeWhoami = resolveBncrNativeWhoamiCommand({
    command,
    platform: parsed.platform,
    groupId: parsed.groupId,
    groupName: parsed.groupName,
    userId: parsed.userId,
    userName: parsed.userName,
    isGroup: parsed.isGroup,
    isAdmin: parsed.isAdmin,
  });
  const nativeStatus = resolveBncrNativeStatusCommand({
    command,
    accountId,
    platform: parsed.platform,
    userId: parsed.userId,
    userName: parsed.userName,
    resolvedAgentId: resolvedRoute.agentId || canonicalAgentId,
    sessionKey,
  });
  const nativeSessionReset = resolveBncrNativeSessionResetCommand({ command });
  if (nativeHelp) {
    logBncrNativeCommandSummary(
      buildBncrNativeCommandSummary({
        kind: 'help',
        command: command.command,
        accountId,
        to: displayTo,
        msgId: msgId || null,
        result: 'handled',
      }),
    );
    await recordAndPatchBncrInboundSessionEntry({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      patch: sessionIdentityPatch,
    });
    rememberSessionRoute(baseSessionKey, accountId, route);
    await enqueueFromReply({
      accountId,
      sessionKey,
      route,
      payload: {
        text: nativeHelp.text,
        replyToId: msgId || undefined,
      },
    });
    return { handled: true, command: command.command, sessionKey };
  }

  if (nativeWhoami) {
    logBncrNativeCommandSummary(
      buildBncrNativeCommandSummary({
        kind: 'whoami',
        command: command.command,
        accountId,
        to: displayTo,
        msgId: msgId || null,
        result: 'handled',
      }),
    );
    await recordAndPatchBncrInboundSessionEntry({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      patch: sessionIdentityPatch,
    });
    rememberSessionRoute(baseSessionKey, accountId, route);
    await enqueueFromReply({
      accountId,
      sessionKey,
      route,
      payload: {
        text: nativeWhoami.text,
        replyToId: msgId || undefined,
      },
    });
    return { handled: true, command: command.command, sessionKey };
  }

  if (nativeStatus) {
    logBncrNativeCommandSummary(
      buildBncrNativeCommandSummary({
        kind: 'status',
        command: command.command,
        accountId,
        to: displayTo,
        msgId: msgId || null,
        result: 'handled',
      }),
    );
    await recordAndPatchBncrInboundSessionEntry({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      patch: sessionIdentityPatch,
    });
    rememberSessionRoute(baseSessionKey, accountId, route);
    await enqueueFromReply({
      accountId,
      sessionKey,
      route,
      payload: {
        text: nativeStatus.text,
        replyToId: msgId || undefined,
      },
    });
    return { handled: true, command: command.command, sessionKey };
  }

  if (nativeSessionReset) {
    const allowLocalSessionReset = parsed.peer.kind === 'direct';
    if (!allowLocalSessionReset) {
      logBncrNativeCommandSummary(
        buildBncrNativeCommandSummary({
          kind: nativeSessionReset.reason,
          command: command.command,
          accountId,
          to: displayTo,
          msgId: msgId || null,
          result: 'rejected',
        }),
      );
      await recordAndPatchBncrInboundSessionEntry({
        storePath,
        sessionKey,
        ctx: ctxPayload,
        patch: sessionIdentityPatch,
      });
      rememberSessionRoute(baseSessionKey, accountId, route);
      return { handled: true, command: command.command, sessionKey };
    }

    const requestedAgentId = resolvedRoute.agentId || canonicalAgentId;
    const requestApi = api as BncrInboundApi & {
      request?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    if (typeof requestApi.request !== 'function') {
      throw new Error('OpenClaw plugin api.request is unavailable for sessions.reset');
    }
    await recordAndPatchBncrInboundSessionEntry({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      patch: sessionIdentityPatch,
    });
    const resetResult = (await requestApi.request('sessions.reset', {
      key: baseSessionKey,
      reason: nativeSessionReset.reason,
      ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
    })) as { ok?: boolean } | undefined;
    if (resetResult?.ok === false) {
      throw new Error(`sessions.reset failed for ${baseSessionKey}`);
    }
    logBncrNativeCommandSummary(
      buildBncrNativeCommandSummary({
        kind: nativeSessionReset.reason,
        command: command.command,
        accountId,
        to: displayTo,
        msgId: msgId || null,
        result: 'handled',
      }),
    );
    rememberSessionRoute(baseSessionKey, accountId, route);
    await enqueueFromReply({
      accountId,
      sessionKey: baseSessionKey,
      route,
      payload: {
        text: nativeSessionReset.text,
        replyToId: msgId || undefined,
      },
    });
    return { handled: true, command: command.command, sessionKey: baseSessionKey };
  }

  if (nativeVerbose) {
    if (!parsed.isAdmin) {
      logBncrNativeCommandSummary(
        buildBncrNativeCommandSummary({
          kind: 'verbose',
          command: command.command,
          accountId,
          to: displayTo,
          msgId: msgId || null,
          result: 'rejected',
        }),
      );
      await recordAndPatchBncrInboundSessionEntry({
        storePath,
        sessionKey,
        ctx: ctxPayload,
        patch: sessionIdentityPatch,
      });
      rememberSessionRoute(baseSessionKey, accountId, route);
      if (parsed.peer.kind !== 'group') {
        await enqueueFromReply({
          accountId,
          sessionKey,
          route,
          payload: {
            text: 'Admin permission required.',
            replyToId: msgId || undefined,
          },
        });
      }
      return { handled: true, command: command.command, sessionKey };
    }

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

  const sceneAdmin = parseSceneAdminCommand(command);
  if (sceneAdmin.matched) {
    const silentNonAdminGroupReject = !parsed.isAdmin && parsed.peer.kind === 'group';
    if (!sceneAdmin.valid) {
      logBncrNativeCommandSummary(
        buildBncrNativeCommandSummary({
          kind: 'scene-admin',
          command: command.command,
          accountId,
          to: displayTo,
          msgId: msgId ?? null,
          result: 'rejected',
        }),
      );
      if (!silentNonAdminGroupReject) {
        await enqueueFromReply({
          accountId,
          sessionKey,
          route,
          payload: {
            text: sceneAdmin.text,
            replyToId: msgId || undefined,
          },
        });
      }
      return { handled: true, command: command.command, sessionKey };
    }

    const outcome = executeSceneAdminCommand({
      parsed,
      command: sceneAdmin.command,
      sceneRegistry,
      defaultAdminAgentId,
      defaultPublicAgentId,
      now,
    });
    logBncrNativeCommandSummary(
      buildBncrNativeCommandSummary({
        kind: 'scene-admin',
        command: command.command,
        accountId,
        to: displayTo,
        msgId: msgId ?? null,
        result: outcome.ok ? 'handled' : 'rejected',
      }),
    );
    await recordAndPatchBncrInboundSessionEntry({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      patch: sessionIdentityPatch,
    });
    if (!(silentNonAdminGroupReject && !outcome.ok)) {
      await enqueueFromReply({
        accountId,
        sessionKey,
        route,
        payload: {
          text: outcome.text,
          replyToId: msgId || undefined,
        },
      });
    }
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
      resolveTurn: () => {
        const sessionMetaBarrier = createBncrSessionMetaTaskBarrier();
        return {
          channel: channelId,
          accountId,
          routeSessionKey: resolvedRoute.sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: wrapBncrInboundRecordSessionLabelCorrection({
            recordInboundSession: recordBncrInboundSession as (
              ...args: unknown[]
            ) => Promise<unknown> | unknown,
            expectedPatch: sessionIdentityPatch,
          }),
          record: {
            updateLastRoute,
            onRecordError: (err: unknown) => {
              buildNativeCommandRecordErrorLogger(err);
            },
            trackSessionMetaTask: (task: Promise<unknown>) => {
              sessionMetaBarrier.track(task);
            },
          },
          runDispatch: async () => {
            await sessionMetaBarrier.wait();
            return dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
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
            });
          },
        };
      },
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
