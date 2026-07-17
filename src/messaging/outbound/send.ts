import type { BncrRoute } from '../../core/types.ts';

function normalizeReplyKind(value: unknown): 'tool' | 'block' | 'final' | undefined {
  return value === 'tool' || value === 'block' || value === 'final' ? value : undefined;
}

export async function sendBncrText(params: {
  channelId: string;
  extra?: Record<string, unknown>;
  accountId: string;
  to: string;
  text: string;
  kind?: string;
  replyToId?: string;
  mediaLocalRoots?: readonly string[];
  resolveVerifiedTarget: (
    to: string,
    accountId: string,
  ) => { sessionKey: string; route: BncrRoute; displayScope: string };
  rememberSessionRoute: (sessionKey: string, accountId: string, route: BncrRoute) => void;
  enqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      kind?: 'tool' | 'block' | 'final';
      extra?: Record<string, unknown>;
      replyToId?: string;
    };
    mediaLocalRoots?: readonly string[];
  }) => Promise<void>;
  createMessageId: () => string;
}) {
  const verified = params.resolveVerifiedTarget(params.to, params.accountId);
  params.rememberSessionRoute(verified.sessionKey, params.accountId, verified.route);

  await params.enqueueFromReply({
    accountId: params.accountId,
    sessionKey: verified.sessionKey,
    route: verified.route,
    payload: {
      text: params.text,
      kind: normalizeReplyKind(params.kind),
      replyToId: params.replyToId,
      extra: params.extra,
    },
    mediaLocalRoots: params.mediaLocalRoots,
  });

  return {
    channel: params.channelId,
    messageId: params.createMessageId(),
    chatId: verified.sessionKey,
  };
}

export async function sendBncrMedia(params: {
  channelId: string;
  accountId: string;
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  asVoice?: boolean;
  audioAsVoice?: boolean;
  type?: string;
  downloadMedia?: boolean;
  extra?: Record<string, unknown>;
  kind?: string;
  replyToId?: string;
  mediaLocalRoots?: readonly string[];
  resolveVerifiedTarget: (
    to: string,
    accountId: string,
  ) => { sessionKey: string; route: BncrRoute; displayScope: string };
  rememberSessionRoute: (sessionKey: string, accountId: string, route: BncrRoute) => void;
  enqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    payload: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      asVoice?: boolean;
      audioAsVoice?: boolean;
      type?: string;
      downloadMedia?: boolean;
      extra?: Record<string, unknown>;
      kind?: 'tool' | 'block' | 'final';
      replyToId?: string;
    };
    mediaLocalRoots?: readonly string[];
  }) => Promise<void>;
  createMessageId: () => string;
}) {
  const verified = params.resolveVerifiedTarget(params.to, params.accountId);
  params.rememberSessionRoute(verified.sessionKey, params.accountId, verified.route);

  await params.enqueueFromReply({
    accountId: params.accountId,
    sessionKey: verified.sessionKey,
    route: verified.route,
    payload: {
      text: params.text || '',
      mediaUrl: params.mediaUrl || '',
      mediaUrls: params.mediaUrls?.length ? params.mediaUrls : undefined,
      asVoice: params.asVoice === true ? true : undefined,
      audioAsVoice: params.audioAsVoice === true ? true : undefined,
      downloadMedia: params.downloadMedia === true ? true : undefined,
      type: params.type,
      extra: params.extra,
      kind: normalizeReplyKind(params.kind),
      replyToId: params.replyToId,
    },
    mediaLocalRoots: params.mediaLocalRoots,
  });

  return {
    channel: params.channelId,
    messageId: params.createMessageId(),
    chatId: verified.sessionKey,
  };
}
