export type BncrGatewayAccountBridge = {
  channelStartAccount: (ctx: any) => unknown | Promise<unknown>;
  channelStopAccount: (ctx: any) => unknown | Promise<unknown>;
};

export function createBncrGatewayRuntime(getBridge: () => BncrGatewayAccountBridge) {
  return {
    startAccount: async (ctx: any) => getBridge().channelStartAccount(ctx),
    stopAccount: async (ctx: any) => getBridge().channelStopAccount(ctx),
  };
}
