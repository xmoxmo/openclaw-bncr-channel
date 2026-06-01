import { normalizeAccountId } from '../core/accounts.ts';
import {
  deleteBncrMessageAction,
  editBncrMessageAction,
  reactBncrMessageAction,
  sendBncrReplyAction,
} from '../messaging/outbound/actions.ts';

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

export type BncrOutboundBridge = {
  channelSendText: (ctx: any) => unknown | Promise<unknown>;
  channelSendMedia: (ctx: any) => unknown | Promise<unknown>;
};

export function createBncrOutboundRuntime(getBridge: () => BncrOutboundBridge) {
  return {
    deliveryMode: 'gateway' as const,
    sendText: async (ctx: any) => getBridge().channelSendText(ctx),
    sendMedia: async (ctx: any) => getBridge().channelSendMedia(ctx),
    replyAction: async (ctx: any) =>
      sendBncrReplyAction({
        accountId: normalizeAccountId(ctx?.accountId),
        to: asString(ctx?.to || '').trim(),
        text: asString(ctx?.text || ''),
        replyToMessageId:
          asString(ctx?.replyToId || ctx?.replyToMessageId || '').trim() || undefined,
        sendText: async ({ accountId, to, text }) =>
          getBridge().channelSendText({ accountId, to, text }),
      }),
    deleteAction: async (ctx: any) =>
      deleteBncrMessageAction({
        accountId: normalizeAccountId(ctx?.accountId),
        targetMessageId: asString(ctx?.messageId || ctx?.targetMessageId || '').trim(),
      }),
    reactAction: async (ctx: any) =>
      reactBncrMessageAction({
        accountId: normalizeAccountId(ctx?.accountId),
        targetMessageId: asString(ctx?.messageId || ctx?.targetMessageId || '').trim(),
        emoji: asString(ctx?.emoji || '').trim(),
      }),
    editAction: async (ctx: any) =>
      editBncrMessageAction({
        accountId: normalizeAccountId(ctx?.accountId),
        targetMessageId: asString(ctx?.messageId || ctx?.targetMessageId || '').trim(),
        text: asString(ctx?.text || ''),
      }),
  };
}
