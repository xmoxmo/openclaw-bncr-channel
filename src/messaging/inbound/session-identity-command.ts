import type { BncrSceneRecord } from '../../plugin/channel-runtime-types.ts';
import { setSceneRecord } from '../../plugin/scene-registry.ts';
import { ADMIN_REQUIRED_TEXT } from './command-constants.ts';
import type { ParsedInbound } from './dispatch-prep.ts';
import type { NativeCommand } from './native-command.ts';
import { unknownAgentText } from './scene-admin.ts';
import {
  BNCR_DIRECT_SESSION_CATEGORY,
  BNCR_SESSION_NAME_MAX_CHARS,
  formatBncrSceneLabel,
  isBncrSceneIdToken,
  parseBncrSceneTargets,
  sanitizeBncrDisplayName,
} from './session-identity.ts';

const TARGET_FORMAT_LINES = [
  'Format:',
  '  • <agentId> — one agent watching the scene; omit it to change every agent',
  '  • <SceneId> — 平台:群id or 平台:用户id; defaults to this chat',
];

export const NAME_HELP_TEXT = [
  '🏷 Session name',
  '',
  'Shows or overrides the sidebar name of a scene.',
  'The plugin rewrites the label on every inbound message, so a rename made in the web UI only',
  'lasts until the next message. This command is the durable way to change it.',
  '',
  'Commands:',
  '  • /bncr name [<agentId>] [<SceneId>]',
  '    Show the effective name and whether it is custom or automatic',
  '  • /bncr name set <text> [<agentId>] [<SceneId>]',
  '    Override the name; the id suffix is dropped for custom names',
  '  • /bncr name clear [<agentId>] [<SceneId>]',
  '    Drop the override and fall back to 平台 · 名称 · id (平台 · id when the name is empty)',
  '',
  ...TARGET_FORMAT_LINES,
  '  • <text> — 1-' +
    BNCR_SESSION_NAME_MAX_CHARS +
    ' chars; "·" becomes "-"; longer text is truncated',
  '  • Targeting another agent or another scene requires admin',
].join('\n');

export const GROUP_HELP_TEXT = [
  '📁 Session group',
  '',
  'Shows or overrides the sidebar group a scene is filed under.',
  'Direct chats are filed under 私聊 by default and always fall back there after clear.',
  'Group chats keep the host default until a group is set here.',
  '',
  'Commands:',
  '  • /bncr group [<agentId>] [<SceneId>]',
  '    Show the effective group and whether it is custom or default',
  '  • /bncr group set <name> [<agentId>] [<SceneId>]',
  '    File the scene under <name>; the host creates the group on the next message',
  '  • /bncr group clear [<agentId>] [<SceneId>]',
  '    Drop the override: 私聊 for direct chats, host default for groups',
  '',
  ...TARGET_FORMAT_LINES,
  `  • <name> — 1-${BNCR_SESSION_NAME_MAX_CHARS} chars; "·" becomes "-"`,
  '  • Targeting another agent or another scene requires admin',
].join('\n');

export type BncrSessionIdentityAction = 'get' | 'set' | 'clear' | 'help';

export type BncrSessionIdentityCommand = {
  target: 'name' | 'group';
  action: BncrSessionIdentityAction;
  value?: string;
  sceneKey?: string;
  agentId?: string;
};

export type ParsedSessionIdentityCommand =
  | { matched: false }
  | { matched: true; valid: false; text: string }
  | { matched: true; valid: true; command: BncrSessionIdentityCommand };

function normalizeToken(value: unknown): string {
  return String(value ?? '').trim();
}

function splitArgs(raw: string): string[] {
  return normalizeToken(raw)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function usageText(target: 'name' | 'group'): string {
  const value = target === 'name' ? '<text>' : '<name>';
  return [
    'Usage:',
    `  /bncr ${target} [<agentId>] [<SceneId>]`,
    `  /bncr ${target} set ${value} [<agentId>] [<SceneId>]`,
    `  /bncr ${target} clear [<agentId>] [<SceneId>]`,
    `  /bncr ${target} help`,
  ].join('\n');
}

export function parseSessionIdentityCommand(
  command: NativeCommand,
  options?: { knownAgentIds?: ReadonlySet<string> },
): ParsedSessionIdentityCommand {
  const target = command.command === 'name' || command.command === 'group' ? command.command : null;
  if (!target) return { matched: false };
  const knownAgentIds = options?.knownAgentIds ?? new Set<string>();

  const args = splitArgs(command.argsText);
  if (args.length === 0) return { matched: true, valid: true, command: { target, action: 'get' } };

  const head = args[0].toLowerCase();
  if (head === 'help') {
    if (args.length > 1) return { matched: true, valid: false, text: usageText(target) };
    return { matched: true, valid: true, command: { target, action: 'help' } };
  }

  if (head === 'clear') {
    const targets = parseBncrSceneTargets(args.slice(1));
    if (!targets) return { matched: true, valid: false, text: usageText(target) };
    return { matched: true, valid: true, command: { target, action: 'clear', ...targets } };
  }

  if (head === 'set') {
    const parts = args.slice(1);
    if (parts.length === 0) return { matched: true, valid: false, text: usageText(target) };
    // Targets sit at the tail so the free-text value can contain spaces. The
    // trailing token is only read as an agent id when the registry knows it,
    // which keeps a two-word ASCII name from being swallowed as a target.
    let sceneKey: string | undefined;
    if (parts.length >= 2 && isBncrSceneIdToken(parts[parts.length - 1])) {
      sceneKey = parts.pop();
    }
    let agentId: string | undefined;
    const last = parts[parts.length - 1];
    if (parts.length >= 2 && last && knownAgentIds.has(last)) {
      agentId = parts.pop();
    }
    const value = parts.join(' ').trim();
    if (!value) return { matched: true, valid: false, text: usageText(target) };
    return {
      matched: true,
      valid: true,
      command: {
        target,
        action: 'set',
        value,
        ...(sceneKey ? { sceneKey } : {}),
        ...(agentId ? { agentId } : {}),
      },
    };
  }

  const targets = parseBncrSceneTargets(args);
  if (!targets) return { matched: true, valid: false, text: usageText(target) };
  return { matched: true, valid: true, command: { target, action: 'get', ...targets } };
}

function resolveCurrentSceneKey(parsed: ParsedInbound): string | null {
  const platform = normalizeToken(parsed.platform);
  if (!platform) return null;
  if (parsed.peer.kind === 'group') {
    const groupId = normalizeToken(parsed.groupId);
    if (!groupId || groupId === '0') return null;
    return `${platform}:${groupId}`;
  }
  const userId = normalizeToken(parsed.userId);
  if (!userId || userId === '0') return null;
  return `${platform}:${userId}`;
}

function describeLabel(
  scene: BncrSceneRecord,
  customName: string | undefined,
  maxChars: number,
): string {
  const label = formatBncrSceneLabel({
    platform: scene.platform,
    id: scene.kind === 'group' ? scene.groupId : scene.userId,
    name: scene.kind === 'group' ? scene.groupName : scene.userName,
    customName,
    maxNameChars: maxChars,
  });
  return label || scene.sceneKey;
}

export type SessionIdentityCommandResult =
  | { ok: true; text: string; sceneKey: string; identityChanged?: boolean }
  | { ok: false; text: string };

/**
 * Execute /bncr name or /bncr group.
 *
 * Targets follow the same [<agentId>] [<SceneId>] tail every scene setting
 * uses: no agent id fans the write out to every agent watching the scene, which
 * is what keeps two agents in one group from drifting apart.
 */
export function executeSessionIdentityCommand(args: {
  parsed: ParsedInbound;
  command: BncrSessionIdentityCommand;
  sceneRegistry: Map<string, BncrSceneRecord>;
  sceneAgentId?: string;
  now: () => number;
  maxNameChars?: number;
}): SessionIdentityCommandResult {
  const { parsed, command, sceneRegistry, sceneAgentId, now } = args;
  const maxChars = args.maxNameChars ?? BNCR_SESSION_NAME_MAX_CHARS;

  if (command.action === 'help') {
    return {
      ok: true,
      text: command.target === 'name' ? NAME_HELP_TEXT : GROUP_HELP_TEXT,
      sceneKey: '',
    };
  }

  const currentSceneKey = resolveCurrentSceneKey(parsed);
  const targetSceneKey = command.sceneKey || currentSceneKey;
  if (!targetSceneKey) {
    return { ok: false, text: 'Current conversation shortcut requires a valid chat.' };
  }

  const isOtherScene = targetSceneKey !== currentSceneKey;
  if ((isOtherScene || parsed.peer.kind === 'group') && parsed.isAdmin !== true) {
    return { ok: false, text: ADMIN_REQUIRED_TEXT };
  }

  const wantedAgent = normalizeToken(command.agentId);
  if (wantedAgent && parsed.isAdmin !== true && wantedAgent !== normalizeToken(sceneAgentId)) {
    return { ok: false, text: ADMIN_REQUIRED_TEXT };
  }

  const rows = Array.from(sceneRegistry.values()).filter(
    (row) => normalizeToken(row.sceneKey) === targetSceneKey,
  );
  if (rows.length === 0) return { ok: false, text: `Scene not found: ${targetSceneKey}` };

  const targets = wantedAgent
    ? rows.filter((row) => normalizeToken(row.agentId) === wantedAgent)
    : rows;
  if (targets.length === 0) {
    return { ok: false, text: unknownAgentText(wantedAgent, targetSceneKey, rows) };
  }

  // Labels are rendered from the row the caller asked about, so a per-agent
  // name shows up in that agent's answer instead of a sibling's.
  const base = targets.reduce(
    (newest, row) => ((row.lastSeenAt ?? 0) >= (newest.lastSeenAt ?? 0) ? row : newest),
    targets[0],
  );
  const scope = wantedAgent
    ? ` for ${wantedAgent}`
    : targets.length > 1
      ? ` for all ${targets.length} agents`
      : '';

  const write = (patch: { customName?: string | null; category?: string | null }): void => {
    for (const row of targets) {
      const next: BncrSceneRecord = { ...row, lastSeenAt: now() };
      if ('customName' in patch) {
        if (patch.customName) next.customName = patch.customName;
        else delete next.customName;
      }
      if ('category' in patch) {
        if (patch.category) next.category = patch.category;
        else delete next.category;
      }
      setSceneRecord(sceneRegistry, next);
    }
  };

  const nameOf = (row: BncrSceneRecord): string => {
    const custom = sanitizeBncrDisplayName(normalizeToken(row.customName), maxChars);
    return `${describeLabel(row, custom ?? undefined, maxChars)} (${custom ? 'custom' : 'auto'})`;
  };
  const groupOf = (row: BncrSceneRecord): string => {
    const custom = sanitizeBncrDisplayName(normalizeToken(row.category), maxChars);
    const fallback = row.kind === 'direct' ? BNCR_DIRECT_SESSION_CATEGORY : 'Groups';
    return `${custom ?? fallback} (${custom ? 'custom' : 'default'})`;
  };
  // A scene-wide read has to answer for the whole scene: identical rows collapse
  // into one line, disagreement is listed per agent instead of picking a row.
  const describeRows = (
    title: string,
    rowsToShow: BncrSceneRecord[],
    render: (row: BncrSceneRecord) => string,
  ): string =>
    [
      title,
      ...rowsToShow.map(
        (row) => `  ${normalizeToken(row.agentId) || '(unassigned)'}: ${render(row)}`,
      ),
    ].join('\n');

  if (command.target === 'name') {
    if (command.action === 'get') {
      if (wantedAgent) {
        return {
          ok: true,
          text: `Name for ${wantedAgent}: ${nameOf(targets[0])}`,
          sceneKey: targetSceneKey,
        };
      }
      const nameLines = new Set(targets.map(nameOf));
      if (nameLines.size === 1) {
        return { ok: true, text: `Name: ${nameOf(targets[0])}`, sceneKey: targetSceneKey };
      }
      return {
        ok: true,
        text: describeRows(`Name ${targetSceneKey}`, targets, nameOf),
        sceneKey: targetSceneKey,
      };
    }
    if (command.action === 'set') {
      const custom = sanitizeBncrDisplayName(command.value, maxChars);
      if (!custom) return { ok: false, text: `Name must be 1-${maxChars} characters.` };
      write({ customName: custom });
      return {
        ok: true,
        text: `Name set: ${describeLabel(base, custom, maxChars)} (custom)${scope}`,
        sceneKey: targetSceneKey,
        identityChanged: true,
      };
    }
    write({ customName: null });
    return {
      ok: true,
      text: `Name cleared: ${describeLabel(base, undefined, maxChars)} (auto)${scope}`,
      sceneKey: targetSceneKey,
      identityChanged: true,
    };
  }

  const defaultCategory = base.kind === 'direct' ? BNCR_DIRECT_SESSION_CATEGORY : 'Groups';

  if (command.action === 'get') {
    if (wantedAgent) {
      return {
        ok: true,
        text: `Group for ${wantedAgent}: ${groupOf(targets[0])}`,
        sceneKey: targetSceneKey,
      };
    }
    const groupLines = new Set(targets.map(groupOf));
    if (groupLines.size === 1) {
      return { ok: true, text: `Group: ${groupOf(targets[0])}`, sceneKey: targetSceneKey };
    }
    return {
      ok: true,
      text: describeRows(`Group ${targetSceneKey}`, targets, groupOf),
      sceneKey: targetSceneKey,
    };
  }
  if (command.action === 'set') {
    const category = sanitizeBncrDisplayName(command.value, maxChars);
    if (!category) return { ok: false, text: `Group must be 1-${maxChars} characters.` };
    write({ category });
    return {
      ok: true,
      text: `Group set: ${category}${scope}`,
      sceneKey: targetSceneKey,
      identityChanged: true,
    };
  }
  write({ category: null });
  return {
    ok: true,
    text: `Group cleared: ${defaultCategory}${scope}`,
    sceneKey: targetSceneKey,
    identityChanged: true,
  };
}
