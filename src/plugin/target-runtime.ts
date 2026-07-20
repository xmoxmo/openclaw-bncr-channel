import {
  buildCanonicalBncrSessionKey,
  formatDisplayScope,
  parseRouteFromDisplayScope,
  parseStrictBncrSessionKey,
  routeKey,
} from '../core/targets.ts';
import type { BncrRoute } from '../core/types.ts';
import { asString } from '../core/value-sanitize.ts';
import { getOpenClawRuntimeConfigOrDefault } from '../openclaw/config-runtime.ts';
import type { BncrChannelConfigRoot } from './channel-runtime-types.ts';

export function createBncrTargetRuntime(runtime: {
  api: Parameters<typeof getOpenClawRuntimeConfigOrDefault>[0];
  channelId: string;
  canonicalAgentId: string | null;
  now: () => number;
  normalizeAccountId: (accountId: string) => string;
  sessionRoutes: Map<string, { accountId: string; route: BncrRoute; updatedAt: number }>;
  routeAliases: Map<string, { accountId: string; route: BncrRoute; updatedAt: number }>;
  lastSessionByAccount: Map<string, { sessionKey: string; scope: string; updatedAt: number }>;
  markActivity: (accountId: string, at?: number) => void;
  scheduleSave: () => void;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  ensureCanonicalAgentId: (args: {
    cfg: BncrChannelConfigRoot;
    accountId: string;
    channelId: string;
    peer: { kind: 'direct'; id: string };
  }) => string;
}) {
  function rememberSessionRoute(sessionKey: string, accountId: string, route: BncrRoute) {
    const key = asString(sessionKey).trim();
    if (!key) return;

    const acc = runtime.normalizeAccountId(accountId);
    const t = runtime.now();
    const info = { accountId: acc, route, updatedAt: t };

    runtime.sessionRoutes.set(key, info);
    runtime.routeAliases.set(routeKey(acc, route), info);
    runtime.lastSessionByAccount.set(acc, {
      sessionKey: key,
      scope: formatDisplayScope(route),
      updatedAt: t,
    });
    runtime.markActivity(acc, t);
    runtime.scheduleSave();
  }

  function resolveRouteBySession(sessionKey: string, accountId: string): BncrRoute | null {
    const key = asString(sessionKey).trim();
    const hit = runtime.sessionRoutes.get(key);
    if (
      hit &&
      runtime.normalizeAccountId(accountId) === runtime.normalizeAccountId(hit.accountId)
    ) {
      return hit.route;
    }

    const parsed = parseStrictBncrSessionKey(key);
    if (!parsed) return null;

    const alias = runtime.routeAliases.get(
      routeKey(runtime.normalizeAccountId(accountId), parsed.route),
    );
    return alias?.route || parsed.route;
  }

  function resolveVerifiedTarget(
    rawTarget: string,
    accountId: string,
  ): { sessionKey: string; route: BncrRoute; displayScope: string } {
    const acc = runtime.normalizeAccountId(accountId);
    const raw = asString(rawTarget).trim();
    if (!raw) throw new Error('bncr invalid target(empty)');

    runtime.logInfo('target', `incoming raw=${raw} accountId=${acc}`, { debugOnly: true });

    let route: BncrRoute | null = null;

    const strict = parseStrictBncrSessionKey(raw);
    if (strict) {
      route = strict.route;
    } else {
      route = parseRouteFromDisplayScope(raw) || resolveRouteBySession(raw, acc);
    }

    if (!route) {
      runtime.logWarn(
        'target',
        `invalid raw=${raw} accountId=${acc} reason=unparseable-or-unknown canonicalTo=Bncr:<platform>:0:<userId>|Bncr:<platform>:<groupId>:0 acceptedAliases=Bncr:<platform>:User:<userId>|Bncr:<platform>:Group:<groupId> standardSessionKey=agent:<agentId>:bncr:<direct|group>:<hex(scope)>`,
        { debugOnly: true },
      );
      throw new Error(
        `bncr invalid target(canonical: Bncr:<platform>:0:<userId> | Bncr:<platform>:<groupId>:0; aliases: Bncr:<platform>:User:<userId> | Bncr:<platform>:Group:<groupId>): ${raw}`,
      );
    }

    const canonicalAgentId =
      runtime.canonicalAgentId ||
      runtime.ensureCanonicalAgentId({
        cfg: getOpenClawRuntimeConfigOrDefault<BncrChannelConfigRoot>(runtime.api, {}),
        accountId: acc,
        channelId: runtime.channelId,
        peer: { kind: 'direct', id: route.groupId === '0' ? route.userId : route.groupId },
      });
    const verified = {
      sessionKey: buildCanonicalBncrSessionKey(route, canonicalAgentId),
      route,
      displayScope: formatDisplayScope(route),
    };

    runtime.logInfo(
      'target',
      `canonical raw=${raw} accountId=${acc} verified=${JSON.stringify(verified)}`,
      { debugOnly: true },
    );

    runtime.lastSessionByAccount.set(acc, {
      sessionKey: verified.sessionKey,
      scope: verified.displayScope,
      updatedAt: runtime.now(),
    });
    runtime.scheduleSave();

    return verified;
  }

  function resolveSessionAccountId(sessionKey: string): string | null {
    const key = asString(sessionKey).trim();
    if (!key) return null;
    const hit = runtime.sessionRoutes.get(key);
    return hit ? hit.accountId : null;
  }

  return {
    rememberSessionRoute,
    resolveRouteBySession,
    resolveVerifiedTarget,
    resolveSessionAccountId,
  };
}
