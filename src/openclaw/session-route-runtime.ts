import { buildChannelOutboundSessionRoute } from 'openclaw/plugin-sdk/core';

export type OpenClawChannelOutboundSessionRouteParams = Parameters<
  typeof buildChannelOutboundSessionRoute
>[0];

export type OpenClawChannelOutboundSessionRouteResult = ReturnType<
  typeof buildChannelOutboundSessionRoute
>;

export function buildOpenClawChannelOutboundSessionRoute(
  params: OpenClawChannelOutboundSessionRouteParams,
): OpenClawChannelOutboundSessionRouteResult {
  return buildChannelOutboundSessionRoute(params);
}
