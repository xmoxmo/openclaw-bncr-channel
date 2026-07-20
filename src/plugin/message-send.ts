import type { ChannelMessageSendResult } from 'openclaw/plugin-sdk/channel-message';
import type { BncrChannelSendContext } from './channel-runtime-types.ts';

export type BncrMessageSendBridge = {
  channelMessageSendText: (
    ctx: BncrChannelSendContext,
  ) => ChannelMessageSendResult | Promise<ChannelMessageSendResult>;
  channelMessageSendMedia: (
    ctx: BncrChannelSendContext,
  ) => ChannelMessageSendResult | Promise<ChannelMessageSendResult>;
  channelMessageSendPayload: (
    ctx: BncrChannelSendContext,
  ) => ChannelMessageSendResult | Promise<ChannelMessageSendResult>;
};

export function createBncrMessageSend(getBridge: () => BncrMessageSendBridge) {
  return {
    text: async (ctx: BncrChannelSendContext) => getBridge().channelMessageSendText(ctx),
    media: async (ctx: BncrChannelSendContext) => getBridge().channelMessageSendMedia(ctx),
    payload: async (ctx: BncrChannelSendContext) => getBridge().channelMessageSendPayload(ctx),
  };
}
