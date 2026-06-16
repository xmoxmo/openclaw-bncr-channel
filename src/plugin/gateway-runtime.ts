import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
} from 'openclaw/plugin-sdk/channel-contract';

type GatewayAccountContext = Pick<
  ChannelGatewayContext,
  'accountId' | 'abortSignal' | 'getStatus' | 'setStatus'
> & {
  getStatus?: () => ChannelAccountSnapshot;
  setStatus?: (status: ChannelAccountSnapshot) => void;
};

export type BncrGatewayAccountBridge = {
  channelStartAccount: (ctx: GatewayAccountContext) => void | Promise<void>;
  channelStopAccount: (ctx: GatewayAccountContext) => void | Promise<void>;
};

export function createBncrGatewayRuntime(getBridge: () => BncrGatewayAccountBridge) {
  return {
    startAccount: async (ctx: GatewayAccountContext) => getBridge().channelStartAccount(ctx),
    stopAccount: async (ctx: GatewayAccountContext) => getBridge().channelStopAccount(ctx),
  };
}
