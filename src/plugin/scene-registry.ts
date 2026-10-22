import type { BncrRoute } from '../core/types.ts';
import { asString } from '../core/value-sanitize.ts';
import type {
  BncrGroupReplyMode,
  BncrSceneKind,
  BncrSceneRecord,
  BncrSceneStatus,
} from './channel-runtime-types.ts';

type ParsedInbound = ReturnType<
  typeof import('../messaging/inbound/parse.ts')['parseBncrInboundParams']
>;

export type BncrSceneRegistryDecision =
  | {
      allowed: true;
      scene: BncrSceneRecord;
      agentId: string;
    }
  | {
      allowed: false;
      scene: BncrSceneRecord;
      reason: string;
      replyPolicy: 'silent' | 'pending';
    };

function asSceneKind(parsed: ParsedInbound): BncrSceneKind {
  return parsed.peer.kind === 'group' ? 'group' : 'direct';
}

// Scene rows are owned per agent: two agents may watch the same chat, and each
// keeps its own admission state, reply mode and history settings. The runtime
// registry therefore stores one entry per (agentId, sceneKey); rows without an
// owner keep the bare scene key so legacy rows still resolve.
const AGENT_SCENE_KEY_SEPARATOR = '\u0000';

export function buildAgentSceneRegistryKey(sceneKey: string, agentId?: string | null): string {
  const key = asString(sceneKey).trim();
  const agent = asString(agentId ?? '').trim();
  return agent ? `${agent}${AGENT_SCENE_KEY_SEPARATOR}${key}` : key;
}

export function resolveSceneRecord(
  registry: ReadonlyMap<string, BncrSceneRecord>,
  sceneKey: string,
  agentId?: string | null,
): BncrSceneRecord | undefined {
  const key = asString(sceneKey).trim();
  if (!key) return undefined;
  const agent = asString(agentId ?? '').trim();
  if (agent) {
    const exact = registry.get(buildAgentSceneRegistryKey(key, agent));
    if (exact) return exact;
    const unowned = registry.get(buildAgentSceneRegistryKey(key));
    if (unowned) return unowned;
    // Scene rows owned by another agent are never reused for a scoped lookup:
    // admission state, reply mode and history settings belong to their owner.
    return undefined;
  }
  // Unscoped lookup (global reads and legacy call sites) keeps the previous
  // behaviour of returning whatever row exists for the key.
  let newest: BncrSceneRecord | undefined;
  for (const record of registry.values()) {
    if (asString(record.sceneKey).trim() !== key) continue;
    if (!newest || (record.lastSeenAt ?? 0) >= (newest.lastSeenAt ?? 0)) newest = record;
  }
  return newest;
}

/**
 * Decide which agent serves a scene. The host route wins when it already has
 * an own row; otherwise an existing row's owner stays authoritative so a bound
 * or previously admitted scene keeps its agent. Neither path borrows state
 * across agents: the returned agent only ever reads its own row.
 */
export function resolveSceneAgentId(
  registry: ReadonlyMap<string, BncrSceneRecord>,
  sceneKey: string,
  routeAgentId?: string | null,
): string {
  const routeAgent = asString(routeAgentId ?? '').trim();
  if (routeAgent) {
    const own = resolveSceneRecord(registry, sceneKey, routeAgent);
    if (own) return asString(own.agentId ?? '').trim() || routeAgent;
  }
  const existing = resolveSceneRecord(registry, sceneKey);
  return asString(existing?.agentId ?? '').trim() || routeAgent;
}

export function setSceneRecord(
  registry: Map<string, BncrSceneRecord>,
  record: BncrSceneRecord,
  options?: { previousAgentId?: string | null },
): void {
  const sceneKey = asString(record.sceneKey).trim();
  if (!sceneKey) return;
  const nextKey = buildAgentSceneRegistryKey(sceneKey, record.agentId);
  if (options) {
    const previousKey = buildAgentSceneRegistryKey(sceneKey, options.previousAgentId);
    if (previousKey !== nextKey) registry.delete(previousKey);
  }
  registry.set(nextKey, record);
}

export function deleteSceneRecord(
  registry: Map<string, BncrSceneRecord>,
  sceneKey: string,
  agentId?: string | null,
): boolean {
  const record = resolveSceneRecord(registry, sceneKey, agentId);
  if (!record) return false;
  return registry.delete(buildAgentSceneRegistryKey(record.sceneKey, record.agentId));
}

function defaultGroupReplyMode(kind: BncrSceneKind): BncrGroupReplyMode | undefined {
  return kind === 'group' ? 'admin' : undefined;
}

function isSceneApproved(scene: BncrSceneRecord): boolean {
  return typeof scene.approvedAt === 'number' && scene.approvedAt > 0;
}

export function buildRouteSceneKey(route: BncrRoute): string {
  const platform = asString(route.platform).trim();
  const groupId = asString(route.groupId).trim() || '0';
  const userId = asString(route.userId).trim() || '0';
  return groupId !== '0' ? `${platform}:${groupId}` : `${platform}:${userId}`;
}

export function buildSceneKey(parsed: ParsedInbound): string {
  return buildRouteSceneKey({
    platform: parsed.platform,
    groupId: parsed.groupId || '0',
    userId: parsed.userId || '0',
  });
}

function buildSceneRecord(args: {
  parsed: ParsedInbound;
  sceneKey: string;
  kind: BncrSceneKind;
  status: BncrSceneStatus;
  agentId?: string;
  lastSeenAt: number;
}): BncrSceneRecord {
  const { parsed, sceneKey, kind, status, agentId, lastSeenAt } = args;
  return {
    sceneKey,
    kind,
    status,
    platform: parsed.platform,
    ...(parsed.userId ? { userId: parsed.userId } : {}),
    ...(parsed.userName ? { userName: parsed.userName } : {}),
    ...(kind === 'group' && parsed.groupId ? { groupId: parsed.groupId } : {}),
    ...(kind === 'group' && parsed.groupName ? { groupName: parsed.groupName } : {}),
    ...(agentId ? { agentId } : {}),
    ...(kind === 'group' ? { groupReplyMode: defaultGroupReplyMode(kind) } : {}),
    historyLimit: 50,
    historyForce: true,
    lastSeenAt,
  };
}

export function decideSceneAdmission(args: {
  parsed: ParsedInbound;
  now: number;
  sceneRegistry: Map<string, BncrSceneRecord>;
  defaultAdminAgentId: string;
  defaultPublicAgentId: string;
  /** Agent the host routes this peer to; selects that agent's scene row. */
  sceneAgentId?: string;
}): BncrSceneRegistryDecision {
  const { parsed, now, sceneRegistry, defaultAdminAgentId, defaultPublicAgentId, sceneAgentId } =
    args;
  const sceneKey = buildSceneKey(parsed);
  const kind = asSceneKind(parsed);
  const resolved = resolveSceneRecord(sceneRegistry, sceneKey, sceneAgentId);
  // Defence in depth: a row owned by a different agent is not this agent's
  // admission state, so it must never drive this decision or be overwritten.
  const existing =
    resolved && resolved.agentId && sceneAgentId && resolved.agentId !== sceneAgentId
      ? undefined
      : resolved;
  const shouldForceDirectNonAdminPublic = (agentId?: string) =>
    kind === 'direct' && parsed.isAdmin !== true && (!agentId || agentId === defaultAdminAgentId);

  if (existing) {
    const forcedAgentId = shouldForceDirectNonAdminPublic(existing.agentId)
      ? defaultPublicAgentId
      : existing.agentId;
    const nextScene = {
      ...existing,
      ...(parsed.userId ? { userId: parsed.userId } : {}),
      ...(parsed.userName ? { userName: parsed.userName } : {}),
      ...(kind === 'group' && parsed.groupId ? { groupId: parsed.groupId } : {}),
      ...(kind === 'group' && parsed.groupName ? { groupName: parsed.groupName } : {}),
      ...(forcedAgentId ? { agentId: forcedAgentId } : {}),
      ...(kind === 'group' && !existing.groupReplyMode
        ? { groupReplyMode: defaultGroupReplyMode(kind) }
        : {}),
      ...(existing.historyLimit === undefined ? { historyLimit: 50 } : {}),
      ...(existing.historyForce === undefined ? { historyForce: true } : {}),
      lastSeenAt: now,
    } satisfies BncrSceneRecord;

    if (kind === 'group' && nextScene.status === 'denied' && parsed.isAdmin) {
      const allowedScene = {
        ...nextScene,
        status: 'allowed',
      } satisfies BncrSceneRecord;
      setSceneRecord(sceneRegistry, allowedScene, { previousAgentId: existing.agentId });
      return {
        allowed: true,
        scene: allowedScene,
        agentId: allowedScene.agentId || defaultPublicAgentId,
      };
    }

    // Direct-chat admission requires an explicit administrator approval. Rows
    // allowed by the old auto-admission logic carry no approval mark, so they
    // return to pending instead of continuing to pass the gate.
    if (
      kind === 'direct' &&
      parsed.isAdmin !== true &&
      nextScene.status === 'allowed' &&
      !isSceneApproved(nextScene)
    ) {
      nextScene.status = 'pending';
    }

    setSceneRecord(sceneRegistry, nextScene, { previousAgentId: existing.agentId });

    if (nextScene.status === 'allowed') {
      const fallbackAgentId =
        kind === 'group'
          ? defaultPublicAgentId
          : parsed.isAdmin
            ? defaultAdminAgentId
            : defaultPublicAgentId;
      return {
        allowed: true,
        scene: nextScene,
        agentId: nextScene.agentId || fallbackAgentId,
      };
    }

    return {
      allowed: false,
      scene: nextScene,
      reason: nextScene.status === 'pending' ? 'scene pending approval' : 'scene denied',
      // Denied and pending scenes never produce a user-visible reply.
      replyPolicy: 'silent',
    };
  }

  if (parsed.isAdmin) {
    const agentId = kind === 'group' ? defaultPublicAgentId : defaultAdminAgentId;
    const scene = buildSceneRecord({
      parsed,
      sceneKey,
      kind,
      status: 'allowed',
      agentId,
      lastSeenAt: now,
    });
    setSceneRecord(sceneRegistry, scene);
    return { allowed: true, scene, agentId };
  }

  if (kind === 'direct') {
    // Admission comes first: an unknown private chat stays pending and
    // completely silent until an administrator allows its SceneId. The
    // non-admin DM policy elevation only applies after this gate passes.
    const scene = buildSceneRecord({
      parsed,
      sceneKey,
      kind,
      status: 'pending',
      lastSeenAt: now,
    });
    setSceneRecord(sceneRegistry, scene);
    return {
      allowed: false,
      scene,
      reason: 'scene pending approval',
      replyPolicy: 'silent',
    };
  }

  const scene = buildSceneRecord({
    parsed,
    sceneKey,
    kind,
    status: 'denied',
    lastSeenAt: now,
  });
  setSceneRecord(sceneRegistry, scene);
  return {
    allowed: false,
    scene,
    reason: 'scene denied',
    replyPolicy: 'silent',
  };
}
