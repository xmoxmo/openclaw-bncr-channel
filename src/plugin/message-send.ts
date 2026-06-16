import type { ChannelMessageSendResult } from 'openclaw/plugin-sdk/channel-message';

type MessageSendContext = Record<string, unknown>;

export type BncrMessageSendBridge = {
  channelMessageSendText: (
    ctx: MessageSendContext,
  ) => ChannelMessageSendResult | Promise<ChannelMessageSendResult>;
  channelMessageSendMedia: (
    ctx: MessageSendContext,
  ) => ChannelMessageSendResult | Promise<ChannelMessageSendResult>;
  channelMessageSendPayload: (
    ctx: MessageSendContext,
  ) => ChannelMessageSendResult | Promise<ChannelMessageSendResult>;
};

export function createBncrMessageSend(getBridge: () => BncrMessageSendBridge) {
  return {
    text: async (ctx: MessageSendContext) => getBridge().channelMessageSendText(ctx),
    media: async (ctx: MessageSendContext) => getBridge().channelMessageSendMedia(ctx),
    payload: async (ctx: MessageSendContext) => getBridge().channelMessageSendPayload(ctx),
  };
}
