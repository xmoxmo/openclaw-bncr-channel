type BncrNativeReplyKind = 'tool' | 'block' | 'final';

export type BncrNativeReplyDeliveryPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  replyToId?: string;
};

export function buildBncrNativeReplyDeliveryPayload(args: {
  payload?: {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
  };
  kind?: BncrNativeReplyKind;
  effectiveReply: {
    blockStreaming: boolean;
    allowTool: boolean;
  };
  msgId?: string;
}): BncrNativeReplyDeliveryPayload | null {
  const { payload, kind, effectiveReply, msgId } = args;
  const shouldForwardTool = effectiveReply.blockStreaming && effectiveReply.allowTool;

  if (kind === 'tool' && !shouldForwardTool) {
    return null;
  }

  const hasPayload = Boolean(
    payload?.text ||
      payload?.mediaUrl ||
      (Array.isArray(payload?.mediaUrls) && payload.mediaUrls.length > 0),
  );
  if (!hasPayload) return null;

  return {
    ...payload,
    replyToId: msgId || undefined,
  };
}
