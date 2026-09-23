type ChannelModule = typeof import('../channel.ts');
type BridgeSingleton = ReturnType<ChannelModule['createBncrBridge']>;
type ChannelPlugin = ReturnType<ChannelModule['createBncrChannelPlugin']>;

type LoadedRuntime = {
  createBncrBridge: ChannelModule['createBncrBridge'];
  createBncrChannelPlugin: ChannelModule['createBncrChannelPlugin'];
};

export function createDynamicChannelPlugin(args: {
  loaded: LoadedRuntime;
  getCurrentBridge: () => BridgeSingleton;
  resolveBridgeForStart?: () => BridgeSingleton | Promise<BridgeSingleton>;
  isBridgeForStartCurrent?: () => boolean;
  onBridgeStartObserved?: () => void;
  resolveBridgeForStop?: () => BridgeSingleton | null | Promise<BridgeSingleton | null>;
  isBridgeForStopCurrent?: () => boolean;
}): ChannelPlugin {
  const { loaded, getCurrentBridge } = args;
  const resolveBridgeForStart = args.resolveBridgeForStart || getCurrentBridge;
  const isBridgeForStartCurrent = args.isBridgeForStartCurrent || (() => true);
  const resolveBridgeForStop = args.resolveBridgeForStop || getCurrentBridge;
  const isBridgeForStopCurrent = args.isBridgeForStopCurrent || (() => true);
  const base = loaded.createBncrChannelPlugin(() => getCurrentBridge());
  const plugin = { ...base } as ChannelPlugin;
  const outbound = base.outbound as ChannelPlugin['outbound'];
  const baseStatus = base.status;
  const baseGateway = base.gateway;

  type StatusBuildChannelSummaryArgs = Parameters<typeof baseStatus.buildChannelSummary>[0];
  type StatusBuildAccountSnapshotArgs = Parameters<typeof baseStatus.buildAccountSnapshot>[0];
  type StatusResolveAccountStateArgs = Parameters<typeof baseStatus.resolveAccountState>[0];
  type GatewayStartAccountArgs = Parameters<NonNullable<typeof baseGateway.startAccount>>[0];
  type GatewayStopAccountArgs = Parameters<NonNullable<typeof baseGateway.stopAccount>>[0];

  plugin.outbound = {
    ...outbound,
    sendText: (async (ctx: Parameters<typeof outbound.sendText>[0]) =>
      (await getCurrentBridge().channelSendText(ctx)) as Awaited<
        ReturnType<typeof outbound.sendText>
      >) as typeof outbound.sendText,
    sendMedia: (async (ctx: Parameters<typeof outbound.sendMedia>[0]) =>
      (await getCurrentBridge().channelSendMedia(ctx)) as Awaited<
        ReturnType<typeof outbound.sendMedia>
      >) as typeof outbound.sendMedia,
  };

  plugin.status = {
    ...baseStatus,
    buildChannelSummary: async ({ defaultAccountId }: StatusBuildChannelSummaryArgs) =>
      getCurrentBridge().getChannelSummary(defaultAccountId || 'Primary'),
    buildAccountSnapshot: async ({ account, runtime }: StatusBuildAccountSnapshotArgs) => {
      const bridgeNow = getCurrentBridge();
      return baseStatus.buildAccountSnapshot({
        account,
        runtime: runtime || bridgeNow.getAccountRuntimeSnapshot(account?.accountId || 'Primary'),
      });
    },
    resolveAccountState: ({
      enabled,
      configured,
      account,
      cfg,
      runtime,
    }: StatusResolveAccountStateArgs) => {
      const bridgeNow = getCurrentBridge();
      return baseStatus.resolveAccountState({
        enabled,
        configured,
        account,
        cfg,
        runtime: runtime || bridgeNow.getAccountRuntimeSnapshot(account?.accountId || 'Primary'),
      });
    },
  };

  plugin.gateway = {
    ...baseGateway,
    startAccount: async (ctx: GatewayStartAccountArgs) => {
      const bridge = await resolveBridgeForStart();
      if (!isBridgeForStartCurrent()) return;
      const task = bridge.channelStartAccount(
        ctx as Parameters<BridgeSingleton['channelStartAccount']>[0],
      );
      if (isBridgeForStartCurrent()) {
        try {
          args.onBridgeStartObserved?.();
        } catch {
          // Observation is diagnostic-only and must not fail channel startup.
        }
      }
      return task;
    },
    stopAccount: async (ctx: GatewayStopAccountArgs) => {
      const bridge = await resolveBridgeForStop();
      if (!bridge || !isBridgeForStopCurrent()) return;
      return bridge.channelStopAccount(ctx as Parameters<BridgeSingleton['channelStopAccount']>[0]);
    },
  };

  return plugin;
}
