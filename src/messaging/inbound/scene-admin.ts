import type {
  BncrGroupReplyMode,
  BncrSceneRecord,
  BncrSceneStatus,
} from '../../plugin/channel-runtime-types.ts';
import {
  deleteSceneRecord,
  resolveEffectiveSceneStatus,
  resolveSceneRecord,
  setSceneRecord,
} from '../../plugin/scene-registry.ts';
import { ADMIN_REQUIRED_TEXT } from './command-constants.ts';
import { resolveBncrHistoryLimit } from './conversation-history.ts';
import type { ParsedInbound } from './dispatch-prep.ts';
import type { NativeCommand } from './native-command.ts';
import { parseBncrSceneTargets } from './session-identity.ts';

export type BncrSceneAdminCommand =
  | { kind: 'allow'; sceneKey?: string; agentId?: string }
  | { kind: 'deny'; sceneKey?: string; agentId?: string }
  | { kind: 'revoke'; sceneKey?: string; agentId?: string }
  | { kind: 'bind'; sceneKey?: string; agentId: string }
  | { kind: 'mode-help' }
  | { kind: 'mode-get'; sceneKey?: string; agentId?: string }
  | { kind: 'mode'; sceneKey?: string; agentId?: string; mode: string }
  | { kind: 'list'; scope: 'pending' | 'scenes'; filters?: string[] }
  | { kind: 'history-limit-get'; sceneKey?: string; agentId?: string }
  | { kind: 'history-limit-set'; sceneKey: string; limit: number | 'clear'; agentId?: string }
  | { kind: 'history-force-get'; sceneKey?: string; agentId?: string }
  | {
      kind: 'history-force-set';
      sceneKey: string;
      enabled: boolean | 'clear';
      agentId?: string;
    }
  | { kind: 'history-help' }
  | { kind: 'download-media-get'; sceneKey?: string; agentId?: string }
  | {
      kind: 'download-media-set';
      sceneKey: string;
      enabled: boolean | undefined;
      agentId?: string;
    }
  | { kind: 'download-media-global-get' }
  | { kind: 'download-media-global-set'; enabled: boolean };

const GROUP_REPLY_MODES = new Set<BncrGroupReplyMode>(['admin', 'mention', 'hybrid', 'all']);

const MODE_USAGE_TEXT =
  'Usage: /bncr mode [<agentId>] [<SceneId>] | /bncr mode <admin|mention|hybrid|all|clear> [<agentId>] [<SceneId>]';

const HISTORY_LIMIT_USAGE_TEXT =
  'Usage: /bncr history-limit [<number>|clear] [<agentId>] [<SceneId>]';

const HISTORY_FORCE_USAGE_TEXT =
  'Usage: /bncr history-force [on|off|clear] [<agentId>] [<SceneId>]';

const DOWNLOAD_MEDIA_USAGE_TEXT =
  'Usage: /bncr download-media [on|off|clear] [<agentId>] [<SceneId>]';

const GLOBAL_SCENE_KEY = '__global__';

const MODE_HELP_TEXT = [
  '💬 Bncr Group Reply Mode Configuration',
  '',
  'Modes:',
  '  • default: admin',
  '  • admin: 仅管理员|消息上送并逐条回复',
  '  • mention: 全员|消息上送 仅指定消息触发回复',
  '  • hybrid: 全员|消息上送 管理员逐条回复 其他人仅指定消息触发回复',
  '  • all: 全员|消息上送并逐条回复',
  '',
  'Specified messages include:',
  '  • @bot',
  '  • reply to bot',
  '  • platform-marked should-respond messages',
  '',
  'Usage:',
  '  • /bncr mode [<agentId>] [<SceneId>]',
  '    Show the mode; every agent row is listed when they differ',
  '  • /bncr mode <admin|mention|hybrid|all|clear> [<agentId>] [<SceneId>]',
  '    Without <agentId> the change applies to every agent watching the scene',
].join('\n');

export const HISTORY_HELP_TEXT = [
  '📋 Bncr Conversation History Configuration',
  '',
  'Commands:',
  '  • /bncr history-limit [<number>|clear] [<agentId>] [<SceneId>]',
  '    Set history limit (default: 50, minimum: 2)',
  '  • /bncr history-force on|off|clear [<agentId>] [<SceneId>]',
  '    When on, overflow triggers auto context at limit (default: on)',
  '    When off, oldest messages trim silently without context',
].join('\n');

export type ParsedSceneAdminCommand =
  | { matched: false }
  | { matched: true; valid: false; text: string }
  | { matched: true; valid: true; command: BncrSceneAdminCommand };

function normalizeToken(value: string): string {
  return String(value || '').trim();
}

function splitArgs(raw: string): string[] {
  return normalizeToken(raw)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Every registry row that belongs to one scene, one row per watching agent. */
function listSceneRows(
  registry: Map<string, BncrSceneRecord>,
  sceneKey: string,
): BncrSceneRecord[] {
  const key = normalizeToken(sceneKey);
  if (!key) return [];
  return Array.from(registry.values()).filter((row) => normalizeToken(row.sceneKey) === key);
}

/**
 * One message for every "that agent is not on this scene" case, so the same
 * mistake reads identically in mode, approval, history and media commands.
 * Listing the agents that do have rows turns a typo into an obvious one.
 */
export function unknownAgentText(
  wanted: string,
  sceneKey: string,
  rows: ReadonlyArray<BncrSceneRecord>,
): string {
  const agents = Array.from(
    new Set(rows.map((row) => normalizeToken(row.agentId ?? '')).filter(Boolean)),
  ).sort();
  const known = agents.length > 0 ? ` Agents here: ${agents.join(', ')}.` : '';
  return `Agent ${wanted} has no scene row for ${sceneKey}.${known}`;
}

/** One line per agent, used whenever a scene's rows disagree. */
function formatPerAgent(
  title: string,
  rows: BncrSceneRecord[],
  render: (row: BncrSceneRecord) => string,
): string {
  const lines = [title];
  for (const row of rows) {
    lines.push(`  ${normalizeToken(row.agentId || '') || '(unassigned)'}: ${render(row)}`);
  }
  return lines.join('\n');
}

function normalizeFilters(args: string[]): string[] | undefined {
  const filters = args.map((part) => normalizeToken(part).toLowerCase()).filter(Boolean);
  return filters.length > 0 ? filters : undefined;
}

function resolveCurrentGroupSceneKey(parsed: ParsedInbound): string | null {
  if (parsed.peer.kind !== 'group') return null;
  const platform = normalizeToken(parsed.platform);
  const groupId = normalizeToken(parsed.groupId);
  if (!platform || !groupId || groupId === '0') return null;
  return `${platform}:${groupId}`;
}

function resolveCurrentSceneKey(parsed: ParsedInbound): string | null {
  const platform = normalizeToken(parsed.platform);
  if (!platform) return null;
  if (parsed.peer.kind === 'group') {
    const groupId = normalizeToken(parsed.groupId);
    if (!groupId || groupId === '0') return null;
    return `${platform}:${groupId}`;
  }
  if (parsed.peer.kind === 'direct') {
    const userId = normalizeToken(parsed.userId);
    if (!userId || userId === '0') return null;
    return `${platform}:${userId}`;
  }
  return null;
}

export function parseSceneAdminCommand(command: NativeCommand): ParsedSceneAdminCommand {
  const args = splitArgs(command.argsText);
  switch (command.command) {
    case 'allow':
    case 'deny': {
      // Approval takes the same [<agentId>] [<SceneId>] tail as every other
      // scene setting, so one chat served by two agents is admitted at once.
      const targets = parseBncrSceneTargets(args);
      if (!targets) {
        return {
          matched: true,
          valid: false,
          text: `Usage: /bncr ${command.command} [<agentId>] [<SceneId>]`,
        };
      }
      return { matched: true, valid: true, command: { kind: command.command, ...targets } };
    }
    case 'revoke': {
      // Revoking deletes a row, so the agent has to be nameable. A scene served
      // by one agent can stay shorthand; a shared scene must say which one.
      const targets = parseBncrSceneTargets(args);
      if (!targets) {
        return {
          matched: true,
          valid: false,
          text: 'Usage: /bncr revoke [<agentId>] [<SceneId>]',
        };
      }
      return { matched: true, valid: true, command: { kind: 'revoke', ...targets } };
    }
    case 'bind':
      if (args.length === 1) {
        return {
          matched: true,
          valid: true,
          command: { kind: 'bind', agentId: args[0] },
        };
      }
      if (args.length === 2) {
        return {
          matched: true,
          valid: true,
          command: { kind: 'bind', agentId: args[0], sceneKey: args[1] },
        };
      }
      return {
        matched: true,
        valid: false,
        text: 'Usage: /bncr bind <agentId> [<sceneKey>]',
      };
    case 'mode':
      if (args.length === 0) {
        return { matched: true, valid: true, command: { kind: 'mode-get' } };
      }
      if (args[0] === 'help') {
        return args.length === 1
          ? { matched: true, valid: true, command: { kind: 'mode-help' } }
          : { matched: true, valid: false, text: MODE_USAGE_TEXT };
      }
      {
        const head = args[0].toLowerCase();
        const modeWord =
          head === 'clear'
            ? 'clear'
            : GROUP_REPLY_MODES.has(head as BncrGroupReplyMode)
              ? head
              : null;
        const targets = modeWord ? args.slice(1) : args;
        const targetFields = parseBncrSceneTargets(targets);
        if (!targetFields) {
          return { matched: true, valid: false, text: MODE_USAGE_TEXT };
        }
        if (!modeWord) {
          return { matched: true, valid: true, command: { kind: 'mode-get', ...targetFields } };
        }
        return {
          matched: true,
          valid: true,
          command: { kind: 'mode', mode: modeWord, ...targetFields },
        };
      }
    case 'list':
      if (args[0] === 'pending') {
        const filters = normalizeFilters(args.slice(1));
        return {
          matched: true,
          valid: true,
          command: { kind: 'list', scope: 'pending', ...(filters ? { filters } : {}) },
        };
      }
      if (args[0] === 'scenes') {
        const filters = normalizeFilters(args.slice(1));
        return {
          matched: true,
          valid: true,
          command: { kind: 'list', scope: 'scenes', ...(filters ? { filters } : {}) },
        };
      }
      return {
        matched: true,
        valid: false,
        text: 'Usage: /bncr list <pending|scenes> [filters...]',
      };
    case 'history-limit': {
      if (args.length === 0) {
        return { matched: true, valid: true, command: { kind: 'history-limit-get' } };
      }
      const head = args[0].toLowerCase();
      const isClear = head === 'clear';
      const num = isClear ? Number.NaN : parseInt(head, 10);
      const isNumber = !isClear && Number.isFinite(num);
      if (!isClear && !isNumber) {
        const readTargets = parseBncrSceneTargets(args);
        if (!readTargets) {
          return { matched: true, valid: false, text: HISTORY_LIMIT_USAGE_TEXT };
        }
        return {
          matched: true,
          valid: true,
          command: { kind: 'history-limit-get', ...readTargets },
        };
      }
      const targets = parseBncrSceneTargets(args.slice(1));
      if (!targets) {
        return { matched: true, valid: false, text: HISTORY_LIMIT_USAGE_TEXT };
      }
      return {
        matched: true,
        valid: true,
        command: {
          kind: 'history-limit-set',
          sceneKey: targets.sceneKey || '',
          limit: isClear ? 'clear' : num,
          ...(targets.agentId ? { agentId: targets.agentId } : {}),
        },
      };
    }
    case 'history-force': {
      if (args.length === 0) {
        return { matched: true, valid: true, command: { kind: 'history-force-get' } };
      }
      const head = args[0].toLowerCase();
      if (head !== 'clear' && head !== 'on' && head !== 'off') {
        const readTargets = parseBncrSceneTargets(args);
        if (!readTargets) {
          return { matched: true, valid: false, text: HISTORY_FORCE_USAGE_TEXT };
        }
        return {
          matched: true,
          valid: true,
          command: { kind: 'history-force-get', ...readTargets },
        };
      }
      const targets = parseBncrSceneTargets(args.slice(1));
      if (!targets) {
        return { matched: true, valid: false, text: HISTORY_FORCE_USAGE_TEXT };
      }
      return {
        matched: true,
        valid: true,
        command: {
          kind: 'history-force-set',
          sceneKey: targets.sceneKey || '',
          enabled: head === 'clear' ? 'clear' : head === 'on',
          ...(targets.agentId ? { agentId: targets.agentId } : {}),
        },
      };
    }
    case 'download-media': {
      if (args.length === 0) {
        return { matched: true, valid: true, command: { kind: 'download-media-get' } };
      }
      const head = args[0].toLowerCase();
      if (head === 'default') {
        if (args[1] === 'on' || args[1] === 'off') {
          return {
            matched: true,
            valid: true,
            command: { kind: 'download-media-global-set', enabled: args[1] === 'on' },
          };
        }
        return { matched: true, valid: true, command: { kind: 'download-media-global-get' } };
      }
      if (head !== 'clear' && head !== 'on' && head !== 'off') {
        const readTargets = parseBncrSceneTargets(args);
        if (!readTargets) {
          return { matched: true, valid: false, text: DOWNLOAD_MEDIA_USAGE_TEXT };
        }
        return {
          matched: true,
          valid: true,
          command: { kind: 'download-media-get', ...readTargets },
        };
      }
      const targets = parseBncrSceneTargets(args.slice(1));
      if (!targets) {
        return { matched: true, valid: false, text: DOWNLOAD_MEDIA_USAGE_TEXT };
      }
      return {
        matched: true,
        valid: true,
        command: {
          kind: 'download-media-set',
          sceneKey: targets.sceneKey || '',
          enabled: head === 'clear' ? undefined : head === 'on',
          ...(targets.agentId ? { agentId: targets.agentId } : {}),
        },
      };
    }
    case 'history-help':
      return { matched: true, valid: true, command: { kind: 'history-help' } };
    default:
      return { matched: false };
  }
}

function formatSceneDetailsLine(scene: BncrSceneRecord): string {
  const idPart =
    scene.kind === 'group' ? scene.groupId || scene.sceneKey : scene.userId || scene.sceneKey;
  const namePart = scene.kind === 'group' ? scene.groupName || '' : scene.userName || '';
  const labelPart = namePart ? ` name=${namePart}` : '';
  const historyLimitVal = resolveBncrHistoryLimit(scene.historyLimit);
  const historyForceVal = scene.historyForce;
  const hasNonDefaultHistory = historyLimitVal !== 50 || historyForceVal === false;
  const historyPart = hasNonDefaultHistory
    ? ` historyLimit=${historyLimitVal} autoFlush=${historyForceVal !== false ? 'on' : 'off'}`
    : '';
  const effective = resolveEffectiveSceneStatus(scene);
  // Keep the stored value visible when it disagrees with what the gate does, so
  // the operator can tell an unapproved legacy row from one that never existed.
  const statusPart =
    effective === scene.status ? effective : `${effective} (stored ${scene.status})`;
  return `  Details: status=${statusPart} id=${idPart}${labelPart}${historyPart}`;
}

function formatSceneEntry(scene: BncrSceneRecord): string {
  return [`  SceneId: ${scene.sceneKey}`, formatSceneDetailsLine(scene)].join('\n');
}

function buildSceneGroupTitle(scene: BncrSceneRecord): string {
  const agentId = normalizeToken(scene.agentId || '') || 'public';
  if (scene.kind === 'group') {
    const mode = normalizeToken(scene.groupReplyMode || '') || 'admin';
    return `👥 Group Chat ${agentId} ${mode}`;
  }
  return `📱 Private Chat ${agentId}`;
}

function formatSceneGroups(scenes: BncrSceneRecord[]): string {
  const directGrouped = new Map<string, string[]>();
  const groupGrouped = new Map<string, string[]>();
  for (const scene of scenes) {
    const title = buildSceneGroupTitle(scene);
    const target = scene.kind === 'group' ? groupGrouped : directGrouped;
    const current = target.get(title) || [];
    current.push(formatSceneEntry(scene));
    target.set(title, current);
  }

  const orderedGroups = [
    ...Array.from(directGrouped.entries()),
    ...Array.from(groupGrouped.entries()).sort(([left], [right]) => left.localeCompare(right)),
  ];

  return orderedGroups
    .map(([title, entries]) => [title, '', entries.join('\n\n')].join('\n'))
    .join('\n\n');
}

function buildSceneSearchHaystack(scene: BncrSceneRecord): string[] {
  const parts: string[] = [
    normalizeToken(scene.sceneKey),
    normalizeToken(scene.platform),
    // Both statuses are searchable: the effective one is what the operator
    // sees, the stored one is what they may have read in an older listing.
    normalizeToken(resolveEffectiveSceneStatus(scene)),
    normalizeToken(scene.status),
    normalizeToken(scene.agentId ?? ''),
    normalizeToken(scene.kind),
    normalizeToken(scene.userId ?? ''),
    normalizeToken(scene.userName ?? ''),
    normalizeToken(scene.groupId ?? ''),
    normalizeToken(scene.groupName ?? ''),
  ];
  if (scene.kind === 'group') {
    parts.push(scene.groupReplyMode || 'admin');
  }
  return parts.map((part) => part.toLowerCase()).filter(Boolean);
}

function matchesSceneFilters(scene: BncrSceneRecord, filters: string[] | undefined): boolean {
  if (!filters?.length) return true;
  const haystack = buildSceneSearchHaystack(scene);
  return filters.every((filter) => haystack.some((part) => part.includes(filter)));
}

function applySceneStatus(scene: BncrSceneRecord, status: BncrSceneStatus): BncrSceneRecord {
  return {
    ...scene,
    status,
  };
}

export function executeSceneAdminCommand(args: {
  parsed: ParsedInbound;
  command: BncrSceneAdminCommand;
  sceneRegistry: Map<string, BncrSceneRecord>;
  defaultAdminAgentId: string;
  defaultPublicAgentId: string;
  now: () => number;
  /**
   * When true, non-admin callers in direct chat are allowed to execute
   * self-admin commands (history-*, download-media) scoped to
   * their own session only.  The flag is set by the caller after an
   * explicit allow-list check – it must NOT be granted unconditionally
   * for direct chat.
   */
  allowNonAdminSelfAdmin?: boolean;
  /** Agent serving the current request; selects that agent's scene rows. */
  agentId?: string;
}): { ok: true; text: string } | { ok: false; text: string } {
  const {
    parsed,
    command,
    sceneRegistry,
    defaultAdminAgentId,
    defaultPublicAgentId,
    now,
    allowNonAdminSelfAdmin,
  } = args;
  const sceneAgentId = args.agentId;

  // Administrators operate on explicitly named scenes that another agent may
  // serve, so an admin lookup may fall back to the unscoped row. Everyone else
  // only ever sees their own agent's rows.
  const lookupScene = (sceneKey: string) =>
    resolveSceneRecord(sceneRegistry, sceneKey, sceneAgentId) ??
    (parsed.isAdmin ? resolveSceneRecord(sceneRegistry, sceneKey) : undefined);

  // Admin always passes; non-admin only passes when the caller explicitly
  // opted in via allowNonAdminSelfAdmin (self-admin commands in direct chat).
  if (!parsed.isAdmin && !allowNonAdminSelfAdmin) {
    return { ok: false, text: ADMIN_REQUIRED_TEXT };
  }

  // Non-admin self-admin: enforce that sceneId targets only the caller's own session.
  if (allowNonAdminSelfAdmin && !parsed.isAdmin) {
    const currentSceneKey = resolveCurrentSceneKey(parsed);
    const cmdSceneKey =
      'sceneKey' in command ? (command as { sceneKey?: string }).sceneKey : undefined;
    if (cmdSceneKey && currentSceneKey && cmdSceneKey !== currentSceneKey) {
      return { ok: false, text: 'You can only manage your own private chat session.' };
    }
  }

  // A caller may only speak for their own agent row unless they are an admin.
  const requestedAgentId =
    'agentId' in command ? normalizeToken((command as { agentId?: string }).agentId || '') : '';
  if (
    requestedAgentId &&
    !parsed.isAdmin &&
    requestedAgentId !== normalizeToken(sceneAgentId || '')
  ) {
    return { ok: false, text: ADMIN_REQUIRED_TEXT };
  }

  // The global default applies to every scene, so it stays administrator-only.
  // Direct-chat self-admin covers the caller's own scene and nothing wider.
  if (command.kind === 'download-media-global-set' && !parsed.isAdmin) {
    return { ok: false, text: ADMIN_REQUIRED_TEXT };
  }

  if (command.kind === 'history-help') {
    return { ok: true, text: HISTORY_HELP_TEXT };
  }

  if (command.kind === 'list') {
    // The global media default is an internal config row, not a chat; listing it
    // as a scene only confuses the operator.
    const scenes = Array.from(sceneRegistry.values())
      .filter((scene) => normalizeToken(scene.sceneKey) !== GLOBAL_SCENE_KEY)
      .filter((scene) =>
        command.scope === 'pending' ? resolveEffectiveSceneStatus(scene) === 'pending' : true,
      )
      .filter((scene) => matchesSceneFilters(scene, command.filters))
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    if (scenes.length === 0) {
      return {
        ok: true,
        text:
          command.scope === 'pending'
            ? command.filters?.length
              ? `No pending scenes matched: ${command.filters.join(' ')}`
              : 'No pending scenes.'
            : command.filters?.length
              ? `No scenes matched: ${command.filters.join(' ')}`
              : 'No scenes recorded.',
      };
    }
    return { ok: true, text: formatSceneGroups(scenes) };
  }

  if (command.kind === 'mode-help') {
    return { ok: true, text: MODE_HELP_TEXT };
  }

  if (command.kind === 'mode-get') {
    const sceneKey = command.sceneKey || resolveCurrentGroupSceneKey(parsed);
    if (!sceneKey) {
      return { ok: false, text: 'Current group mode query only works inside a group chat.' };
    }
    const rows = listSceneRows(sceneRegistry, sceneKey).filter((row) => row.kind === 'group');
    if (rows.length === 0) {
      return { ok: false, text: `Scene not found: ${sceneKey}` };
    }
    const wantedAgent = normalizeToken(command.agentId || '');
    const scoped = wantedAgent
      ? rows.filter((row) => normalizeToken(row.agentId || '') === wantedAgent)
      : rows;
    if (scoped.length === 0) {
      return { ok: false, text: unknownAgentText(wantedAgent, sceneKey, rows) };
    }
    const modeOf = (row: BncrSceneRecord) => normalizeToken(row.groupReplyMode || '') || 'admin';
    if (wantedAgent) {
      return { ok: true, text: `Mode ${sceneKey} for ${wantedAgent} is ${modeOf(scoped[0])}.` };
    }
    const distinct = new Set(scoped.map(modeOf));
    if (distinct.size === 1) {
      const scope = scoped.length > 1 ? ` (all ${scoped.length} agents)` : '';
      return { ok: true, text: `Mode ${sceneKey} is ${modeOf(scoped[0])}${scope}.` };
    }
    return { ok: true, text: formatPerAgent(`Mode ${sceneKey}`, scoped, modeOf) };
  }

  // Every scene setting takes the same optional tail: [<agentId>] [<SceneId>].
  // Without an agent id the write fans out to every agent watching the scene,
  // which is what keeps two agents in one group from drifting apart.
  const resolveTargets = (targetSceneKey: string, agentId?: string) => {
    const rows = listSceneRows(sceneRegistry, targetSceneKey);
    const wanted = normalizeToken(agentId || '');
    return {
      rows,
      wanted,
      targets: wanted ? rows.filter((row) => normalizeToken(row.agentId || '') === wanted) : rows,
    };
  };

  const scopeLabel = (wanted: string, targets: BncrSceneRecord[]): string =>
    wanted ? ` for ${wanted}` : targets.length > 1 ? ` for all ${targets.length} agents` : '';

  if (command.kind === 'history-limit-get') {
    const qSceneKey = command.sceneKey || resolveCurrentSceneKey(parsed);
    if (!qSceneKey) {
      return { ok: true, text: 'Default history limit is 50.' };
    }
    const { rows, targets, wanted } = resolveTargets(qSceneKey, command.agentId);
    if (rows.length === 0) return { ok: true, text: 'Default history limit is 50.' };
    if (wanted) {
      if (targets.length === 0) {
        return { ok: false, text: unknownAgentText(wanted, qSceneKey, rows) };
      }
      const limit = resolveBncrHistoryLimit(targets[0].historyLimit);
      return {
        ok: true,
        text: `Current ${qSceneKey} history limit for ${wanted} is ${limit}.`,
      };
    }
    const limitOf = (row: BncrSceneRecord) => String(resolveBncrHistoryLimit(row.historyLimit));
    const limits = new Set(targets.map(limitOf));
    if (limits.size === 1) {
      return { ok: true, text: `Current ${qSceneKey} history limit is ${[...limits][0]}.` };
    }
    return {
      ok: true,
      text: formatPerAgent(`Current ${qSceneKey} history limit`, targets, limitOf),
    };
  }

  if (command.kind === 'history-limit-set') {
    const sSceneKey = command.sceneKey || resolveCurrentSceneKey(parsed);
    if (!sSceneKey) {
      return { ok: false, text: 'Current conversation shortcut requires a valid chat.' };
    }
    const { rows, targets, wanted } = resolveTargets(sSceneKey, command.agentId);
    if (rows.length === 0) return { ok: false, text: `Scene not found: ${sSceneKey}` };
    if (targets.length === 0) {
      return { ok: false, text: unknownAgentText(wanted, sSceneKey, rows) };
    }
    const scope = scopeLabel(wanted, targets);
    if (command.limit === 'clear') {
      for (const row of targets) {
        const { historyLimit: _, ...rest } = row;
        setSceneRecord(sceneRegistry, { ...rest, lastSeenAt: now() });
      }
      return {
        ok: true,
        text: `Cleared ${sSceneKey} history limit${scope}. Will use default (50).`,
      };
    }
    const rawLimit = command.limit;
    if (!Number.isFinite(rawLimit) || Number.isNaN(rawLimit)) {
      return { ok: false, text: 'Invalid number.' };
    }
    let resolvedLimit = rawLimit;
    if (resolvedLimit >= 51) {
      resolvedLimit = Math.min(Math.floor(resolvedLimit), 10000);
    } else if (resolvedLimit >= 2) {
      resolvedLimit = Math.floor(resolvedLimit);
    } else if (resolvedLimit < 0 && Math.abs(resolvedLimit) >= 2) {
      resolvedLimit = Math.min(Math.floor(Math.abs(resolvedLimit)), 10000);
    } else {
      return {
        ok: false,
        text: 'Value too small, must be >= 2, or use negative number (abs >= 2) for hidden override.',
      };
    }
    for (const row of targets) {
      setSceneRecord(sceneRegistry, { ...row, historyLimit: resolvedLimit, lastSeenAt: now() });
    }
    return {
      ok: true,
      text: `Set ${sSceneKey} history limit to ${resolvedLimit}${scope}.`,
    };
  }

  if (command.kind === 'history-force-get') {
    const qSceneKey = command.sceneKey || resolveCurrentSceneKey(parsed);
    if (!qSceneKey) {
      return { ok: true, text: 'Default history auto flush is on.' };
    }
    const { rows, targets, wanted } = resolveTargets(qSceneKey, command.agentId);
    if (rows.length === 0) return { ok: true, text: 'Default history auto flush is on.' };
    if (wanted) {
      if (targets.length === 0) {
        return { ok: false, text: unknownAgentText(wanted, qSceneKey, rows) };
      }
      const enabled = targets[0].historyForce !== false;
      return {
        ok: true,
        text:
          'Current ' +
          qSceneKey +
          ' history auto flush for ' +
          wanted +
          ' is ' +
          (enabled ? 'on' : 'off') +
          '.',
      };
    }
    const forceOf = (row: BncrSceneRecord) => (row.historyForce !== false ? 'on' : 'off');
    const forces = new Set(targets.map(forceOf));
    if (forces.size === 1) {
      return {
        ok: true,
        text: `Current ${qSceneKey} history auto flush is ${[...forces][0]}.`,
      };
    }
    return {
      ok: true,
      text: formatPerAgent(`Current ${qSceneKey} history auto flush`, targets, forceOf),
    };
  }

  if (command.kind === 'history-force-set') {
    const sSceneKey = command.sceneKey || resolveCurrentSceneKey(parsed);
    if (!sSceneKey) {
      return { ok: false, text: 'Current conversation shortcut requires a valid chat.' };
    }
    const { rows, targets, wanted } = resolveTargets(sSceneKey, command.agentId);
    if (rows.length === 0) return { ok: false, text: `Scene not found: ${sSceneKey}` };
    if (targets.length === 0) {
      return { ok: false, text: unknownAgentText(wanted, sSceneKey, rows) };
    }
    const scope = scopeLabel(wanted, targets);
    if (command.enabled === 'clear') {
      for (const row of targets) {
        const { historyForce: _, ...rest } = row;
        setSceneRecord(sceneRegistry, { ...rest, lastSeenAt: now() });
      }
      return {
        ok: true,
        text: `Cleared ${sSceneKey} history auto flush${scope}. Will use default (on).`,
      };
    }
    for (const row of targets) {
      setSceneRecord(sceneRegistry, { ...row, historyForce: command.enabled, lastSeenAt: now() });
    }
    return {
      ok: true,
      text:
        'Set ' +
        sSceneKey +
        ' history auto flush to ' +
        (command.enabled ? 'on' : 'off') +
        scope +
        '.',
    };
  }

  if (command.kind === 'download-media-global-get') {
    const g = lookupScene(GLOBAL_SCENE_KEY);
    const enabled = g?.downloadMedia === true;
    return { ok: true, text: `Global default download remote media is ${enabled ? 'on' : 'off'}.` };
  }

  if (command.kind === 'download-media-global-set') {
    const g = lookupScene(GLOBAL_SCENE_KEY);
    const nextGlobal: BncrSceneRecord = {
      sceneKey: GLOBAL_SCENE_KEY,
      kind: 'group',
      status: 'allowed',
      ...(g || { platform: 'bncr' }),
      downloadMedia: command.enabled,
      lastSeenAt: now(),
    };
    // The global row is shared by every agent, so it must stay unowned.
    delete nextGlobal.agentId;
    setSceneRecord(sceneRegistry, nextGlobal);
    return {
      ok: true,
      text: `Global default download remote media set to ${command.enabled ? 'on' : 'off'}.`,
    };
  }

  if (command.kind === 'download-media-get') {
    // A scene needs no group: a direct chat is a scene too, and its rows are the
    // only place a per-chat switch can live.
    const qSceneKey = command.sceneKey || resolveCurrentSceneKey(parsed);
    const globalEnabled = lookupScene(GLOBAL_SCENE_KEY)?.downloadMedia === true;
    const globalText = `Global default download remote media is ${globalEnabled ? 'on' : 'off'}.`;
    if (!qSceneKey) return { ok: true, text: globalText };
    const { rows, targets, wanted } = resolveTargets(qSceneKey, command.agentId);
    // No row yet means nothing was chosen here, so the global default answers.
    if (rows.length === 0) return { ok: true, text: globalText };
    const mediaOf = (row: BncrSceneRecord) =>
      row.downloadMedia === undefined
        ? `global (${globalEnabled ? 'on' : 'off'})`
        : row.downloadMedia
          ? 'on'
          : 'off';
    if (wanted) {
      if (targets.length === 0) {
        return { ok: false, text: unknownAgentText(wanted, qSceneKey, rows) };
      }
      return {
        ok: true,
        text: `Current ${qSceneKey} download remote media for ${wanted} is ${mediaOf(targets[0])}.`,
      };
    }
    const states = new Set(targets.map(mediaOf));
    if (states.size === 1) {
      const only = [...states][0];
      return {
        ok: true,
        text: only.startsWith('global')
          ? `Current ${qSceneKey} download remote media follows the global default (${globalEnabled ? 'on' : 'off'}).`
          : `Current ${qSceneKey} download remote media is ${only}.`,
      };
    }
    return {
      ok: true,
      text: formatPerAgent(`Current ${qSceneKey} download remote media`, targets, mediaOf),
    };
  }

  if (command.kind === 'download-media-set') {
    const sSceneKey = command.sceneKey || resolveCurrentSceneKey(parsed);
    if (!sSceneKey) {
      return { ok: false, text: 'Current conversation shortcut requires a valid chat.' };
    }
    const { rows, targets, wanted } = resolveTargets(sSceneKey, command.agentId);
    if (targets.length === 0 && wanted) {
      return { ok: false, text: unknownAgentText(wanted, sSceneKey, rows) };
    }
    const scope = scopeLabel(wanted, targets);
    if (command.enabled === undefined) {
      if (rows.length === 0) {
        return { ok: true, text: `No per-group config to clear for ${sSceneKey}.` };
      }
      for (const row of targets) {
        const { downloadMedia: _, ...rest } = row;
        setSceneRecord(sceneRegistry, { ...rest, lastSeenAt: now() });
      }
      return {
        ok: true,
        text: `Cleared ${sSceneKey} download remote media${scope}. Will use global default.`,
      };
    }
    if (rows.length === 0) return { ok: false, text: `Scene not found: ${sSceneKey}` };
    for (const row of targets) {
      setSceneRecord(sceneRegistry, { ...row, downloadMedia: command.enabled, lastSeenAt: now() });
    }
    return {
      ok: true,
      text: `Set ${sSceneKey} download remote media to ${command.enabled ? 'on' : 'off'}${scope}.`,
    };
  }

  const sceneKey = command.sceneKey || resolveCurrentGroupSceneKey(parsed);
  if (!sceneKey) {
    return { ok: false, text: 'Current group shortcut only works inside a group chat.' };
  }

  const existing = lookupScene(sceneKey);
  if (!existing) {
    return { ok: false, text: `Scene not found: ${sceneKey}` };
  }

  if (command.kind === 'revoke') {
    // Revoking is the one place that cannot fan out: approvals were granted to
    // every agent at once, but deleting is per row, so a shared scene has to
    // name its row instead of having one picked for it.
    const revokeRows = listSceneRows(sceneRegistry, sceneKey);
    const wantedAgent = normalizeToken(command.agentId || '');
    const owners = Array.from(
      new Set(revokeRows.map((row) => normalizeToken(row.agentId || '')).filter(Boolean)),
    ).sort();
    if (!wantedAgent && owners.length > 1) {
      return {
        ok: false,
        text:
          `Scene ${sceneKey} is served by ${owners.length} agents (` +
          `${owners.join(', ')}). Name one: /bncr revoke <agentId> [<SceneId>].`,
      };
    }
    const target = wantedAgent
      ? revokeRows.find((row) => normalizeToken(row.agentId || '') === wantedAgent)
      : revokeRows[0];
    if (!target) {
      return { ok: false, text: unknownAgentText(wantedAgent, sceneKey, revokeRows) };
    }
    deleteSceneRecord(sceneRegistry, sceneKey, target.agentId || sceneAgentId);
    // Whatever is left keeps the scene admitted. Saying who avoids a revoke that
    // reads successful while the chat still answers through another row.
    const left = listSceneRows(sceneRegistry, sceneKey)
      .map((row) => normalizeToken(row.agentId || '') || '(unassigned)')
      .sort();
    const leftText = left.length > 0 ? ` Still admitted for ${left.join(', ')}.` : '';
    return { ok: true, text: `Revoked scene ${sceneKey}.${leftText}` };
  }

  if (command.kind === 'bind') {
    // Rebinding rewrites the row's owner, so landing on an agent that already
    // holds this scene would overwrite its settings without a trace. Refuse and
    // ask for the revoke first.
    const occupant = listSceneRows(sceneRegistry, sceneKey).find(
      (row) =>
        normalizeToken(row.agentId || '') === normalizeToken(command.agentId) &&
        normalizeToken(row.agentId || '') !== normalizeToken(existing.agentId || ''),
    );
    if (occupant) {
      return {
        ok: false,
        text:
          `Agent ${normalizeToken(command.agentId)} already has a row for ${sceneKey}. ` +
          `Revoke it first: /bncr revoke ${normalizeToken(command.agentId)} [<SceneId>].`,
      };
    }
    setSceneRecord(
      sceneRegistry,
      {
        ...existing,
        agentId: command.agentId,
        lastSeenAt: now(),
      },
      { previousAgentId: existing.agentId },
    );
    return { ok: true, text: `Bound ${sceneKey} to agent ${command.agentId}.` };
  }

  if (command.kind === 'mode') {
    // Reply mode is stored per agent row. Omitting the agent is the documented
    // way to make every agent watching this scene follow the same rule, so the
    // write fans out instead of leaving a sibling row behind.
    const groupRows = listSceneRows(sceneRegistry, sceneKey).filter((row) => row.kind === 'group');
    if (groupRows.length === 0) {
      return { ok: false, text: `Scene ${sceneKey} is not a group scene.` };
    }
    const wantedAgent = normalizeToken(command.agentId || '');
    const targets = wantedAgent
      ? groupRows.filter((row) => normalizeToken(row.agentId || '') === wantedAgent)
      : groupRows;
    if (targets.length === 0) {
      return {
        ok: false,
        text: unknownAgentText(wantedAgent, sceneKey, groupRows),
      };
    }
    const clearing = command.mode === 'clear';
    for (const row of targets) {
      const next: BncrSceneRecord = { ...row, lastSeenAt: now() };
      if (clearing) delete next.groupReplyMode;
      else next.groupReplyMode = command.mode as BncrGroupReplyMode;
      setSceneRecord(sceneRegistry, next);
    }
    const scope = wantedAgent
      ? ` for ${wantedAgent}`
      : targets.length > 1
        ? ` for all ${targets.length} agents`
        : '';
    if (clearing) {
      return {
        ok: true,
        text: `Cleared ${sceneKey} reply mode${scope}. Will use default (admin).`,
      };
    }
    return { ok: true, text: `Set ${sceneKey} reply mode to ${command.mode}${scope}.` };
  }

  // Naming an agent narrows approval to that row; omitting it admits every agent
  // watching the scene, exactly like the rest of the scene settings.
  const sceneRows = listSceneRows(sceneRegistry, sceneKey);
  const wantedAgent = normalizeToken(command.agentId || '');
  const targets = wantedAgent
    ? sceneRows.filter((row) => normalizeToken(row.agentId || '') === wantedAgent)
    : sceneRows;
  if (targets.length === 0) {
    return {
      ok: false,
      text: unknownAgentText(wantedAgent, sceneKey, sceneRows),
    };
  }
  const allowing = command.kind === 'allow';
  for (const row of targets) {
    const fallbackAgentId =
      row.kind === 'group'
        ? defaultPublicAgentId
        : parsed.isAdmin
          ? defaultAdminAgentId
          : defaultPublicAgentId;
    const next = applySceneStatus(row, allowing ? 'allowed' : 'denied');
    if (allowing) {
      // Claiming an unowned row is a migration for the single-row case. While
      // fanning out there is no way to tell which agent serves the legacy row,
      // so its status is written but the owner stays empty instead of being
      // invented as a brand-new agent row.
      next.agentId = row.agentId || (targets.length === 1 ? fallbackAgentId : '');
      next.approvedAt = now();
    } else {
      delete next.approvedAt;
    }
    // Claiming an unowned scene moves it into the owning agent's slot; the
    // legacy unowned entry must not linger and shadow the new row.
    setSceneRecord(
      sceneRegistry,
      {
        ...next,
        lastSeenAt: now(),
      },
      { previousAgentId: row.agentId },
    );
  }
  const approvalScope = wantedAgent
    ? ` for ${wantedAgent}`
    : targets.length > 1
      ? ` for all ${targets.length} agents`
      : '';

  return {
    ok: true,
    text: allowing
      ? `Allowed scene ${sceneKey}${approvalScope}.`
      : `Denied scene ${sceneKey}${approvalScope}.`,
  };
}
