/**
 * Channel-owned metadata for host plugin hooks (`ctx.channelContext`).
 *
 * This surface is read by plugins such as people and never rendered into the
 * prompt. It is additive: `bncr.inbound_context` and
 * `BncrStructuredContextFacts` keep their existing shape and names.
 *
 * Field contract:
 * - chat.id        transport conversation id, same value as `conversation.id`
 * - chat.platform  full identity space, `bncr/<backend>` (people reads this)
 * - chat.kind      `group` | `direct`
 * - chat.title     group subject, group chats only
 * - sender.id      same value as host `ctx.senderId`
 * - sender.name    display name (`displayName` stays in structured facts)
 * - sender.userId  platform user id when known
 * - sender.username platform username when known
 *
 * Channel, backend, chat id and sender id are required. If any is unavailable,
 * the hook surface is omitted and consumers fall back to their previous
 * sessionKey derivation.
 */
export type BncrHookChannelContext = {
  chat: {
    id: string;
    platform: string;
    kind: 'group' | 'direct';
    title?: string;
  };
  sender: {
    id: string;
    name?: string;
    userId?: string;
    username?: string;
  };
};

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function buildBncrHookChannelContext(args: {
  channelId: string;
  platform?: string;
  peer: { kind: 'direct' | 'group'; id: string };
  groupName?: string;
  senderId: string;
  senderName?: string;
  userId?: string;
  userName?: string;
}): BncrHookChannelContext | undefined {
  const channel = trimmed(args.channelId);
  const backend = trimmed(args.platform);
  const chatId = trimmed(args.peer?.id);
  const senderId = trimmed(args.senderId);
  if (!channel || !backend || !chatId || !senderId) return undefined;

  const title = args.peer.kind === 'group' ? trimmed(args.groupName) : undefined;
  const name = trimmed(args.senderName);
  const userId = trimmed(args.userId);
  const username = trimmed(args.userName);

  return {
    chat: {
      id: chatId,
      platform: `${channel}/${backend}`,
      kind: args.peer.kind,
      ...(title ? { title } : {}),
    },
    sender: {
      id: senderId,
      ...(name ? { name } : {}),
      ...(userId ? { userId } : {}),
      ...(username ? { username } : {}),
    },
  };
}
