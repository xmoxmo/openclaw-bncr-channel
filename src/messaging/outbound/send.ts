export async function sendBncrText(params: {
  channelId: string;
  accountId: string;
  to: string;
  text: string;
  mediaLocalRoots?: readonly string[];
  resolveVerifiedTarget: (
    to: string,
    accountId: string,
  ) => { sessionKey: string; route: any; displayScope: string };
  rememberSessionRoute: (sessionKey: string, accountId: string, route: any) => void;
  enqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: any;
    payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
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
  asVoice?: boolean;
  audioAsVoice?: boolean;
  mediaLocalRoots?: readonly string[];
  resolveVerifiedTarget: (
    to: string,
    accountId: string,
  ) => { sessionKey: string; route: any; displayScope: string };
  rememberSessionRoute: (sessionKey: string, accountId: string, route: any) => void;
  enqueueFromReply: (args: {
    accountId: string;
    sessionKey: string;
    route: any;
    payload: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      asVoice?: boolean;
      audioAsVoice?: boolean;
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
      asVoice: params.asVoice === true ? true : undefined,
      audioAsVoice: params.audioAsVoice === true ? true : undefined,
    },
    mediaLocalRoots: params.mediaLocalRoots,
  });

  return {
    channel: params.channelId,
    messageId: params.createMessageId(),
    chatId: verified.sessionKey,
  };
}
