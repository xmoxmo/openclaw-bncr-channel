import { resolveOpenClawInboundLastRouteSessionKey } from '../../openclaw/routing-runtime.ts';

export function buildBncrInboundRecordUpdateLastRoute(args: {
  channelId: string;
  peerKind: 'direct' | 'group';
  senderIdForContext: string;
  accountId: string;
  to: string;
  resolvedRoute: {
    sessionKey: string;
    mainSessionKey?: string;
  };
  sessionKey: string;
  pinnedMainDmOwner: string | null;
}) {
  const {
    channelId,
    peerKind,
    senderIdForContext,
    accountId,
    to,
    resolvedRoute,
    sessionKey,
    pinnedMainDmOwner,
  } = args;
  if (peerKind !== 'direct') return undefined;

  const inboundLastRouteSessionKey = resolveOpenClawInboundLastRouteSessionKey({
    route: resolvedRoute,
    sessionKey,
  });

  return {
    sessionKey: inboundLastRouteSessionKey,
    channel: channelId,
    to,
    accountId,
    mainDmOwnerPin:
      inboundLastRouteSessionKey === resolvedRoute.mainSessionKey && pinnedMainDmOwner
        ? {
            ownerRecipient: pinnedMainDmOwner,
            senderRecipient: senderIdForContext,
          }
        : undefined,
  };
}
