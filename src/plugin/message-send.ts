export type BncrMessageSendBridge = {
  channelMessageSendText: (ctx: any) => unknown | Promise<unknown>;
  channelMessageSendMedia: (ctx: any) => unknown | Promise<unknown>;
  channelMessageSendPayload: (ctx: any) => unknown | Promise<unknown>;
};

export function createBncrMessageSend(getBridge: () => BncrMessageSendBridge) {
  return {
    text: async (ctx: any) => getBridge().channelMessageSendText(ctx),
    media: async (ctx: any) => getBridge().channelMessageSendMedia(ctx),
    payload: async (ctx: any) => getBridge().channelMessageSendPayload(ctx),
  };
}
