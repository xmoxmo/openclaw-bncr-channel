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
  }
  const unowned = registry.get(buildAgentSceneRegistryKey(key));
  if (unowned) return unowned;
  let newest: BncrSceneRecord | undefined;
  for (const record of registry.values()) {
    if (asString(record.sceneKey).trim() !== key) continue;
    if (!newest || (record.lastSeenAt ?? 0) >= (newest.lastSeenAt ?? 0)) newest = record;
  }
  return newest;
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
  const existing = resolveSceneRecord(sceneRegistry, sceneKey, sceneAgentId);
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
      replyPolicy:
        kind === 'group' ? 'silent' : nextScene.status === 'pending' ? 'pending' : 'silent',
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

  const directNonAdminAllowed = kind === 'direct';
  const scene = buildSceneRecord({
    parsed,
    sceneKey,
    kind,
    status: directNonAdminAllowed ? 'allowed' : 'denied',
    agentId: directNonAdminAllowed ? defaultPublicAgentId : undefined,
    lastSeenAt: now,
  });
  setSceneRecord(sceneRegistry, scene);

  if (directNonAdminAllowed) {
    return {
      allowed: true,
      scene,
      agentId: scene.agentId || defaultPublicAgentId,
    };
  }

  return {
    allowed: false,
    scene,
    reason: 'scene denied',
    replyPolicy: 'silent',
  };
}
