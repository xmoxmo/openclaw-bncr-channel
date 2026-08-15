import { emitBncrLogLine } from '../../core/logging.ts';
import { resolveBncrChannelPolicy } from '../../core/policy.ts';
import {
  readBncrSessionUpdatedAt,
  recordBncrInboundSession,
  resolveBncrPinnedMainDmOwnerFromAllowlist,
} from '../../openclaw/inbound-session-runtime.ts';
import { dispatchOpenClawReplyWithBufferedBlockDispatcher } from '../../openclaw/reply-runtime.ts';
import type {
  BncrEnqueueFromReply,
  BncrInboundApi,
  BncrInboundConfig,
  BncrInboundContextPayload,
} from './contracts.ts';
import type {
  BncrInboundConversationResolution,
  BncrInboundReplyRouteFact,
  ParsedInbound,
} from './dispatch-prep.ts';
import { buildBncrInboundRecordUpdateLastRoute } from './last-route.ts';
import { isBncrStopCommandText, parseBncrNativeCommand } from './native-command.ts';
import { buildBncrReplyConfig } from './reply-config.ts';
import { runBncrReplyDispatchSerial } from './reply-dispatch-serial.ts';
import { resolveBncrChannelInboundRuntime } from './runtime-compat.ts';
import {
  buildBncrInboundSessionIdentityPatch,
  correctBncrInboundSessionLabel,
  wrapBncrInboundRecordSessionLabelCorrection,
} from './session-label.ts';
import { createBncrSessionMetaTaskBarrier } from './session-meta-task.ts';

function mergeBncrCommandOwnerAllowFrom(args: {
  cfg: BncrInboundConfig;
  parsed: ParsedInbound;
  isBncrNativeCommand: boolean;
  senderIdForContext: string;
}) {
  const { cfg, parsed, isBncrNativeCommand, senderIdForContext } = args;
  if (parsed.isAdmin !== true || isBncrNativeCommand) return cfg;
  const senderId = String(senderIdForContext || '').trim();
  if (!senderId) return cfg;

  const currentCommands = (cfg.commands || {}) as { ownerAllowFrom?: string[] };
  const currentOwnerAllowFrom = Array.isArray(currentCommands.ownerAllowFrom)
    ? currentCommands.ownerAllowFrom
    : [];
  if (currentOwnerAllowFrom.includes(senderId)) return cfg;

  return {
    ...cfg,
    commands: {
      ...currentCommands,
      ownerAllowFrom: [...currentOwnerAllowFrom, senderId],
    },
  } satisfies BncrInboundConfig;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBncrReplySessionQuiescence(args: {
  api: BncrInboundApi;
  storePath: string;
  sessionKey: string;
  msgId?: string | null;
  to: string;
  debugEnabled?: boolean;
}) {
  const settleWindowMs = 120;
  const pollIntervalMs = 40;
  const maxWaitMs = 1500;
  const startedAt = Date.now();
  const debugGate = () => args.debugEnabled === true;
  let lastUpdatedAt = null as number | null;
  let stableSince = Date.now();

  const readUpdatedAt = async () => {
    try {
      const updatedAt = await readBncrSessionUpdatedAt(args.api, {
        storePath: args.storePath,
        sessionKey: args.sessionKey,
      });
      return typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : null;
    } catch {
      return null;
    }
  };

  lastUpdatedAt = await readUpdatedAt();

  while (Date.now() - startedAt < maxWaitMs) {
    await sleep(pollIntervalMs);
    const currentUpdatedAt = await readUpdatedAt();
    if (currentUpdatedAt !== lastUpdatedAt) {
      lastUpdatedAt = currentUpdatedAt;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= settleWindowMs) {
      return;
    }
  }

  emitBncrLogLine(
    'warn',
    `[bncr] reply-dispatch settle timeout|sessionKey=${args.sessionKey}|msgId=${args.msgId || '-'}|to=${args.to}|waitMs=${Date.now() - startedAt}`,
    { debugOnly: true },
    debugGate,
  );
}

export async function runBncrInboundReplyDispatch(args: {
  api: BncrInboundApi;
  channelId: string;
  cfg: BncrInboundConfig;
  parsed: ParsedInbound;
  msgId?: string | null;
  peer: ParsedInbound['peer'];
  rawBody: string;
  storePath: string;
  ctxPayload: BncrInboundContextPayload;
  resolution: BncrInboundConversationResolution;
  replyRouteFact: BncrInboundReplyRouteFact;
  senderIdForContext: string;
  senderDisplayName: string;
  shouldDispatch: boolean;
  silentHistoryFlush?: boolean;
  deliveryId?: string;
  setInboundActivity: (accountId: string, at: number) => void;
  scheduleSave: () => void;
  enqueueFromReply: BncrEnqueueFromReply;
}) {
  const {
    api,
    channelId,
    cfg,
    parsed,
    msgId,
    peer,
    rawBody,
    storePath,
    ctxPayload,
    resolution,
    replyRouteFact,
    senderIdForContext,
    shouldDispatch,
    silentHistoryFlush = false,
    deliveryId,
    setInboundActivity,
    scheduleSave,
    enqueueFromReply,
  } = args;

  const effectiveReply = buildBncrReplyConfig(cfg);
  const sessionIdentityPatch = buildBncrInboundSessionIdentityPatch({
    channelId,
    accountId: resolution.accountId,
    chatType: resolution.chatType,
    displayTo: resolution.canonicalTo,
    senderId: senderIdForContext,
  });
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
    accountId: resolution.accountId,
    to: resolution.canonicalTo,
    resolvedRoute: resolution.resolvedRoute,
    sessionKey: resolution.dispatchSessionKey,
    pinnedMainDmOwner,
  });
  const isBncrNativeCommand =
    parseBncrNativeCommand(rawBody, {
      allowBareWhoami: parsed.isAdmin !== true,
    }) !== null;
  const commandDispatchCfg = mergeBncrCommandOwnerAllowFrom({
    cfg,
    parsed,
    isBncrNativeCommand,
    senderIdForContext,
  });

  if (!shouldDispatch) {
    await wrapBncrInboundRecordSessionLabelCorrection({
      recordInboundSession: recordBncrInboundSession as (
        ...args: unknown[]
      ) => Promise<unknown> | unknown,
      expectedPatch: sessionIdentityPatch,
    })({
      storePath,
      sessionKey: resolution.resolvedRoute.sessionKey,
      ctx: ctxPayload,
      updateLastRoute,
      onRecordError: (err: unknown) => {
        emitBncrLogLine('warn', `[bncr] inbound record session failed: ${String(err)}`);
      },
    });

    const inboundAt = Date.now();
    setInboundActivity(resolution.accountId, inboundAt);
    scheduleSave();
    return;
  }

  // Stop commands also bypass the reply serial chain; the inbound history serial
  // bypass is handled before this function runs so they can interrupt an agent.
  const isStopCommand = isBncrStopCommandText(rawBody);
  const dispatchSessionKey = resolution.dispatchSessionKey;

  const runStopOrSerial = () => {
    const task = () =>
      Promise.resolve(
        resolveBncrChannelInboundRuntime(api).run({
          channel: channelId,
          accountId: resolution.accountId,
          raw: parsed,
          adapter: {
            ingest: () => ({
              id: deliveryId || msgId || `${resolution.canonicalTo}:${Date.now()}`,
              timestamp: Date.now(),
              rawText: rawBody,
              textForAgent: ctxPayload.BodyForAgent,
              textForCommands: ctxPayload.CommandBody,
              raw: parsed,
            }),
            preflight: () => {
              return shouldDispatch
                ? undefined
                : {
                    admission: {
                      kind: 'observeOnly' as const,
                      reason: 'bncr-group-mode-no-reply',
                    },
                  };
            },
            resolveTurn: () => {
              const sessionMetaBarrier = createBncrSessionMetaTaskBarrier();
              return {
                channel: channelId,
                accountId: resolution.accountId,
                routeSessionKey: resolution.resolvedRoute.sessionKey,
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
                    emitBncrLogLine('warn', `[bncr] inbound record session failed: ${String(err)}`);
                  },
                  trackSessionMetaTask: (task: Promise<unknown>) => {
                    sessionMetaBarrier.track(task);
                  },
                },
                runDispatch: async () => {
                  await sessionMetaBarrier.wait();
                  await correctBncrInboundSessionLabel({
                    storePath,
                    sessionKey: dispatchSessionKey,
                    expectedPatch: sessionIdentityPatch,
                  });
                  return Promise.resolve(
                    dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
                      ctx: ctxPayload,
                      cfg: buildBncrReplyConfig(commandDispatchCfg).replyCfg,
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
                          const shouldForwardTool =
                            effectiveReply.blockStreaming && effectiveReply.allowTool;

                          if (kind === 'tool' && !shouldForwardTool) {
                            return;
                          }

                          if (silentHistoryFlush) {
                            return;
                          }

                          await enqueueFromReply({
                            accountId: replyRouteFact.accountId,
                            sessionKey: replyRouteFact.sessionKey,
                            route: replyRouteFact.route,
                            payload: {
                              text: payload.text,
                              mediaUrl: payload.mediaUrl,
                              mediaUrls: payload.mediaUrls,
                              kind: kind || 'final',
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
                  );
                },
              };
            },
            onFinalize: () => {
              const inboundAt = Date.now();
              setInboundActivity(resolution.accountId, inboundAt);
              scheduleSave();
            },
          },
        }),
      ).finally(async () => {
        await waitForBncrReplySessionQuiescence({
          api,
          storePath,
          sessionKey: dispatchSessionKey,
          msgId,
          to: resolution.canonicalTo,
          debugEnabled: cfg?.channels?.bncr?.debug?.verbose === true,
        });
        await correctBncrInboundSessionLabel({
          storePath,
          sessionKey: dispatchSessionKey,
          expectedPatch: sessionIdentityPatch,
        });
      });

    if (isStopCommand) {
      return task();
    }
    return runBncrReplyDispatchSerial(dispatchSessionKey, task);
  };

  await runStopOrSerial();
}
