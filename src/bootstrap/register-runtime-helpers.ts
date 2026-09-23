export type BridgeOwner = {
  moduleEpoch: string;
  bridgeFactoryId: string;
  apiInstanceId: string;
  registryFingerprint: string;
  registrationMode?: string;
  pluginVersion?: string;
  pluginRoot?: string;
  pluginFile?: string;
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

export function sameBridgeOwner(left?: BridgeOwner, right?: BridgeOwner) {
  if (!left || !right) return false;
  return (
    left.moduleEpoch === right.moduleEpoch &&
    left.bridgeFactoryId === right.bridgeFactoryId &&
    left.apiInstanceId === right.apiInstanceId &&
    left.registryFingerprint === right.registryFingerprint &&
    left.registrationMode === right.registrationMode &&
    left.pluginVersion === right.pluginVersion &&
    left.pluginRoot === right.pluginRoot &&
    left.pluginFile === right.pluginFile
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
