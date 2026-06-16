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
}): ChannelPlugin {
  const { loaded, getCurrentBridge } = args;
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
    startAccount: (ctx: GatewayStartAccountArgs) =>
      getCurrentBridge().channelStartAccount(
        ctx as Parameters<BridgeSingleton['channelStartAccount']>[0],
      ),
    stopAccount: (ctx: GatewayStopAccountArgs) =>
      getCurrentBridge().channelStopAccount(
        ctx as Parameters<BridgeSingleton['channelStopAccount']>[0],
      ),
  };

  return plugin;
}
