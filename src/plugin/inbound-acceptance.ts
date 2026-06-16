import { resolveAccount } from '../core/accounts.ts';
import { checkBncrMessageGate } from '../messaging/inbound/gate.ts';
import type { parseBncrInboundParams } from '../messaging/inbound/parse.ts';
import type { OpenClawResolvedAgentRoute } from '../openclaw/routing-runtime.ts';
import type { buildInboundResponsePayload } from './channel-inbound-helpers.ts';
import { resolveInboundSessionContext } from './channel-inbound-helpers.ts';
import type { BncrChannelConfigRoot } from './channel-runtime-types.ts';

type InboundAcceptanceResponsePayload = ReturnType<typeof buildInboundResponsePayload>;

export async function prepareBncrInboundAcceptance(args: {
  api: unknown;
  parsed: ReturnType<typeof parseBncrInboundParams>;
  canonicalAgentId: string;
  asString: (value: unknown, fallback?: string) => string;
  getRuntimeConfig: (api: unknown) => BncrChannelConfigRoot;
  resolveAgentRoute: (params: {
    cfg: BncrChannelConfigRoot;
    channel: string;
    accountId: string;
    peer: unknown;
  }) => OpenClawResolvedAgentRoute;
  buildInboundResponsePayload: (
    args:
      | { kind: 'invalid-peer' }
      | { kind: 'duplicated'; accountId: string; msgId?: string | null }
      | { kind: 'gate-denied'; accountId: string; msgId?: string | null; reason: string },
  ) => InboundAcceptanceResponsePayload;
  markInboundDedupSeen: (key: string) => boolean;
}) {
  const { parsed, canonicalAgentId } = args;
  const {
    accountId,
    platform,
    groupId,
    userId,
    sessionKeyfromroute,
    route,
    text,
    mediaBase64,
    mediaPathFromTransfer,
    msgId,
    peer,
    extracted,
    dedupKey,
  } = parsed;

  if (!platform || (!userId && !groupId)) {
    return {
      ok: false as const,
      status: false,
      payload: args.buildInboundResponsePayload({ kind: 'invalid-peer' }),
    };
  }
  if (args.markInboundDedupSeen(dedupKey)) {
    return {
      ok: false as const,
      status: true,
      payload: args.buildInboundResponsePayload({
        kind: 'duplicated',
        accountId,
        msgId: msgId ?? null,
      }),
    };
  }

  const cfg = args.getRuntimeConfig(args.api);
  const gate = await checkBncrMessageGate({
    parsed,
    cfg,
    account: resolveAccount(cfg, accountId),
  });
  if (!gate.allowed) {
    return {
      ok: false as const,
      status: true,
      payload: args.buildInboundResponsePayload({
        kind: 'gate-denied',
        accountId,
        msgId: msgId ?? null,
        reason: gate.reason,
      }),
    };
  }

  const { sessionKey, inboundText } = resolveInboundSessionContext({
    cfg,
    accountId,
    peer,
    route,
    sessionKeyFromRoute: sessionKeyfromroute,
    canonicalAgentId,
    taskKey: extracted.taskKey ?? undefined,
    text,
    extractedText: extracted.text,
    asString: args.asString,
    resolveAgentRoute: args.resolveAgentRoute,
  });

  return {
    ok: true as const,
    accountId,
    sessionKey,
    inboundText,
    hasMedia: Boolean(mediaBase64 || mediaPathFromTransfer),
  };
}
