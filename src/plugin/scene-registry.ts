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

function defaultGroupReplyMode(kind: BncrSceneKind): BncrGroupReplyMode | undefined {
  return kind === 'group' ? 'admin' : undefined;
}

export function buildSceneKey(parsed: ParsedInbound): string {
  return parsed.peer.kind === 'group'
    ? `${parsed.platform}:${parsed.groupId}`
    : `${parsed.platform}:${parsed.userId}`;
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
    ...(kind === 'group' ? { historyLimit: 50 } : {}),
    ...(kind === 'group' ? { historyForce: true } : {}),
    lastSeenAt,
  };
}

export function decideSceneAdmission(args: {
  parsed: ParsedInbound;
  now: number;
  sceneRegistry: Map<string, BncrSceneRecord>;
  defaultAdminAgentId: string;
  defaultPublicAgentId: string;
}): BncrSceneRegistryDecision {
  const { parsed, now, sceneRegistry, defaultAdminAgentId, defaultPublicAgentId } = args;
  const sceneKey = buildSceneKey(parsed);
  const kind = asSceneKind(parsed);
  const existing = sceneRegistry.get(sceneKey);
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
      ...(kind === 'group' && existing.historyLimit === undefined ? { historyLimit: 50 } : {}),
      ...(kind === 'group' && existing.historyForce === undefined ? { historyForce: true } : {}),
      lastSeenAt: now,
    } satisfies BncrSceneRecord;

    if (kind === 'group' && nextScene.status === 'denied' && parsed.isAdmin) {
      const allowedScene = {
        ...nextScene,
        status: 'allowed',
      } satisfies BncrSceneRecord;
      sceneRegistry.set(sceneKey, allowedScene);
      return {
        allowed: true,
        scene: allowedScene,
        agentId: allowedScene.agentId || defaultPublicAgentId,
      };
    }

    sceneRegistry.set(sceneKey, nextScene);

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
    sceneRegistry.set(sceneKey, scene);
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
  sceneRegistry.set(sceneKey, scene);

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
