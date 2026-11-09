import { hasControlCommand } from 'openclaw/plugin-sdk/command-detection';
import { listConfiguredAgentIds } from '../../core/agent-surface.ts';
import { emitBncrLogLine } from '../../core/logging.ts';
import { resolveBncrChannelPolicy } from '../../core/policy.ts';
import { formatDisplayScope } from '../../core/targets.ts';
import { resolveBncrChannelInboundRuntime } from '../../openclaw/inbound-runtime.ts';
import {
  deleteBncrSessionEntry,
  listBncrSessionEntries,
  readBncrSessionEntry,
  readBncrSessionEntryStrict,
  readBncrSessionUpdatedAt,
  recordBncrInboundSession,
  resolveBncrInboundSessionStorePath,
  resolveBncrPinnedMainDmOwnerFromAllowlist,
} from '../../openclaw/inbound-session-runtime.ts';
import { dispatchOpenClawReplyWithBufferedBlockDispatcher } from '../../openclaw/reply-runtime.ts';
import { resolveOpenClawAgentRoute } from '../../openclaw/routing-runtime.ts';
import {
  type BncrSessionNodeStatus,
  buildBncrSessionNodeIndex,
} from '../../openclaw/session-node-status.ts';
import { addNativeElevation, removeNativeElevation } from '../../plugin/config.ts';
import { buildSceneKey, resolveSceneAgentId } from '../../plugin/scene-registry.ts';
import {
  mergeBncrOwnerAllowFromIntoConfig,
  resolveBncrHostOwnerConfigOverride,
} from './command-owner.ts';
import { dispatchLocalCommand } from './command-registry.ts';
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
import type { BncrSessionActivity } from './session-cleanup-command.ts';
import {
  resolveBncrSceneIdentity,
  resolveBncrSceneName,
  resolveBncrSessionCategory,
} from './session-identity.ts';
import {
  buildBncrInboundSessionIdentityPatch,
  recordAndPatchBncrInboundSessionEntry,
  wrapBncrInboundRecordSessionLabelCorrection,
} from './session-label.ts';
import { createBncrSessionMetaTaskBarrier } from './session-meta-task.ts';
import type { BncrClientSceneStateList } from './stale-scenes-command.ts';

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

/**
 * Reduce a host session entry to the two timestamps session cleanup needs.
 * Anything unreadable stays null so a bad row can never look freshly active.
 */
function toBncrSessionActivity(
  sessionKey: string,
  entry: unknown,
): BncrSessionActivity | undefined {
  const key = String(sessionKey ?? '').trim();
  if (!key || !entry || typeof entry !== 'object') return undefined;
  const record = entry as Record<string, unknown>;
  const pick = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const interactionAt = pick(record.lastInteractionAt);
  const storeWriteAt = pick(record.updatedAt);
  const sessionId =
    typeof record.sessionId === 'string' && record.sessionId.trim() ? record.sessionId : null;
  return {
    sessionKey: key,
    sessionId,
    updatedAt: storeWriteAt,
    lastActivityAt: interactionAt ?? storeWriteAt,
    // Tell the caller when this age is a store write instead of a message: the
    // two are not the same thing and the listing must not pretend they are.
    hasInteractionAt: interactionAt != null,
    archivedAt: pick(record.archivedAt),
  };
}

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
  /** Wipe every stored artifact for one pruned scene session. */
  purgeSceneSession?: (args: {
    sceneKey: string;
    agentId: string;
    sessionKey: string | null;
    assertCurrent?: () => boolean;
  }) => Promise<void> | void;
  /** Debounced state save; maintenance commands call it after removing rows. */
  scheduleSave?: () => void;
  /** Ask the Bncr client to drop its own per-scene state for these scenes. */
  clearClientSceneState?: (args: {
    sceneKeys: string[];
    accountId: string;
  }) => Promise<
    { ok?: boolean; cleared?: number; unsupported?: boolean; error?: string } | undefined | null
  >;
  /** Read the Bncr client's own scene gate table (orphan listing). */
  listClientSceneState?: (args: {
    accountId: string;
  }) => Promise<BncrClientSceneStateList | undefined | null>;
  /**
   * 维护命令读库：把库里其他 agent 写入的场景行并进本实例视图。
   * 每个 agent 实例各持一份内存 registry，跨 agent 的查询必须先合并再判定。
   */
  refreshSceneRegistryFromStore?: () => void | Promise<void>;
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
    purgeSceneSession,
    scheduleSave,
    clearClientSceneState,
    listClientSceneState,
    refreshSceneRegistryFromStore,
    logger,
  } = params;
  const { accountId, route, peer, clientId, extracted, msgId } = parsed;

  // Stop always goes through the unified stop fast path in dispatch.ts.
  // It is not a bncr native command and must never be processed here.
  // Only exact `/stop` is accepted; any other `/stop*` form is rejected.
  const rawStopText = String(extracted.text || '')
    .trim()
    .toLowerCase();
  if (rawStopText.startsWith('/stop')) {
    if (isBncrStopCommandText(extracted.text)) {
      return { handled: false };
    }
    // Non-exact `/stop` forms (extra args, @bot suffix, or other extension)
    // are rejected immediately so they never reach the agent.
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
    logBncrNativeCommandSummary(
      buildBncrNativeCommandSummary({
        kind: 'stop',
        command: rawStopText,
        accountId,
        to: formatDisplayScope(route),
        msgId: msgId || null,
        result: 'rejected',
      }),
    );
    await enqueueFromReply({
      accountId,
      sessionKey: baseSessionKey,
      route,
      payload: {
        text: 'Only exact /stop is supported. Send /stop to stop.',
        replyToId: msgId || undefined,
      },
    });
    return { handled: true, command: 'stop', sessionKey };
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

  // The readable label depends on operator-set scene identity, which this very
  // command may just have changed, so it is rebuilt on demand.
  const buildSessionIdentityPatch = () => {
    const sceneKey = buildSceneKey(parsed);
    const sceneAgentId = resolveSceneAgentId(
      sceneRegistry,
      sceneKey,
      resolvedAgentId || canonicalAgentId,
    );
    const identity = resolveBncrSceneIdentity(sceneRegistry, sceneKey, sceneAgentId);
    const persistedSceneName = resolveBncrSceneName(
      sceneRegistry,
      sceneKey,
      sceneAgentId,
      peer.kind,
    );
    return buildBncrInboundSessionIdentityPatch({
      channelId,
      accountId,
      chatType: peer.kind,
      displayTo,
      senderId: senderIdForContext,
      category: resolveBncrSessionCategory({ kind: peer.kind, identity }),
      scene: {
        platform: parsed.platform,
        id: peer.kind === 'group' ? parsed.groupId : parsed.userId,
        name: (peer.kind === 'group' ? parsed.groupName : parsed.userName) || persistedSceneName,
        ...(identity.customName ? { customName: identity.customName } : {}),
      },
    });
  };
  const sessionIdentityPatch = buildSessionIdentityPatch();

  const currentVerboseLevel = storePath
    ? ((await readBncrSessionEntry({ storePath, sessionKey }))?.verboseLevel as
        | 'on'
        | 'off'
        | 'full'
        | undefined)
    : undefined;
  // 维护命令读库：每个 agent 实例只持有自己那份内存快照，跨 agent 的查询
  // 与清理必须先并入库里其他实例写入的场景行，读库失败就沿用内存视图。
  if (refreshSceneRegistryFromStore) {
    try {
      await refreshSceneRegistryFromStore();
    } catch (error) {
      logger?.warn?.(
        `bncr scene registry refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const knownAgentIds = new Set(
    Array.from(sceneRegistry.values())
      .map((row) => String(row.agentId ?? '').trim())
      .filter(Boolean),
  );
  // Host-declared agents: binding a scene to an id this OpenClaw does not serve
  // would write a row no one picks up, so the bind command checks against this.
  const configuredAgentIds = new Set(listConfiguredAgentIds(cfg));
  const sceneAgentId = resolveSceneAgentId(
    sceneRegistry,
    buildSceneKey(parsed),
    resolvedAgentId || canonicalAgentId,
  );
  // One read-only session listing per agent per command. `null` means the read
  // could not be trusted, which every caller must treat as unknown.
  const sessionNodeIndexByAgent = new Map<string, Map<string, BncrSessionNodeStatus> | null>();
  if (!dispatchToOpenClaw) {
    const localResult = await dispatchLocalCommand({
      command,
      parsed,
      effectiveIsAdmin,
      accountId,
      msgId: msgId ?? null,
      route,
      peer,
      displayTo,
      baseSessionKey,
      sessionKey,
      storePath,
      ctxPayload,
      sessionIdentityPatch,
      buildSessionIdentityPatch,
      currentVerboseLevel,
      knownAgentIds,
      configuredAgentIds,
      sceneRegistry,
      routeAgentId: resolvedRoute.agentId || canonicalAgentId,
      sceneAgentId,
      defaultAdminAgentId,
      defaultPublicAgentId,
      now,
      rememberSessionRoute,
      enqueueFromReply,
      purgeSceneSession,
      persistScenes: scheduleSave,
      readSessionUpdatedAt: async ({ agentId, sessionKey: targetSessionKey }) => {
        const targetStorePath = resolveBncrInboundSessionStorePath({
          storeConfig: cfg?.session?.store,
          agentId,
        });
        try {
          const value = await readBncrSessionUpdatedAt({
            storePath: targetStorePath,
            sessionKey: targetSessionKey,
          });
          return typeof value === 'number' && Number.isFinite(value) ? value : null;
        } catch {
          // Unknown, not dead: a failed read must never prune a live chat.
          return undefined;
        }
      },
      readSessionNode: async ({ agentId, sessionKey: targetSessionKey }) => {
        if (!sessionNodeIndexByAgent.has(agentId)) {
          let index: Map<string, BncrSessionNodeStatus> | null = null;
          try {
            // Read through the host SDK: it resolves the sqlite store itself,
            // so the plugin never has to guess where sessions actually live.
            // The configured store path is passed along so a custom
            // `session.store` still resolves to its own sqlite target.
            index =
              buildBncrSessionNodeIndex(
                await listBncrSessionEntries({
                  agentId,
                  storePath: resolveBncrInboundSessionStorePath({
                    storeConfig: cfg?.session?.store,
                    agentId,
                  }),
                }),
              ) ?? null;
          } catch {
            index = null;
          }
          sessionNodeIndexByAgent.set(agentId, index);
        }
        const index = sessionNodeIndexByAgent.get(agentId);
        if (!index) return undefined;
        return (
          index.get(targetSessionKey) ?? {
            exists: false,
            sessionId: null,
            archivedAt: null,
            updatedAt: null,
            lastInteractionAt: null,
          }
        );
      },
      deleteSession: async ({
        agentId,
        sessionKey: targetSessionKey,
        expectedSessionId,
        expectedUpdatedAt,
      }) => {
        const targetStorePath = resolveBncrInboundSessionStorePath({
          storeConfig: cfg?.session?.store,
          agentId,
        });
        return deleteBncrSessionEntry({
          storePath: targetStorePath,
          sessionKey: targetSessionKey,
          agentId,
          archiveTranscript: true,
          ...(expectedSessionId !== undefined ? { expectedSessionId } : {}),
          ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
        });
      },
      // /bncr sessions works on the host session store directly, so it can see
      // conversations whose scene row is already gone.
      listSessions: async (agentId: string) => {
        const targetStorePath = resolveBncrInboundSessionStorePath({
          storeConfig: cfg?.session?.store,
          agentId,
        });
        let entries: Awaited<ReturnType<typeof listBncrSessionEntries>>;
        try {
          entries = await listBncrSessionEntries({
            agentId,
            storePath: targetStorePath,
          });
        } catch {
          return undefined;
        }
        if (!entries) return undefined;
        const rows: BncrSessionActivity[] = [];
        for (const item of entries) {
          const activity = toBncrSessionActivity(item.sessionKey, item.entry);
          if (activity) rows.push(activity);
        }
        return rows;
      },
      readSessionActivity: async ({ agentId, sessionKey: targetSessionKey }) => {
        const targetStorePath = resolveBncrInboundSessionStorePath({
          storeConfig: cfg?.session?.store,
          agentId,
        });
        const entry = await readBncrSessionEntryStrict({
          storePath: targetStorePath,
          sessionKey: targetSessionKey,
        });
        if (!entry) return undefined;
        return toBncrSessionActivity(targetSessionKey, entry);
      },
      clearClientState: clearClientSceneState
        ? (sceneKeys: string[]) => clearClientSceneState({ sceneKeys, accountId })
        : undefined,
      listClientState: listClientSceneState ? () => listClientSceneState({ accountId }) : undefined,
      nativeCommandDebugEnabled,
    });
    if (localResult) return localResult;
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
  const hostDispatchConfig = resolveBncrHostOwnerConfigOverride({
    cfg,
    isAdmin: parsed.isAdmin === true && dispatchToOpenClaw,
    senderId: senderIdForContext,
  });
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
  if (dispatchToOpenClaw && senderIdForContext) {
    addNativeElevation(senderIdForContext);
  }
  try {
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
                ...(hostDispatchConfig ? { hostDispatchConfig } : {}),
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
  } finally {
    if (dispatchToOpenClaw && senderIdForContext && !parsed.isAdmin) {
      removeNativeElevation(senderIdForContext);
    }
  }

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
