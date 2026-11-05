import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import type { BncrChannelConfigRoot } from '../plugin/channel-runtime-types.ts';

type RuntimeAgentWorkspaceApi = Pick<OpenClawPluginApi, 'runtime'>;

/** Resolve the exact workspace through the host-owned agent runtime. */
export function resolveOpenClawAgentWorkspaceDir(
  api: RuntimeAgentWorkspaceApi,
  cfg: BncrChannelConfigRoot,
  agentId: string,
): string {
  const resolveWorkspaceDir = api?.runtime?.agent?.resolveAgentWorkspaceDir;
  if (typeof resolveWorkspaceDir !== 'function') {
    throw new Error('OpenClaw agent resolveAgentWorkspaceDir API is unavailable');
  }
  return resolveWorkspaceDir(cfg, agentId);
}
