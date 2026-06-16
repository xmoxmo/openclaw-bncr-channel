import { emitBncrLogLine } from '../../core/logging.ts';
import { resolveBncrChannelPolicy } from '../../core/policy.ts';
import {
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
import { buildBncrReplyConfig } from './reply-config.ts';
import { resolveBncrChannelInboundRuntime } from './runtime-compat.ts';
import { wrapBncrInboundRecordSessionLabelCorrection } from './session-label.ts';

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
    setInboundActivity,
    scheduleSave,
    enqueueFromReply,
  } = args;

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
    accountId: resolution.accountId,
    to: resolution.canonicalTo,
    resolvedRoute: resolution.resolvedRoute,
    sessionKey: resolution.dispatchSessionKey,
    pinnedMainDmOwner,
  });

  await resolveBncrChannelInboundRuntime(api).run({
    channel: channelId,
    accountId: resolution.accountId,
    raw: parsed,
    adapter: {
      ingest: () => ({
        id: msgId ?? `${resolution.canonicalTo}:${Date.now()}`,
        timestamp: Date.now(),
        rawText: rawBody,
        textForAgent: ctxPayload.BodyForAgent,
        textForCommands: ctxPayload.CommandBody,
        raw: parsed,
      }),
      resolveTurn: () => ({
        channel: channelId,
        accountId: resolution.accountId,
        routeSessionKey: resolution.resolvedRoute.sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession: wrapBncrInboundRecordSessionLabelCorrection({
          recordInboundSession: recordBncrInboundSession as (
            ...args: unknown[]
          ) => Promise<unknown> | unknown,
          expectedLabel: resolution.canonicalTo,
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
      }),
      onFinalize: () => {
        const inboundAt = Date.now();
        setInboundActivity(resolution.accountId, inboundAt);
        scheduleSave();
      },
    },
  });
}
