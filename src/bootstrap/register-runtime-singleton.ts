import {
  type BridgeOwner,
  type BridgeRegisterStateCarrier,
  hydrateBridgeRegisterState,
  snapshotBridgeRegisterState,
} from './register-runtime-helpers.ts';
import type { ChannelModule, LoadedRuntime } from './runtime-loader.ts';

type OpenClawPluginApi = Parameters<ChannelModule['createBncrBridge']>[0];
type BridgeSingleton = ReturnType<ChannelModule['createBncrBridge']>;
type BridgeOwnedCarrier = BridgeRegisterStateCarrier & {
  [key: symbol]: unknown;
  stopService?: () => Promise<unknown> | unknown;
  bindApi?: (api: OpenClawPluginApi) => void;
  bindRuntimePaths?: (paths: { pluginRoot: string; pluginFile: string }) => void;
};
type GlobalBridgeStore = typeof globalThis & { __bncrBridge?: BridgeSingleton };

export type BridgeAdoptionMode = 'create' | 'reuse' | 'replace';

function isBridgeOwner(value: unknown): value is BridgeOwner {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'moduleEpoch' in value &&
      'bridgeFactoryId' in value &&
      'apiInstanceId' in value &&
      'registryFingerprint' in value,
  );
}

function getBridgeOwnedCarrier(bridge: BridgeSingleton): BridgeOwnedCarrier {
  return bridge as unknown as BridgeOwnedCarrier;
}

function getBridgeRegisterStateCarrier(bridge: BridgeSingleton): BridgeRegisterStateCarrier {
  return bridge as unknown as BridgeRegisterStateCarrier;
}

export function createBncrBridgeSingletonManager(runtime: {
  bridgeOwnerSymbol: symbol;
  pluginRoot: string;
  pluginFile: string;
  loadBncrRuntimeSync: () => LoadedRuntime;
  getBridgeOwner: (api: OpenClawPluginApi, loaded: LoadedRuntime) => BridgeOwner;
}) {
  const assignBridgeOwner = <T extends BridgeSingleton>(bridge: T, owner: BridgeOwner) => {
    getBridgeOwnedCarrier(bridge)[runtime.bridgeOwnerSymbol] = owner;
    return bridge;
  };

  const adoptBridgeSingleton = (
    api: OpenClawPluginApi,
    owner: BridgeOwner,
    mode: BridgeAdoptionMode,
  ) => {
    const loaded = runtime.loadBncrRuntimeSync();
    const g = globalThis as GlobalBridgeStore;
    const previousOwnerRaw = g.__bncrBridge
      ? getBridgeOwnedCarrier(g.__bncrBridge)[runtime.bridgeOwnerSymbol]
      : undefined;
    const previousOwner = isBridgeOwner(previousOwnerRaw) ? previousOwnerRaw : undefined;

    let created = false;
    let rebuilt = false;
    let bridge: BridgeSingleton | undefined;

    if (!g.__bncrBridge || mode === 'create' || mode === 'replace') {
      const registerState =
        mode === 'replace' && g.__bncrBridge
          ? snapshotBridgeRegisterState(getBridgeRegisterStateCarrier(g.__bncrBridge))
          : null;
      bridge = assignBridgeOwner(
        loaded.createBncrBridge(api, {
          pluginRoot: runtime.pluginRoot,
          pluginFile: runtime.pluginFile,
        }),
        owner,
      );
      hydrateBridgeRegisterState(getBridgeRegisterStateCarrier(bridge), registerState);
      g.__bncrBridge = bridge;
      created = true;
      rebuilt = mode === 'replace' && Boolean(previousOwner);
    } else {
      bridge = g.__bncrBridge;
      bridge.bindApi?.(api);
      assignBridgeOwner(bridge, owner);
    }

    bridge.bindRuntimePaths?.({
      pluginRoot: runtime.pluginRoot,
      pluginFile: runtime.pluginFile,
    });

    return { bridge, runtime: loaded, created, rebuilt, owner, previousOwner };
  };

  const getBridgeSingleton = (api: OpenClawPluginApi) => {
    const loaded = runtime.loadBncrRuntimeSync();
    const owner = runtime.getBridgeOwner(api, loaded);
    const g = globalThis as GlobalBridgeStore;
    const previous = getBridgeOwnerFromBridge(g.__bncrBridge);
    const sameGeneration =
      previous?.moduleEpoch === owner.moduleEpoch &&
      previous?.bridgeFactoryId === owner.bridgeFactoryId &&
      previous?.pluginVersion === owner.pluginVersion &&
      previous?.registrationMode === owner.registrationMode &&
      previous?.pluginRoot === owner.pluginRoot &&
      previous?.pluginFile === owner.pluginFile;
    const mode: BridgeAdoptionMode = !g.__bncrBridge
      ? 'create'
      : sameGeneration
        ? 'reuse'
        : 'replace';
    return adoptBridgeSingleton(api, owner, mode);
  };

  const getExistingBridgeSingleton = () => {
    const g = globalThis as GlobalBridgeStore;
    return g.__bncrBridge;
  };

  const getBridgeOwnerFromBridge = (bridge?: BridgeSingleton): BridgeOwner | undefined => {
    if (!bridge) return undefined;
    const bridgeCarrier = getBridgeOwnedCarrier(bridge);
    for (const symbol of Object.getOwnPropertySymbols(bridge)) {
      const owner = bridgeCarrier[symbol];
      if (isBridgeOwner(owner)) return owner;
    }
    return undefined;
  };

  return {
    assignBridgeOwner,
    adoptBridgeSingleton,
    getBridgeRegisterStateCarrier,
    getBridgeSingleton,
    getExistingBridgeSingleton,
    getBridgeOwnerFromBridge,
  };
}
