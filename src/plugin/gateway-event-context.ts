import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { BncrGatewayCapabilityFlags } from '../core/types.ts';

export type BncrGatewayEventContextParams = {
  accountId?: unknown;
  clientId?: unknown;
  outboundReady?: unknown;
  preferredForOutbound?: unknown;
  inboundOnly?: unknown;
};

export type BncrGatewayEventContext = {
  accountId: string;
  connId: string;
  clientId?: string;
  context: GatewayRequestHandlerOptions['context'];
} & BncrGatewayCapabilityFlags;

export function buildBncrGatewayEventContext(args: {
  params: BncrGatewayEventContextParams | null | undefined;
  client: GatewayRequestHandlerOptions['client'];
  context: GatewayRequestHandlerOptions['context'];
  asString: (value: unknown, fallback?: string) => string;
  normalizeAccountId: (value: string) => string;
  now?: () => number;
}): BncrGatewayEventContext {
  const accountId = args.normalizeAccountId(args.asString(args.params?.accountId || ''));
  const connId =
    args.asString(args.client?.connId || '').trim() || `no-conn-${(args.now || Date.now)()}`;
  const clientId = args.asString(args.params?.clientId || '').trim() || undefined;

  return {
    accountId,
    connId,
    clientId,
    context: args.context,
    outboundReady: args.params?.outboundReady === true,
    preferredForOutbound: args.params?.preferredForOutbound === true,
    inboundOnly: args.params?.inboundOnly === true,
  };
}
