import { emitBncrLogLine } from '../../core/logging.ts';
import { performBncrGatewaySessionReset } from '../../openclaw/session-reset-runtime.ts';
import type { BncrSceneRecord } from '../../plugin/channel-runtime-types.ts';
import { ADMIN_REQUIRED_TEXT } from './command-constants.ts';
import type { BncrEnqueueFromReply, BncrRememberSessionRoute } from './contracts.ts';
import type { ParsedInbound } from './dispatch-prep.ts';
import {
  type NativeCommand,
  type NativeHelpCommand,
  type NativeSessionResetCommand,
  type NativeStatusCommand,
  type NativeVerboseCommand,
  type NativeWhoamiCommand,
  resolveBncrNativeHelpCommand,
  resolveBncrNativeSessionResetCommand,
  resolveBncrNativeStatusCommand,
  resolveBncrNativeVerboseCommand,
  resolveBncrNativeWhoamiCommand,
} from './native-command.ts';
import {
  buildBncrNativeCommandSummary,
  type createNativeCommandTurnContext,
  logBncrNativeCommandEvent,
  logBncrNativeCommandSummary,
} from './native-command-runtime.ts';
import {
  type BncrSceneAdminCommand,
  executeSceneAdminCommand,
  parseSceneAdminCommand,
} from './scene-admin.ts';
import {
  type BncrSessionIdentityCommand,
  executeSessionIdentityCommand,
  parseSessionIdentityCommand,
} from './session-identity-command.ts';
import { recordAndPatchBncrInboundSessionEntry } from './session-label.ts';
import {
  executeStaleScenesCommand,
  parseStaleScenesCommand,
  type StaleScenesCommand,
} from './stale-scenes-command.ts';

export { ADMIN_REQUIRED_TEXT };

/**
 * Everything the local command handlers need. Built once by the caller so the
 * handlers stay thin adapters over the existing parse/execute modules.
 */
export type LocalCommandContext = {
  command: NativeCommand;
  parsed: ParsedInbound;
  effectiveIsAdmin: boolean;
  accountId: string;
  msgId?: string | null;
  route: ParsedInbound['route'];
  peer: ParsedInbound['peer'];
  displayTo: string;
  baseSessionKey: string;
  sessionKey: string;
  storePath: string;
  ctxPayload: Awaited<ReturnType<typeof createNativeCommandTurnContext>>;
  sessionIdentityPatch: Record<string, unknown>;
  buildSessionIdentityPatch: () => Record<string, unknown>;
  currentVerboseLevel?: 'on' | 'off' | 'full';
  knownAgentIds: ReadonlySet<string>;
  sceneRegistry: Map<string, BncrSceneRecord>;
  routeAgentId: string;
  sceneAgentId: string;
  defaultAdminAgentId: string;
  defaultPublicAgentId: string;
  now: () => number;
  rememberSessionRoute: BncrRememberSessionRoute;
  enqueueFromReply: BncrEnqueueFromReply;
  purgeSceneSession?: (args: {
    sceneKey: string;
    agentId: string;
    sessionKey: string | null;
  }) => Promise<void> | void;
  readSessionUpdatedAt: (args: {
    agentId: string;
    sessionKey: string;
  }) => Promise<number | null | undefined>;
  readSessionNode?: (args: {
    agentId: string;
    sessionKey: string;
  }) => Promise<
    { exists: boolean; archivedAt: number | null; updatedAt: number | null } | undefined
  >;
  deleteSession: (args: {
    agentId: string;
    sessionKey: string;
    archiveTranscript?: boolean;
  }) => Promise<boolean>;
  nativeCommandDebugEnabled: boolean;
};

export type LocalCommandHandledResult = {
  handled: true;
  command: string;
  sessionKey: string;
};

type MatchedLocalCommand =
  | { matched: true; valid: false; text: string }
  | { matched: true; valid: true; data?: unknown };

type ParsedLocalCommand = { matched: false } | MatchedLocalCommand;

type GateDecision = { action: 'allow' } | { action: 'reject'; mode: 'reply' | 'silent' };

type LocalCommandHandler = {
  id: string;
  logKind: (ctx: LocalCommandContext) => string;
  gate?: (ctx: LocalCommandContext) => GateDecision;
  parse: (ctx: LocalCommandContext) => ParsedLocalCommand;
  run: (
    ctx: LocalCommandContext,
    parsed: MatchedLocalCommand,
  ) => Promise<LocalCommandHandledResult>;
};

/**
 * Direct-chat commands a non-admin may run against their own session only.
 * Kept here (not scattered) so the gate and the executor flag share one list.
 */
const DIRECT_SELF_ADMIN_COMMANDS = new Set([
  'history-help',
  'history-limit',
  'history-force',
  'download-media',
]);

function isDirectSelfAdminCommand(ctx: LocalCommandContext): boolean {
  return ctx.peer.kind === 'direct' && DIRECT_SELF_ADMIN_COMMANDS.has(ctx.command.command);
}

function handled(ctx: LocalCommandContext): LocalCommandHandledResult {
  return { handled: true, command: ctx.command.command, sessionKey: ctx.sessionKey };
}

function logSummary(ctx: LocalCommandContext, kind: string, result: 'handled' | 'rejected'): void {
  logBncrNativeCommandSummary(
    buildBncrNativeCommandSummary({
      kind,
      command: ctx.command.command,
      accountId: ctx.accountId,
      to: ctx.displayTo,
      msgId: ctx.msgId || null,
      result,
    }),
  );
}

/** Persist the session identity patch + remember the route + deliver one reply. */
async function persistAndEnqueue(
  ctx: LocalCommandContext,
  opts: {
    text: string;
    patch?: Record<string, unknown> | (() => Record<string, unknown>);
    enqueueSessionKey?: string;
  },
): Promise<void> {
  const patch =
    typeof opts.patch === 'function' ? opts.patch() : (opts.patch ?? ctx.sessionIdentityPatch);
  await recordAndPatchBncrInboundSessionEntry({
    storePath: ctx.storePath,
    sessionKey: ctx.sessionKey,
    ctx: ctx.ctxPayload,
    patch,
  });
  ctx.rememberSessionRoute(ctx.baseSessionKey, ctx.accountId, ctx.route);
  await ctx.enqueueFromReply({
    accountId: ctx.accountId,
    sessionKey: opts.enqueueSessionKey ?? ctx.sessionKey,
    route: ctx.route,
    payload: { text: opts.text, replyToId: ctx.msgId || undefined },
  });
}

async function reply(
  ctx: LocalCommandContext,
  opts: {
    text: string;
    kind: string;
    result?: 'handled' | 'rejected';
    patch?: Record<string, unknown> | (() => Record<string, unknown>);
  },
): Promise<void> {
  logSummary(ctx, opts.kind, opts.result ?? 'handled');
  await persistAndEnqueue(ctx, { text: opts.text, patch: opts.patch });
}

/** Record + remember with no reply: the silent-reject convention. */
async function persistOnly(ctx: LocalCommandContext): Promise<void> {
  await recordAndPatchBncrInboundSessionEntry({
    storePath: ctx.storePath,
    sessionKey: ctx.sessionKey,
    ctx: ctx.ctxPayload,
    patch: ctx.sessionIdentityPatch,
  });
  ctx.rememberSessionRoute(ctx.baseSessionKey, ctx.accountId, ctx.route);
}

/**
 * Ordered command families. Ordering and per-family gate/parse/run reproduce
 * the previous hand-written if-chain exactly. Add a new command by adding it to
 * an existing family (or a new family entry), never by editing the dispatcher.
 */
const LOCAL_COMMAND_HANDLERS: LocalCommandHandler[] = [
  {
    id: 'help',
    logKind: () => 'help',
    parse: (ctx) => {
      const help = resolveBncrNativeHelpCommand(ctx.command, {
        isAdmin: ctx.effectiveIsAdmin,
        peerKind: ctx.peer.kind as 'direct' | 'group',
      });
      return help ? { matched: true, valid: true, data: help } : { matched: false };
    },
    run: async (ctx, parsed) => {
      const help = (parsed as { data: NativeHelpCommand }).data;
      await reply(ctx, { text: help.text, kind: 'help' });
      return handled(ctx);
    },
  },
  {
    id: 'whoami',
    logKind: () => 'whoami',
    parse: (ctx) => {
      const whoami = resolveBncrNativeWhoamiCommand({
        command: ctx.command,
        platform: ctx.parsed.platform,
        groupId: ctx.parsed.groupId,
        groupName: ctx.parsed.groupName,
        userId: ctx.parsed.userId,
        userName: ctx.parsed.userName,
        isGroup: ctx.parsed.isGroup,
        isAdmin: ctx.effectiveIsAdmin,
      });
      return whoami ? { matched: true, valid: true, data: whoami } : { matched: false };
    },
    run: async (ctx, parsed) => {
      const whoami = (parsed as { data: NativeWhoamiCommand }).data;
      await reply(ctx, { text: whoami.text, kind: 'whoami' });
      return handled(ctx);
    },
  },
  {
    id: 'status',
    logKind: () => 'status',
    parse: (ctx) => {
      const status = resolveBncrNativeStatusCommand({
        command: ctx.command,
        accountId: ctx.accountId,
        platform: ctx.parsed.platform,
        userId: ctx.parsed.userId,
        userName: ctx.parsed.userName,
        resolvedAgentId: ctx.routeAgentId,
        sessionKey: ctx.sessionKey,
      });
      return status ? { matched: true, valid: true, data: status } : { matched: false };
    },
    run: async (ctx, parsed) => {
      const status = (parsed as { data: NativeStatusCommand }).data;
      await reply(ctx, { text: status.text, kind: 'status' });
      return handled(ctx);
    },
  },
  {
    id: 'session-reset',
    logKind: (ctx) => ctx.command.command,
    gate: (ctx) =>
      ctx.peer.kind === 'direct' || ctx.effectiveIsAdmin
        ? { action: 'allow' }
        : { action: 'reject', mode: 'silent' },
    parse: (ctx) => {
      const reset = resolveBncrNativeSessionResetCommand({
        command: ctx.command,
        peerKind: ctx.peer.kind as 'direct' | 'group',
      });
      return reset ? { matched: true, valid: true, data: reset } : { matched: false };
    },
    run: async (ctx, parsed) => {
      const reset = (parsed as { data: NativeSessionResetCommand }).data;
      const requestedAgentId = ctx.routeAgentId;
      // Record the identity patch before the reset wipes the session entry.
      await recordAndPatchBncrInboundSessionEntry({
        storePath: ctx.storePath,
        sessionKey: ctx.sessionKey,
        ctx: ctx.ctxPayload,
        patch: ctx.sessionIdentityPatch,
      });
      let resetResult: { ok?: boolean } | undefined;
      try {
        resetResult = await performBncrGatewaySessionReset({
          key: ctx.baseSessionKey,
          reason: reset.reason,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          commandSource: 'bncr:native-command',
        });
      } catch (resetError) {
        emitBncrLogLine(
          'error',
          `[bncr] native-command sessions.reset failed|key=${ctx.baseSessionKey}|err=${
            resetError instanceof Error ? resetError.message : String(resetError)
          }`,
        );
        await ctx.enqueueFromReply({
          accountId: ctx.accountId,
          sessionKey: ctx.baseSessionKey,
          route: ctx.route,
          payload: {
            text: 'Session reset failed. Check the server log for details.',
            replyToId: ctx.msgId || undefined,
          },
        });
        return { handled: true, command: ctx.command.command, sessionKey: ctx.baseSessionKey };
      }
      if (resetResult?.ok === false) {
        await ctx.enqueueFromReply({
          accountId: ctx.accountId,
          sessionKey: ctx.baseSessionKey,
          route: ctx.route,
          payload: {
            text: 'Session reset was rejected by the gateway.',
            replyToId: ctx.msgId || undefined,
          },
        });
        return { handled: true, command: ctx.command.command, sessionKey: ctx.baseSessionKey };
      }
      logSummary(ctx, reset.reason, 'handled');
      ctx.rememberSessionRoute(ctx.baseSessionKey, ctx.accountId, ctx.route);
      await ctx.enqueueFromReply({
        accountId: ctx.accountId,
        sessionKey: ctx.baseSessionKey,
        route: ctx.route,
        payload: { text: reset.text, replyToId: ctx.msgId || undefined },
      });
      return { handled: true, command: ctx.command.command, sessionKey: ctx.baseSessionKey };
    },
  },
  {
    id: 'verbose',
    logKind: () => 'verbose',
    gate: (ctx) =>
      !ctx.effectiveIsAdmin && ctx.peer.kind !== 'direct'
        ? { action: 'reject', mode: ctx.peer.kind !== 'group' ? 'reply' : 'silent' }
        : { action: 'allow' },
    parse: (ctx) => {
      const verbose = resolveBncrNativeVerboseCommand(ctx.command, ctx.currentVerboseLevel);
      return verbose ? { matched: true, valid: true, data: verbose } : { matched: false };
    },
    run: async (ctx, parsed) => {
      const verbose = (parsed as { data: NativeVerboseCommand }).data;
      logSummary(ctx, 'verbose', 'handled');
      logBncrNativeCommandEvent(
        'handled-verbose',
        {
          command: ctx.command.command,
          accountId: ctx.accountId,
          sessionKey: ctx.sessionKey,
          to: ctx.displayTo,
          msgId: ctx.msgId || null,
          fallbackToAgent: false,
        },
        { debugOnly: true, debugEnabled: ctx.nativeCommandDebugEnabled },
      );
      await persistAndEnqueue(ctx, {
        text: verbose.text,
        patch: {
          ...ctx.sessionIdentityPatch,
          ...(verbose.verboseLevel ? { verboseLevel: verbose.verboseLevel } : {}),
        },
      });
      return handled(ctx);
    },
  },
  {
    id: 'identity',
    logKind: () => 'session-identity',
    parse: (ctx) => {
      const identity = parseSessionIdentityCommand(ctx.command, {
        knownAgentIds: ctx.knownAgentIds,
      });
      if (!identity.matched) return { matched: false };
      if (!identity.valid) return { matched: true, valid: false, text: identity.text };
      return { matched: true, valid: true, data: identity.command };
    },
    run: async (ctx, parsed) => {
      // Identity keeps its original convention: usage errors and denied writes
      // are logged as handled, and the patch is rebuilt after any mutation.
      if (!parsed.valid) {
        await reply(ctx, {
          text: parsed.text,
          kind: 'session-identity',
          patch: ctx.buildSessionIdentityPatch,
        });
        return handled(ctx);
      }
      const identity = (parsed as { data: BncrSessionIdentityCommand }).data;
      const outcome = executeSessionIdentityCommand({
        parsed: ctx.parsed,
        command: identity,
        sceneRegistry: ctx.sceneRegistry,
        sceneAgentId: ctx.sceneAgentId,
        now: ctx.now,
      });
      await reply(ctx, {
        text: outcome.text,
        kind: 'session-identity',
        patch: ctx.buildSessionIdentityPatch,
      });
      return handled(ctx);
    },
  },
  {
    id: 'stale',
    logKind: () => 'maintenance',
    gate: (ctx) =>
      ctx.effectiveIsAdmin ? { action: 'allow' } : { action: 'reject', mode: 'reply' },
    parse: (ctx) => {
      const stale = parseStaleScenesCommand(ctx.command);
      if (!stale.matched) return { matched: false };
      if (!stale.valid) return { matched: true, valid: false, text: stale.text };
      return { matched: true, valid: true, data: stale.command };
    },
    run: async (ctx, parsed) => {
      if (!parsed.valid) {
        await reply(ctx, { text: parsed.text, kind: 'maintenance', result: 'rejected' });
        return handled(ctx);
      }
      const stale = (parsed as { data: StaleScenesCommand }).data;
      const outcome = await executeStaleScenesCommand({
        command: stale,
        sceneRegistry: ctx.sceneRegistry,
        now: ctx.now,
        readSessionUpdatedAt: ctx.readSessionUpdatedAt,
        readSessionNode: ctx.readSessionNode,
        deleteSession: ctx.deleteSession,
        purgeSessionState: ctx.purgeSceneSession,
      });
      await reply(ctx, { text: outcome.text, kind: 'maintenance' });
      return handled(ctx);
    },
  },
  {
    id: 'scene-admin',
    logKind: () => 'scene-admin',
    gate: (ctx) =>
      ctx.effectiveIsAdmin || isDirectSelfAdminCommand(ctx)
        ? { action: 'allow' }
        : { action: 'reject', mode: 'reply' },
    parse: (ctx) => {
      const sceneAdmin = parseSceneAdminCommand(ctx.command);
      if (!sceneAdmin.matched) return { matched: false };
      if (!sceneAdmin.valid) return { matched: true, valid: false, text: sceneAdmin.text };
      return { matched: true, valid: true, data: sceneAdmin.command };
    },
    run: async (ctx, parsed) => {
      if (!parsed.valid) {
        await reply(ctx, { text: parsed.text, kind: 'scene-admin', result: 'rejected' });
        return handled(ctx);
      }
      const sceneAdmin = (parsed as { data: BncrSceneAdminCommand }).data;
      const outcome = executeSceneAdminCommand({
        parsed: ctx.parsed,
        command: sceneAdmin,
        sceneRegistry: ctx.sceneRegistry,
        defaultAdminAgentId: ctx.defaultAdminAgentId,
        defaultPublicAgentId: ctx.defaultPublicAgentId,
        now: ctx.now,
        allowNonAdminSelfAdmin: isDirectSelfAdminCommand(ctx),
        agentId: ctx.sceneAgentId,
      });
      await reply(ctx, {
        text: outcome.text,
        kind: 'scene-admin',
        result: outcome.ok ? 'handled' : 'rejected',
      });
      return handled(ctx);
    },
  },
];

/**
 * Run the first matching local command family.
 *
 * Returns null when no family matches, so the caller falls through to the
 * OpenClaw native dispatch path (bare control commands, agent fallback).
 */
export async function dispatchLocalCommand(
  ctx: LocalCommandContext,
): Promise<LocalCommandHandledResult | null> {
  for (const handler of LOCAL_COMMAND_HANDLERS) {
    const parsed = handler.parse(ctx);
    if (!parsed.matched) continue;

    const decision = handler.gate ? handler.gate(ctx) : { action: 'allow' as const };
    if (decision.action === 'reject') {
      const kind = handler.logKind(ctx);
      if (decision.mode === 'reply') {
        await reply(ctx, { text: ADMIN_REQUIRED_TEXT, kind, result: 'rejected' });
      } else {
        logSummary(ctx, kind, 'rejected');
        await persistOnly(ctx);
      }
      return handled(ctx);
    }

    return handler.run(ctx, parsed);
  }
  return null;
}
