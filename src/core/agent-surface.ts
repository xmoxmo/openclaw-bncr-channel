/**
 * Which agents this host actually serves.
 *
 * The plugin keeps a hard-coded preference for `public` (unbound traffic and
 * non-admin direct chats land there), but a host is free not to configure that
 * agent. Every decision that used to assume `public` exists goes through this
 * module so the assumption lives in one place.
 */
import type { BncrChannelConfigRoot } from '../plugin/channel-runtime-types.ts';

/** The agent the plugin prefers for unbound and non-admin traffic. */
export const PUBLIC_AGENT_ID = 'public';

/**
 * OpenClaw's implicit default agent. A fresh host has no `agents.entries` entry
 * for it — the host serves that id by convention — so this is the documented
 * last resort when no binding names an agent, not a guess about a specific
 * setup. Kept here so the name lives in one place instead of four literals.
 */
export const HOST_DEFAULT_AGENT_ID = 'main';

function normalizeAgentId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Agent ids declared under `agents.entries`.
 *
 * An empty result means "cannot tell", which callers must not read as "the host
 * has no agents" — a config without an `agents` section still serves the
 * implicit default agent.
 */
export function listConfiguredAgentIds(cfg: BncrChannelConfigRoot | undefined): string[] {
  const entries = (cfg as { agents?: { entries?: unknown } } | undefined)?.agents?.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return [];
  return Object.keys(entries as Record<string, unknown>)
    .map(normalizeAgentId)
    .filter(Boolean);
}

export function hasConfiguredAgent(
  cfg: BncrChannelConfigRoot | undefined,
  agentId: string,
): boolean {
  const wanted = normalizeAgentId(agentId);
  if (!wanted) return false;
  return listConfiguredAgentIds(cfg).some((id) => normalizeAgentId(id) === wanted);
}

/**
 * `public` when the host serves it, otherwise the agent already handling this
 * conversation. Without the fallback the plugin would hand messages to a scene
 * row no agent owns, and the chat would look admitted but stay silent.
 */
export function resolvePublicFallbackAgent(
  cfg: BncrChannelConfigRoot | undefined,
  fallbackAgentId: string,
): string {
  if (hasConfiguredAgent(cfg, PUBLIC_AGENT_ID)) return PUBLIC_AGENT_ID;
  return normalizeAgentId(fallbackAgentId);
}

/**
 * One line telling the operator that `public` is absent and how to add it.
 *
 * Returns null when the host serves `public` or when the agent list cannot be
 * read at all: a config without an `agents` section still runs an implicit
 * default agent, and warning there would be noise about a working setup.
 */
export function describeMissingPublicAgent(cfg: BncrChannelConfigRoot | undefined): string | null {
  return describeMissingPublicAgentFromIds(listConfiguredAgentIds(cfg));
}

/** Same wording, for callers that already hold the declared agent ids. */
export function describeMissingPublicAgentFromIds(
  agentIds: ReadonlySet<string> | readonly string[],
): string | null {
  const ids = Array.from(agentIds as Iterable<string>)
    .map(normalizeAgentId)
    .filter(Boolean);
  if (ids.length === 0) return null;
  if (ids.includes(PUBLIC_AGENT_ID)) return null;
  return (
    `agent ${PUBLIC_AGENT_ID} is not configured on this host; unbound routes and non-admin direct chats stay on the agent already serving them. ` +
    `Admin can send \`oc config\` to view the recommended default config, or \`oc autoconfig\` to have the agent apply it.`
  );
}
