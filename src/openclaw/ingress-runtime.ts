import {
  defineStableChannelIngressIdentity as sdkDefineStableChannelIngressIdentity,
  resolveChannelMessageIngress as sdkResolveChannelMessageIngress,
} from 'openclaw/plugin-sdk/channel-ingress-runtime';

export function defineOpenClawStableChannelIngressIdentity(params: {
  key: string;
  kind: string;
  normalize: (value: string) => string | null;
  sensitivity: 'public' | 'private' | 'pii' | string;
  entryIdPrefix?: string;
  aliases?: Array<{
    key: string;
    kind: string;
    normalize: (value: string) => string | null;
    sensitivity: 'public' | 'private' | 'pii' | string;
  }>;
}) {
  return sdkDefineStableChannelIngressIdentity(params as any);
}

export async function resolveOpenClawChannelMessageIngress(params: {
  channelId: string;
  accountId: string;
  identity: unknown;
  subject: unknown;
  conversation: unknown;
  event: unknown;
  policy: unknown;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  accessGroups?: unknown;
}): Promise<any> {
  return sdkResolveChannelMessageIngress(params as any);
}
