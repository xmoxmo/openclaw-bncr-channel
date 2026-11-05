import type { BncrSceneRecord } from '../../plugin/channel-runtime-types.ts';
import { ADMIN_REQUIRED_TEXT } from './command-constants.ts';

function normalizeAgentId(value: unknown): string {
  return String(value ?? '').trim();
}

export type BncrSceneAgentScopeResult =
  | {
      ok: true;
      /** Exact rows the command may read or mutate. */
      targets: BncrSceneRecord[];
    }
  | { ok: false; text: string };

/**
 * Resolve one scene's agent rows for a command.
 *
 * Administrators retain the documented fan-out when agentId is omitted. A
 * non-admin caller is always pinned to the agent serving the current request;
 * omitting agentId must never widen that scope. Missing caller identity fails
 * closed before a caller can touch a registry row.
 */
export function resolveBncrSceneAgentScope(args: {
  rows: readonly BncrSceneRecord[];
  isAdmin: boolean;
  requestedAgentId?: string | null;
  callerAgentId?: string | null;
  allowLegacyUnowned?: boolean;
}): BncrSceneAgentScopeResult {
  const rows = Array.from(args.rows);
  const requestedAgentId = normalizeAgentId(args.requestedAgentId);
  const callerAgentId = normalizeAgentId(args.callerAgentId);

  if (args.isAdmin) {
    return {
      ok: true,
      targets: requestedAgentId
        ? rows.filter((row) => normalizeAgentId(row.agentId) === requestedAgentId)
        : rows,
    };
  }

  if (!callerAgentId) return { ok: false, text: ADMIN_REQUIRED_TEXT };
  if (requestedAgentId && requestedAgentId !== callerAgentId) {
    return { ok: false, text: ADMIN_REQUIRED_TEXT };
  }

  const ownRows = rows.filter((row) => normalizeAgentId(row.agentId) === callerAgentId);
  if (ownRows.length > 0) {
    return {
      ok: true,
      targets: ownRows,
    };
  }

  const legacyRows =
    args.allowLegacyUnowned === false ? [] : rows.filter((row) => !normalizeAgentId(row.agentId));
  if (legacyRows.length === 0) return { ok: false, text: ADMIN_REQUIRED_TEXT };
  return {
    ok: true,
    targets: legacyRows,
  };
}
