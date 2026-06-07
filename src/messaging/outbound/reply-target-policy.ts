import { normalizeReplyToId } from './media-dedupe.ts';

export type OutboundReplyKind = 'tool' | 'block' | 'final';
export type OutboundReplyTargetPolicy = 'agent-default' | 'preserve';

const STRIP_TOOL_REPLY_TO_ID = true;

export function normalizeOutboundReplyToId(params: {
  kind?: OutboundReplyKind;
  replyToId?: string | null;
  replyTargetPolicy?: OutboundReplyTargetPolicy;
}) {
  if (params.kind === 'tool' && STRIP_TOOL_REPLY_TO_ID && params.replyTargetPolicy !== 'preserve')
    return '';
  return normalizeReplyToId(params.replyToId);
}
