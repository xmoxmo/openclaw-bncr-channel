import { hasControlCommand } from 'openclaw/plugin-sdk/command-auth';
import { resolveAccount } from '../core/accounts.ts';
import { checkBncrMessageGate } from '../messaging/inbound/gate.ts';
import {
  parseBncrNativeCommand,
  resolveBncrNativeCommandParseOptions,
} from '../messaging/inbound/native-command.ts';
import type { parseBncrInboundParams } from '../messaging/inbound/parse.ts';
import type { OpenClawResolvedAgentRoute } from '../openclaw/routing-runtime.ts';
import type { buildInboundResponsePayload } from './channel-inbound-helpers.ts';
import { resolveInboundSessionContext } from './channel-inbound-helpers.ts';
import type { BncrChannelConfigRoot, BncrSceneRecord } from './channel-runtime-types.ts';
import { decideSceneAdmission } from './scene-registry.ts';

type InboundAcceptanceResponsePayload = ReturnType<typeof buildInboundResponsePayload>;

function resolveDispatchBy(args: {
  parsed: ReturnType<typeof parseBncrInboundParams>;
  admission: ReturnType<typeof decideSceneAdmission>;
  cfg: BncrChannelConfigRoot;
}): string {
  const { parsed, admission, cfg } = args;
  if (parsed.peer.kind === 'direct') return 'direct';
  if (!admission.allowed) return 'denied';

  const isBncrNativeCommand =
    parseBncrNativeCommand(
      parsed.extracted.text,
      resolveBncrNativeCommandParseOptions({
        isAdmin: parsed.isAdmin,
        peerKind: parsed.peer.kind as 'direct' | 'group',
      }),
    ) !== null;
  const isAdminOpenClawNativeCommand =
    parsed.isAdmin === true &&
    !isBncrNativeCommand &&
    hasControlCommand(parsed.extracted.text, cfg as Parameters<typeof hasControlCommand>[1]);
  if (isAdminOpenClawNativeCommand) return 'native-command-admin';

  const mode = admission.scene.groupReplyMode || 'admin';
  if (mode === 'all') return 'mode-all';
  if (mode === 'admin') return parsed.isAdmin === true ? 'mode-admin-admin' : 'mode-admin-blocked';
  if (mode === 'mention')
    return parsed.shouldRespond === true ? 'mode-mention-trigger' : 'mode-mention-idle';
  if (parsed.isAdmin === true) return 'mode-hybrid-admin';
  return parsed.shouldRespond === true ? 'mode-hybrid-trigger' : 'mode-hybrid-idle';
}

function shouldDispatchForScene(args: {
  parsed: ReturnType<typeof parseBncrInboundParams>;
  admission: ReturnType<typeof decideSceneAdmission>;
  cfg: BncrChannelConfigRoot;
}) {
  const { parsed, admission, cfg } = args;
  if (parsed.peer.kind === 'direct') return true;
  if (!admission.allowed) return false;

  const isBncrNativeCommand =
    parseBncrNativeCommand(
      parsed.extracted.text,
      resolveBncrNativeCommandParseOptions({
        isAdmin: parsed.isAdmin,
        peerKind: parsed.peer.kind as 'direct' | 'group',
      }),
    ) !== null;
  const isAdminOpenClawNativeCommand =
    parsed.isAdmin === true &&
    !isBncrNativeCommand &&
    hasControlCommand(parsed.extracted.text, cfg as Parameters<typeof hasControlCommand>[1]);
  if (isAdminOpenClawNativeCommand) return true;

  const mode = admission.scene.groupReplyMode || 'admin';
  if (mode === 'all') return true;
  if (mode === 'admin') return parsed.isAdmin === true;
  if (mode === 'mention') return parsed.shouldRespond === true;
  return parsed.isAdmin === true || parsed.shouldRespond === true;
}

function shouldAccumulateForScene(args: {
  shouldDispatch: boolean;
  admission: ReturnType<typeof decideSceneAdmission>;
}) {
  if (args.shouldDispatch) return true;
  const mode = args.admission.scene.groupReplyMode || 'admin';
  return mode === 'mention' || mode === 'hybrid';
}

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
  sceneRegistry: Map<string, BncrSceneRecord>;
  now: () => number;
  defaultAdminAgentId: string;
  defaultPublicAgentId: string;
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

  const admission = decideSceneAdmission({
    parsed,
    now: args.now(),
    sceneRegistry: args.sceneRegistry,
    defaultAdminAgentId: args.defaultAdminAgentId,
    defaultPublicAgentId: args.defaultPublicAgentId,
  });
  if (!admission.allowed) {
    return {
      ok: false as const,
      status: admission.replyPolicy === 'pending',
      payload: args.buildInboundResponsePayload({
        kind: 'gate-denied',
        accountId,
        msgId: msgId ?? null,
        reason: admission.reason,
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
    resolvedAgentId: admission.agentId,
    taskKey: extracted.taskKey ?? undefined,
    text,
    extractedText: extracted.text,
    asString: args.asString,
    resolveAgentRoute: args.resolveAgentRoute,
  });

  const shouldDispatch = shouldDispatchForScene({ parsed, admission, cfg });
  const shouldAccumulate = shouldAccumulateForScene({ shouldDispatch, admission });

  return {
    ok: true as const,
    accountId,
    sessionKey,
    inboundText,
    hasMedia: Boolean(mediaBase64 || mediaPathFromTransfer),
    resolvedAgentId: admission.agentId,
    shouldDispatch,
    shouldAccumulate,
    dispatchBy: resolveDispatchBy({ parsed, admission, cfg }),
  };
}
