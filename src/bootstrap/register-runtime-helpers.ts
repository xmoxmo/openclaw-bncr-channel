export type BridgeOwner = {
  moduleEpoch: string;
  bridgeFactoryId: string;
  apiInstanceId: string;
  registryFingerprint: string;
  registrationMode?: string;
};

export type BridgeRegisterStateSnapshot = {
  registerCount: number;
  apiGeneration: number;
  firstRegisterAt: number | null;
  lastRegisterAt: number | null;
  lastApiRebindAt: number | null;
  pluginSource: string | null;
  pluginVersion: string | null;
  lastApiInstanceId: string | null;
  lastRegistryFingerprint: string | null;
  lastDriftSnapshot: unknown;
  registerTraceRecent: Array<Record<string, unknown>>;
};

export type BridgeRegisterStateCarrier = {
  registerCount?: number;
  apiGeneration?: number;
  firstRegisterAt?: number | null;
  lastRegisterAt?: number | null;
  lastApiRebindAt?: number | null;
  pluginSource?: string | null;
  pluginVersion?: string | null;
  lastApiInstanceId?: string | null;
  lastRegistryFingerprint?: string | null;
  lastDriftSnapshot?: unknown;
  registerTraceRecent?: Array<Record<string, unknown>>;
  gatewayPid?: number;
};

export function getProcessOwnerApiInstanceId(args: {
  serviceOwnerApiInstanceId?: string;
  channelOwnerApiInstanceId?: string;
}) {
  return args.serviceOwnerApiInstanceId || args.channelOwnerApiInstanceId || undefined;
}

export function sameBridgeOwner(left?: BridgeOwner, right?: BridgeOwner) {
  if (!left || !right) return false;
  return (
    left.moduleEpoch === right.moduleEpoch &&
    left.bridgeFactoryId === right.bridgeFactoryId &&
    left.apiInstanceId === right.apiInstanceId &&
    left.registryFingerprint === right.registryFingerprint
  );
}

export function snapshotBridgeRegisterState(
  bridge?: BridgeRegisterStateCarrier,
): BridgeRegisterStateSnapshot | null {
  if (!bridge) return null;
  return {
    registerCount: Number(bridge.registerCount || 0),
    apiGeneration: Number(bridge.apiGeneration || 0),
    firstRegisterAt:
      typeof bridge.firstRegisterAt === 'number'
        ? bridge.firstRegisterAt
        : (bridge.firstRegisterAt ?? null),
    lastRegisterAt:
      typeof bridge.lastRegisterAt === 'number'
        ? bridge.lastRegisterAt
        : (bridge.lastRegisterAt ?? null),
    lastApiRebindAt:
      typeof bridge.lastApiRebindAt === 'number'
        ? bridge.lastApiRebindAt
        : (bridge.lastApiRebindAt ?? null),
    pluginSource: typeof bridge.pluginSource === 'string' ? bridge.pluginSource : null,
    pluginVersion: typeof bridge.pluginVersion === 'string' ? bridge.pluginVersion : null,
    lastApiInstanceId:
      typeof bridge.lastApiInstanceId === 'string' ? bridge.lastApiInstanceId : null,
    lastRegistryFingerprint:
      typeof bridge.lastRegistryFingerprint === 'string' ? bridge.lastRegistryFingerprint : null,
    lastDriftSnapshot: bridge.lastDriftSnapshot ?? null,
    registerTraceRecent: Array.isArray(bridge.registerTraceRecent)
      ? bridge.registerTraceRecent.map((trace) => ({ ...trace }))
      : [],
  };
}

export function hydrateBridgeRegisterState<T extends BridgeRegisterStateCarrier>(
  bridge: T,
  snapshot: BridgeRegisterStateSnapshot | null,
) {
  if (!snapshot) return bridge;
  bridge.registerCount = snapshot.registerCount;
  bridge.apiGeneration = snapshot.apiGeneration;
  bridge.firstRegisterAt = snapshot.firstRegisterAt;
  bridge.lastRegisterAt = snapshot.lastRegisterAt;
  bridge.lastApiRebindAt = snapshot.lastApiRebindAt;
  bridge.pluginSource = snapshot.pluginSource;
  bridge.pluginVersion = snapshot.pluginVersion;
  bridge.lastApiInstanceId = snapshot.lastApiInstanceId;
  bridge.lastRegistryFingerprint = snapshot.lastRegistryFingerprint;
  bridge.lastDriftSnapshot = snapshot.lastDriftSnapshot;
  bridge.registerTraceRecent = snapshot.registerTraceRecent.map((trace) => ({ ...trace }));
  return bridge;
}

export function shouldAdoptProcessOwner(args: {
  apiInstanceId: string;
  serviceRegistered?: boolean;
  channelRegistered?: boolean;
  serviceOwnerApiInstanceId?: string;
  channelOwnerApiInstanceId?: string;
}) {
  const existingOwnerApiInstanceId = getProcessOwnerApiInstanceId({
    serviceOwnerApiInstanceId: args.serviceOwnerApiInstanceId,
    channelOwnerApiInstanceId: args.channelOwnerApiInstanceId,
  });
  const hasSingletonOwner = Boolean(args.serviceRegistered) || Boolean(args.channelRegistered);

  if (!hasSingletonOwner) {
    return {
      adoptOwner: true,
      existingOwnerApiInstanceId,
      reason: 'no-singleton-owner',
    };
  }

  if (existingOwnerApiInstanceId && existingOwnerApiInstanceId === args.apiInstanceId) {
    return {
      adoptOwner: true,
      existingOwnerApiInstanceId,
      reason: 'same-owner-api',
    };
  }

  return {
    adoptOwner: false,
    existingOwnerApiInstanceId,
    reason: 'singleton-owned-by-other-api',
  };
}
