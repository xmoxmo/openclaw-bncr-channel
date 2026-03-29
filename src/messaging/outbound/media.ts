function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

function isAudioMimeType(mimeType?: string): boolean {
  const mt = asString(mimeType || '').toLowerCase();
  return mt.startsWith('audio/');
}

export function resolveBncrOutboundMessageType(params: {
  mimeType?: string;
  fileName?: string;
  hintedType?: string;
  hasPayload?: boolean;
}): 'text' | 'image' | 'video' | 'voice' | 'audio' | 'file' {
  const hinted = asString(params.hintedType || '').toLowerCase();
  const hasPayload = !!params.hasPayload;
  const mt = asString(params.mimeType || '').toLowerCase();
  const major = mt.split('/')[0] || '';
  const isStandard =
    hinted === 'text' ||
    hinted === 'image' ||
    hinted === 'video' ||
    hinted === 'voice' ||
    hinted === 'audio' ||
    hinted === 'file';

  if (hasPayload && major === 'text' && (hinted === 'text' || !isStandard)) return 'file';
  if (hinted === 'voice') {
    if (isAudioMimeType(mt)) return 'voice';
    if (major === 'text' || major === 'image' || major === 'video' || major === 'audio')
      return major as any;
    return 'file';
  }
  if (isStandard) return hinted as any;
  if (major === 'text' || major === 'image' || major === 'video' || major === 'audio')
    return major as any;
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
    mediaBase64?: string;
    path?: string;
  };
  mediaUrl: string;
  mediaMsg: string;
  fileName: string;
  hintedType?: string;
  kind?: 'tool' | 'block' | 'final';
  now: number;
}) {
  return {
    type: 'message.outbound',
    messageId: params.messageId,
    idempotencyKey: params.messageId,
    sessionKey: params.sessionKey,
    message: {
      platform: params.route.platform,
      groupId: params.route.groupId,
      userId: params.route.userId,
      type: resolveBncrOutboundMessageType({
        mimeType: params.media.mimeType,
        fileName: params.media.fileName,
        hasPayload: !!(params.media.path || params.media.mediaBase64),
        hintedType: params.hintedType,
      }),
      kind: params.kind,
      mimeType: params.media.mimeType || '',
      msg: params.mediaMsg,
      path: params.media.path || params.mediaUrl,
      base64: params.media.mediaBase64 || '',
      fileName: params.fileName,
      transferMode: params.media.mode,
    },
    ts: params.now,
  };
}
