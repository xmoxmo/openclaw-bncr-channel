import { resolveInboundLastRouteSessionKey } from 'openclaw/plugin-sdk/routing';

type RuntimeRoutingApi = {
  resolveAgentRoute?: (params: {
    cfg: any;
    channel: string;
    accountId: string;
    peer: unknown;
  }) => any;
};

type RuntimeApiHolder = {
  runtime?: {
    channel?: {
      routing?: RuntimeRoutingApi;
    };
  };
};

function resolveRoutingApi(api: RuntimeApiHolder): RuntimeRoutingApi {
  const routing = api?.runtime?.channel?.routing;
  if (!routing) throw new Error('OpenClaw channel routing API is unavailable');
  return routing;
}

export function resolveOpenClawAgentRoute(
  api: RuntimeApiHolder,
  params: {
    cfg: any;
    channel: string;
    accountId: string;
    peer: unknown;
  },
): any {
  const routing = resolveRoutingApi(api);
  if (typeof routing.resolveAgentRoute !== 'function') {
    throw new Error('OpenClaw channel routing resolveAgentRoute API is unavailable');
  }
  return routing.resolveAgentRoute(params);
}

export function resolveOpenClawInboundLastRouteSessionKey(params: {
  route: unknown;
  sessionKey: string;
}): string {
  return resolveInboundLastRouteSessionKey(params as any);
}

