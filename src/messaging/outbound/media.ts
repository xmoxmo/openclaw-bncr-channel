import { normalizeOutboundReplyToId } from './reply-target-policy.ts';

type BncrOutboundMessageType = 'text' | 'image' | 'video' | 'voice' | 'audio' | 'file';

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

function isBncrOutboundMessageType(value: string): value is BncrOutboundMessageType {
  return (
    value === 'text' ||
    value === 'image' ||
    value === 'video' ||
    value === 'voice' ||
    value === 'audio' ||
    value === 'file'
  );
}

function isMimeMajorOutboundMessageType(
  value: string,
): value is Exclude<BncrOutboundMessageType, 'voice' | 'file'> {
  return value === 'text' || value === 'image' || value === 'video' || value === 'audio';
}

export function resolveBncrOutboundMessageType(params: {
  mimeType?: string;
  fileName?: string;
  hintedType?: string;
  hasPayload?: boolean;
}): BncrOutboundMessageType {
  const hinted = asString(params.hintedType || '').toLowerCase();
  const hasPayload = !!params.hasPayload;
  const mt = asString(params.mimeType || '').toLowerCase();
  const major = mt.split('/')[0] || '';
  const isStandard = isBncrOutboundMessageType(hinted);

  if (hasPayload && major === 'text' && (hinted === 'text' || !isStandard)) return 'file';
  if (hinted === 'voice') return 'voice';
  if (isStandard) return hinted;
  if (isMimeMajorOutboundMessageType(major)) return major;
  return 'file';
}

export function buildBncrMediaOutboundFrame(params: {
  messageId: string;
  sessionKey: string;
  route: { platform: string; groupId: string; userId: string };
  media: {
    mode: 'base64' | 'chunk';
    mimeType?: string;
    fileName?: string;
    base64?: string;
    path?: string;
  };
  mediaUrl: string;
  mediaMsg: string;
  fileName: string;
  hintedType?: string;
  extra?: Record<string, unknown>;
  kind?: 'tool' | 'block' | 'final';
  replyToId?: string;
  now: number;
}) {
  return {
    type: 'message.outbound',
    messageId: params.messageId,
    idempotencyKey: params.messageId,
    sessionKey: params.sessionKey,
    replyToId:
      normalizeOutboundReplyToId({ kind: params.kind, replyToId: params.replyToId }) || undefined,
    message: {
      platform: params.route.platform,
      groupId: params.route.groupId,
      userId: params.route.userId,
      type: resolveBncrOutboundMessageType({
        mimeType: params.media.mimeType,
        fileName: params.media.fileName,
        hasPayload: !!(params.media.path || params.media.base64),
        hintedType: params.hintedType,
      }),
      kind: params.kind,
      mimeType: params.media.mimeType || '',
      msg: params.mediaMsg,
      path: params.media.path || params.mediaUrl,
      base64: params.media.base64 || '',
      fileName: params.fileName,
      transferMode: params.media.mode,
      ...(params.extra ? { ...params.extra } : {}),
    },
    ts: params.now,
  };
}
