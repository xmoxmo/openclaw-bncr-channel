import { buildChannelOutboundSessionRoute } from 'openclaw/plugin-sdk/core';

export function buildOpenClawChannelOutboundSessionRoute(params: {
  cfg: any;
  agentId: string;
  channel: string;
  accountId?: string;
  peer: unknown;
  chatType: 'direct' | 'group';
  from: string;
  to: string;
  threadId?: string;
}): Record<string, unknown> {
  return buildChannelOutboundSessionRoute(params as any) as Record<string, unknown>;
}
