import { normalizeAccountId } from '../core/accounts.ts';
import { asString } from '../core/value-sanitize.ts';
import {
  deleteBncrMessageAction,
  editBncrMessageAction,
  reactBncrMessageAction,
  sendBncrReplyAction,
} from '../messaging/outbound/actions.ts';
import type { BncrChannelSendContext } from './channel-runtime-types.ts';

type BncrOutboundDeliveryResult = { channel: string; messageId: string; chatId: string };

type BncrOutboundReplyActionContext = {
  accountId?: string | null;
  to?: string;
  text?: string;
  replyToId?: string | null;
  replyToMessageId?: string | null;
};

type BncrOutboundTargetActionContext = {
  accountId?: string | null;
  messageId?: string | null;
  targetMessageId?: string | null;
};

type BncrOutboundReactActionContext = BncrOutboundTargetActionContext & {
  emoji?: string | null;
};

type BncrOutboundEditActionContext = BncrOutboundTargetActionContext & {
  text?: string;
};

export type BncrOutboundBridge = {
  channelSendText: (
    ctx: BncrChannelSendContext,
  ) => BncrOutboundDeliveryResult | Promise<BncrOutboundDeliveryResult>;
  channelSendMedia: (
    ctx: BncrChannelSendContext,
  ) => BncrOutboundDeliveryResult | Promise<BncrOutboundDeliveryResult>;
};

export function createBncrOutboundRuntime(getBridge: () => BncrOutboundBridge) {
  return {
    deliveryMode: 'gateway' as const,
    sendText: async (ctx: BncrChannelSendContext) => getBridge().channelSendText(ctx),
    sendMedia: async (ctx: BncrChannelSendContext) => getBridge().channelSendMedia(ctx),
    replyAction: async (ctx: BncrOutboundReplyActionContext) =>
      sendBncrReplyAction({
        accountId: normalizeAccountId(ctx?.accountId),
        to: asString(ctx?.to || '').trim(),
        text: asString(ctx?.text || ''),
        replyToMessageId:
          asString(ctx?.replyToId || ctx?.replyToMessageId || '').trim() || undefined,
        sendText: async ({ accountId, to, text }) =>
          getBridge().channelSendText({ accountId, to, text }),
      }),
    deleteAction: async (ctx: BncrOutboundTargetActionContext) =>
      deleteBncrMessageAction({
        accountId: normalizeAccountId(ctx?.accountId),
        targetMessageId: asString(ctx?.messageId || ctx?.targetMessageId || '').trim(),
      }),
    reactAction: async (ctx: BncrOutboundReactActionContext) =>
      reactBncrMessageAction({
        accountId: normalizeAccountId(ctx?.accountId),
        targetMessageId: asString(ctx?.messageId || ctx?.targetMessageId || '').trim(),
        emoji: asString(ctx?.emoji || '').trim(),
      }),
    editAction: async (ctx: BncrOutboundEditActionContext) =>
      editBncrMessageAction({
        accountId: normalizeAccountId(ctx?.accountId),
        targetMessageId: asString(ctx?.messageId || ctx?.targetMessageId || '').trim(),
        text: asString(ctx?.text || ''),
      }),
  };
}
