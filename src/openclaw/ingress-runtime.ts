import {
  defineStableChannelIngressIdentity as sdkDefineStableChannelIngressIdentity,
  resolveChannelMessageIngress as sdkResolveChannelMessageIngress,
} from 'openclaw/plugin-sdk/channel-ingress-runtime';

type StableChannelIngressIdentityParams = Parameters<
  typeof sdkDefineStableChannelIngressIdentity
>[0];

type ResolveChannelMessageIngressParams = Parameters<typeof sdkResolveChannelMessageIngress>[0];
type ResolveChannelMessageIngressResult = Awaited<
  ReturnType<typeof sdkResolveChannelMessageIngress>
>;

export function defineOpenClawStableChannelIngressIdentity(
  params: StableChannelIngressIdentityParams,
) {
  return sdkDefineStableChannelIngressIdentity(params);
}

export async function resolveOpenClawChannelMessageIngress(
  params: ResolveChannelMessageIngressParams,
): Promise<ResolveChannelMessageIngressResult> {
  return sdkResolveChannelMessageIngress(params);
}
