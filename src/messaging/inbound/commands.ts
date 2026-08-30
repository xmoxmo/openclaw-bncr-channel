import { hasControlCommand } from 'openclaw/plugin-sdk/command-auth';
import { emitBncrLogLine } from '../../core/logging.ts';
import { resolveBncrChannelPolicy } from '../../core/policy.ts';
import { formatDisplayScope } from '../../core/targets.ts';
import {
  readBncrSessionEntry,
  recordBncrInboundSession,
  resolveBncrInboundSessionStorePath,
  resolveBncrPinnedMainDmOwnerFromAllowlist,
} from '../../openclaw/inbound-session-runtime.ts';
import { dispatchOpenClawReplyWithBufferedBlockDispatcher } from '../../openclaw/reply-runtime.ts';
import { resolveOpenClawAgentRoute } from '../../openclaw/routing-runtime.ts';
import { performBncrGatewaySessionReset } from '../../openclaw/session-reset-runtime.ts';
import { mergeBncrOwnerAllowFromIntoConfig } from './command-owner.ts';
import type {
  BncrEnqueueFromReply,
  BncrInboundApi,
  BncrInboundConfig,
  BncrInboundLogger,
  BncrRememberSessionRoute,
} from './contracts.ts';
import { assertResolvedAgentRoute, type ParsedInbound } from './dispatch-prep.ts';
import { buildBncrInboundRecordUpdateLastRoute } from './last-route.ts';
import {
  BNCR_OPENCLAW_NATIVE_COMMAND,
  BNCR_SELF_SERVICE_COMMANDS,
  isBncrStopCommandText,
  isBncrWhitelistBareCommandText,
  parseBncrNativeCommand,
  parseBncrUnsupportedDirectCommand,
  resolveBncrNativeCommandParseOptions,
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

  // Stop always goes through the unified stop fast path in dispatch.ts.
  // It is not a bncr native command and must never be processed here.
  if (isBncrStopCommandText(extracted.text)) {
    return { handled: false };
  }

  const whitelistBareCommand =
    !parsed.isAdmin && parsed.peer.kind === 'direct'
      ? isBncrWhitelistBareCommandText(extracted.text)
      : null;
  let dispatchToOpenClaw =
    whitelistBareCommand === 'whoami' ||
    whitelistBareCommand === 'status' ||
    whitelistBareCommand === 'model' ||
    whitelistBareCommand === 'verbose';
  const effectiveIsAdmin = whitelistBareCommand ? true : parsed.isAdmin;
  let command: ReturnType<typeof parseBncrNativeCommand>;
  if (whitelistBareCommand) {
    // Private non-admin whitelist commands are temporarily elevated to admin
    // for the local session-reset handlers or handed to the OpenClaw native
    // parser. They never fall back to the agent so the agent cannot observe
    // a conflicting identity.
    const raw = String(extracted.text || '').trim();
    command = { command: whitelistBareCommand, raw, body: raw, argsText: '' };
    const argsTextStart = raw.indexOf(' ');
    if (argsTextStart !== -1) {
      command.argsText = raw.slice(argsTextStart + 1).trim();
    }
  } else {
    command = parseBncrNativeCommand(
      extracted.text,
      resolveBncrNativeCommandParseOptions({
        isAdmin: parsed.isAdmin,
        peerKind: parsed.peer.kind as 'direct' | 'group',
      }),
    );
  }
  if (!command) {
    const unsupportedCommand = parseBncrUnsupportedDirectCommand(extracted.text);
    // Unknown /bncr subcommands are rejected by bncr without agent fallback,
    // for both admin and non-admin callers and in private or group chat.
    if (unsupportedCommand?.command.startsWith('bncr ')) {
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
          command: unsupportedCommand.command,
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
          text: `Unsupported command: /${unsupportedCommand.command}`,
          replyToId: msgId || undefined,
        },
      });
      return { handled: true, command: unsupportedCommand.command, sessionKey };
    }
    // Non-bncr bare commands fall through to the OpenClaw parser. Admin
    // callers may fall back to the agent; non-admin callers keep their
    // original identity when they do.

    // Admin bare OpenClaw native commands are routed to the OpenClaw parser
    // and handled there, preventing a second agent turn from producing a
    // duplicate reply. This mirrors the non-admin whitelist elevation path.
    if (
      !command &&
      parsed.isAdmin &&
      hasControlCommand(extracted.text, cfg as Parameters<typeof hasControlCommand>[1])
    ) {
      const raw = String(extracted.text || '').trim();
      command = { command: BNCR_OPENCLAW_NATIVE_COMMAND, raw, body: raw, argsText: '' };
      const argsTextStart = raw.indexOf(' ');
      if (argsTextStart !== -1) {
        command.argsText = raw.slice(argsTextStart + 1).trim();
      }
      dispatchToOpenClaw = true;
    }
  }
  if (!command) return { handled: false };
  const nativeCommandDebugEnabled = resolveNativeCommandDebugEnabled({ cfg, channelId });

  const displayCommand =
    command.command === BNCR_OPENCLAW_NATIVE_COMMAND ? command.raw : command.command;

  logBncrNativeCommandEvent(
    'detected',
    {
      command: displayCommand,
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

  const dispatchOwnerAllowFrom =
    dispatchToOpenClaw && senderIdForContext ? [senderIdForContext] : undefined;

  const ctxPayload = await Promise.resolve(
    createNativeCommandTurnContext({
      api,
      channelId,
      accountId,
      msgId: msgId || undefined,
      peer,
      resolvedRoute,
      sessionKey,
      ownerAllowFrom: dispatchOwnerAllowFrom,
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

  const currentVerboseLevel = storePath
    ? ((await readBncrSessionEntry({ storePath, sessionKey }))?.verboseLevel as
        | 'on'
        | 'off'
        | 'full'
        | undefined)
    : undefined;
  const nativeVerbose = resolveBncrNativeVerboseCommand(command, currentVerboseLevel);
  const nativeHelp = resolveBncrNativeHelpCommand(command, {
    isAdmin: effectiveIsAdmin,
    peerKind: parsed.peer.kind as 'direct' | 'group',
  });
  const nativeWhoami = resolveBncrNativeWhoamiCommand({
    command,
    platform: parsed.platform,
    groupId: parsed.groupId,
    groupName: parsed.groupName,
    userId: parsed.userId,
    userName: parsed.userName,
    isGroup: parsed.isGroup,
    isAdmin: effectiveIsAdmin,
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
  const nativeSessionReset = resolveBncrNativeSessionResetCommand({
    command,
    peerKind: parsed.peer.kind as 'direct' | 'group',
  });
  if (!dispatchToOpenClaw) {
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
      const allowLocalSessionReset = parsed.peer.kind === 'direct' || effectiveIsAdmin;
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
      await recordAndPatchBncrInboundSessionEntry({
        storePath,
        sessionKey,
        ctx: ctxPayload,
        patch: sessionIdentityPatch,
      });
      let resetResult: { ok?: boolean } | undefined;
      try {
        resetResult = await performBncrGatewaySessionReset({
          key: baseSessionKey,
          reason: nativeSessionReset.reason,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          commandSource: 'bncr:native-command',
        });
      } catch (resetError) {
        emitBncrLogLine(
          'error',
          `[bncr] native-command sessions.reset failed|key=${baseSessionKey}|err=${resetError instanceof Error ? resetError.message : String(resetError)}`,
        );
        await enqueueFromReply({
          accountId,
          sessionKey: baseSessionKey,
          route,
          payload: {
            text: `Session reset failed: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
            replyToId: msgId || undefined,
          },
        });
        return { handled: true, command: command.command, sessionKey: baseSessionKey };
      }
      if (resetResult?.ok === false) {
        await enqueueFromReply({
          accountId,
          sessionKey: baseSessionKey,
          route,
          payload: {
            text: 'Session reset was rejected by the gateway.',
            replyToId: msgId || undefined,
          },
        });
        return { handled: true, command: command.command, sessionKey: baseSessionKey };
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
      if (!effectiveIsAdmin && parsed.peer.kind !== 'direct') {
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
      const directSelfAdminCommand =
        parsed.peer.kind === 'direct' &&
        new Set(['history-help', 'history-limit', 'history-force', 'download-media']).has(
          command.command,
        );
      if (!effectiveIsAdmin && !directSelfAdminCommand) {
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
        await recordAndPatchBncrInboundSessionEntry({
          storePath,
          sessionKey,
          ctx: ctxPayload,
          patch: sessionIdentityPatch,
        });
        await enqueueFromReply({
          accountId,
          sessionKey,
          route,
          payload: {
            text: 'Admin permission required.',
            replyToId: msgId || undefined,
          },
        });
        return { handled: true, command: command.command, sessionKey };
      }

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
        await recordAndPatchBncrInboundSessionEntry({
          storePath,
          sessionKey,
          ctx: ctxPayload,
          patch: sessionIdentityPatch,
        });
        await enqueueFromReply({
          accountId,
          sessionKey,
          route,
          payload: {
            text: sceneAdmin.text,
            replyToId: msgId || undefined,
          },
        });
        return { handled: true, command: command.command, sessionKey };
      }

      const outcome = executeSceneAdminCommand({
        parsed,
        command: sceneAdmin.command,
        sceneRegistry,
        defaultAdminAgentId,
        defaultPublicAgentId,
        now,
        allowNonAdminSelfAdmin: !!directSelfAdminCommand,
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
      await enqueueFromReply({
        accountId,
        sessionKey,
        route,
        payload: {
          text: outcome.text,
          replyToId: msgId || undefined,
        },
      });
      return { handled: true, command: command.command, sessionKey };
    }
  }

  await recordAndPatchBncrInboundSessionEntry({
    storePath,
    sessionKey,
    ctx: ctxPayload,
    patch: sessionIdentityPatch,
  });

  const dispatchCfgForElevated =
    dispatchToOpenClaw && senderIdForContext
      ? mergeBncrOwnerAllowFromIntoConfig({ cfg, senderIdForContext })
      : cfg;
  const effectiveReply = buildBncrReplyConfig(dispatchCfgForElevated);
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
    // Self-service commands must never fall back to the agent — doing so
    // would let the agent see a message whose author identity was
    // temporarily elevated, causing role confusion.
    if (BNCR_SELF_SERVICE_COMMANDS.has(command.command)) {
      emitBncrLogLine(
        'warn',
        `[bncr] self-service command=${displayCommand} produced no payload; refusing agent fallback`,
      );
      await enqueueFromReply({
        accountId,
        sessionKey,
        route,
        payload: {
          text: `Command /${command.command} failed.`,
          replyToId: msgId || undefined,
        },
      });
      return buildNativeCommandHandledResult({
        command: command.command,
        sessionKey,
      });
    }
    logBncrNativeCommandSummary(
      `fallback command=${displayCommand}|accountId=${accountId}|to=${displayTo}|msgId=${msgId || '-'}|reason=no-payload`,
    );
    logBncrNativeCommandEvent(
      'no-payload-fallback-to-agent',
      {
        command: displayCommand,
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
