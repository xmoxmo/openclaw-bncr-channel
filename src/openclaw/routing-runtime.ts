import { buildChannelOutboundSessionRoute } from 'openclaw/plugin-sdk/core';
import { resolveInboundLastRouteSessionKey } from 'openclaw/plugin-sdk/routing';
import type { BncrChannelConfigRoot } from '../plugin/channel-runtime-types.ts';
import type {
  OpenClawChannelRuntimeApiHolder,
  OpenClawResolvedAgentRoute,
} from './channel-runtime-contracts.ts';

export type { OpenClawResolvedAgentRoute } from './channel-runtime-contracts.ts';

type OpenClawRoutingApi = {
  resolveAgentRoute?: (params: {
    cfg: BncrChannelConfigRoot;
    channel: string;
    accountId: string;
    peer: unknown;
  }) => OpenClawResolvedAgentRoute;
};

type BuildChannelOutboundSessionRouteParams = Parameters<
  typeof buildChannelOutboundSessionRoute
>[0];

function resolveRoutingApi(api: OpenClawChannelRuntimeApiHolder): OpenClawRoutingApi {
  const routing = api?.runtime?.channel?.routing;
  if (!routing || typeof routing !== 'object') {
    throw new Error('OpenClaw channel routing API is unavailable');
  }
  return routing as OpenClawRoutingApi;
}

export function resolveOpenClawAgentRoute(
  api: OpenClawChannelRuntimeApiHolder,
  params: {
    cfg: BncrChannelConfigRoot;
    channel: string;
    accountId: string;
    peer: unknown;
  },
): OpenClawResolvedAgentRoute {
  const routing = resolveRoutingApi(api);
  if (typeof routing.resolveAgentRoute !== 'function') {
    throw new Error('OpenClaw channel routing resolveAgentRoute API is unavailable');
  }
  return routing.resolveAgentRoute(params);
}

export function resolveOpenClawInboundLastRouteSessionKey(params: {
  route: { lastRoutePolicy?: 'main' | 'session'; mainSessionKey: string };
  sessionKey: string;
}): string {
  return resolveInboundLastRouteSessionKey(
    params as {
      route: { lastRoutePolicy: 'main' | 'session'; mainSessionKey: string };
      sessionKey: string;
    },
  );
}

export function buildOpenClawChannelOutboundSessionRoute(
  params: BuildChannelOutboundSessionRouteParams,
) {
  return buildChannelOutboundSessionRoute(params);
}
