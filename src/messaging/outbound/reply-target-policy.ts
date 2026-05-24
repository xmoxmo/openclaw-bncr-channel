import { normalizeReplyToId } from './media-dedupe.ts';

export type OutboundReplyKind = 'tool' | 'block' | 'final';

const STRIP_TOOL_REPLY_TO_ID = true;

export function normalizeOutboundReplyToId(params: {
  kind?: OutboundReplyKind;
  replyToId?: string | null;
}) {
  if (params.kind === 'tool' && STRIP_TOOL_REPLY_TO_ID) return '';
  return normalizeReplyToId(params.replyToId);
}
