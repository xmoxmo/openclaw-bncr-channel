export type OpenClawChannelRuntimeSurfaceDiagnostics = {
  channel: {
    inbound: boolean;
    media: boolean;
    reply: boolean;
    routing: boolean;
    session: boolean;
  };
  missing: string[];
};

export function buildOpenClawChannelRuntimeSurfaceDiagnostics(
  api: unknown,
): OpenClawChannelRuntimeSurfaceDiagnostics {
  const channelRuntime = (api as any)?.runtime?.channel;
  const surfaces = {
    inbound: Boolean(channelRuntime?.inbound),
    media: Boolean(channelRuntime?.media),
    reply: Boolean(channelRuntime?.reply),
    routing: Boolean(channelRuntime?.routing),
    session: Boolean(channelRuntime?.session),
  };
  return {
    channel: surfaces,
    missing: Object.entries(surfaces)
      .filter(([, present]) => !present)
      .map(([name]) => name),
  };
}
