import {
  type BridgeOwner,
  type BridgeRegisterStateCarrier,
  hydrateBridgeRegisterState,
  sameBridgeOwner,
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

  const getBridgeSingleton = (api: OpenClawPluginApi) => {
    const loaded = runtime.loadBncrRuntimeSync();
    const g = globalThis as GlobalBridgeStore;
    const owner = runtime.getBridgeOwner(api, loaded);
    const previousOwnerRaw = g.__bncrBridge
      ? getBridgeOwnedCarrier(g.__bncrBridge)[runtime.bridgeOwnerSymbol]
      : undefined;
    const previousOwner = isBridgeOwner(previousOwnerRaw) ? previousOwnerRaw : undefined;

    let created = false;
    let rebuilt = false;

    if (g.__bncrBridge) {
      const mustRebuild =
        !sameBridgeOwner(previousOwner, owner) &&
        (previousOwner?.moduleEpoch !== owner.moduleEpoch ||
          previousOwner?.bridgeFactoryId !== owner.bridgeFactoryId ||
          previousOwner?.registrationMode !== owner.registrationMode ||
          previousOwner?.apiInstanceId !== owner.apiInstanceId ||
          previousOwner?.registryFingerprint !== owner.registryFingerprint);

      if (mustRebuild) {
        const registerState = snapshotBridgeRegisterState(
          getBridgeRegisterStateCarrier(g.__bncrBridge),
        );
        try {
          g.__bncrBridge.stopService?.();
        } catch {
          // ignore stop errors during hot-restart recovery
        }
        const rebuiltBridge = assignBridgeOwner(
          loaded.createBncrBridge(api, {
            pluginRoot: runtime.pluginRoot,
            pluginFile: runtime.pluginFile,
          }),
          owner,
        );
        hydrateBridgeRegisterState(getBridgeRegisterStateCarrier(rebuiltBridge), registerState);
        g.__bncrBridge = rebuiltBridge;
        created = true;
        rebuilt = true;
      } else {
        g.__bncrBridge.bindApi?.(api);
        assignBridgeOwner(g.__bncrBridge, owner);
      }
    } else {
      g.__bncrBridge = assignBridgeOwner(
        loaded.createBncrBridge(api, {
          pluginRoot: runtime.pluginRoot,
          pluginFile: runtime.pluginFile,
        }),
        owner,
      );
      created = true;
    }

    g.__bncrBridge?.bindRuntimePaths?.({
      pluginRoot: runtime.pluginRoot,
      pluginFile: runtime.pluginFile,
    });

    return { bridge: g.__bncrBridge, runtime: loaded, created, rebuilt, owner, previousOwner };
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
    getBridgeRegisterStateCarrier,
    getBridgeSingleton,
    getExistingBridgeSingleton,
    getBridgeOwnerFromBridge,
  };
}
