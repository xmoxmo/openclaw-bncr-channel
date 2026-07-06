import type {
  BncrGroupReplyMode,
  BncrSceneRecord,
  BncrSceneStatus,
} from '../../plugin/channel-runtime-types.ts';
import type { ParsedInbound } from './dispatch-prep.ts';
import type { NativeCommand } from './native-command.ts';

export type BncrSceneAdminCommand =
  | { kind: 'allow'; sceneKey?: string }
  | { kind: 'deny'; sceneKey?: string }
  | { kind: 'revoke'; sceneKey?: string }
  | { kind: 'bind'; sceneKey?: string; agentId: string }
  | { kind: 'mode-help' }
  | { kind: 'mode-get'; sceneKey?: string }
  | { kind: 'mode'; sceneKey: string; mode: BncrGroupReplyMode }
  | { kind: 'list'; scope: 'pending' | 'scenes' };

const GROUP_REPLY_MODES = new Set<BncrGroupReplyMode>(['admin', 'mention', 'hybrid', 'all']);

const MODE_HELP_TEXT = [
  '💬 Group reply modes',
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
  '  • /bncr mode',
  '  • /bncr mode help',
  '  • /bncr mode <admin|mention|hybrid|all> [<platform>:<groupId>]',
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

function resolveCurrentGroupSceneKey(parsed: ParsedInbound): string | null {
  if (parsed.peer.kind !== 'group') return null;
  const platform = normalizeToken(parsed.platform);
  const groupId = normalizeToken(parsed.groupId);
  if (!platform || !groupId || groupId === '0') return null;
  return `${platform}:${groupId}`;
}

export function parseSceneAdminCommand(command: NativeCommand): ParsedSceneAdminCommand {
  const args = splitArgs(command.argsText);
  switch (command.command) {
    case 'allow':
      return args.length <= 1
        ? { matched: true, valid: true, command: { kind: 'allow', sceneKey: args[0] } }
        : { matched: true, valid: false, text: 'Usage: /bncr allow [<sceneKey>]' };
    case 'deny':
      return args.length <= 1
        ? { matched: true, valid: true, command: { kind: 'deny', sceneKey: args[0] } }
        : { matched: true, valid: false, text: 'Usage: /bncr deny [<sceneKey>]' };
    case 'revoke':
      return args.length <= 1
        ? { matched: true, valid: true, command: { kind: 'revoke', sceneKey: args[0] } }
        : { matched: true, valid: false, text: 'Usage: /bncr revoke [<sceneKey>]' };
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
      if (args.length === 1) {
        if (args[0] === 'help') {
          return {
            matched: true,
            valid: true,
            command: { kind: 'mode-help' },
          };
        }
        if (GROUP_REPLY_MODES.has(args[0] as BncrGroupReplyMode)) {
          return {
            matched: true,
            valid: true,
            command: { kind: 'mode', sceneKey: '', mode: args[0] as BncrGroupReplyMode },
          };
        }
        return {
          matched: true,
          valid: true,
          command: { kind: 'mode-get', sceneKey: args[0] },
        };
      }
      if (GROUP_REPLY_MODES.has(args[0] as BncrGroupReplyMode) && args[1]) {
        return {
          matched: true,
          valid: true,
          command: { kind: 'mode', sceneKey: args[1], mode: args[0] as BncrGroupReplyMode },
        };
      }
      return {
        matched: true,
        valid: false,
        text: 'Usage: /bncr mode | /bncr mode <admin|mention|hybrid|all> [<sceneKey>]',
      };
    case 'list':
      if (args[0] === 'pending') {
        return { matched: true, valid: true, command: { kind: 'list', scope: 'pending' } };
      }
      if (args[0] === 'scenes') {
        return { matched: true, valid: true, command: { kind: 'list', scope: 'scenes' } };
      }
      return { matched: true, valid: false, text: 'Usage: /bncr list <pending|scenes>' };
    default:
      return { matched: false };
  }
}

function formatSceneDetailsLine(scene: BncrSceneRecord): string {
  const idPart =
    scene.kind === 'group' ? scene.groupId || scene.sceneKey : scene.userId || scene.sceneKey;
  const namePart = scene.kind === 'group' ? scene.groupName || '' : scene.userName || '';
  const labelPart = namePart ? ` name=${namePart}` : '';
  return `  Details: status=${scene.status} id=${idPart}${labelPart}`;
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
}): { ok: true; text: string } | { ok: false; text: string } {
  const { parsed, command, sceneRegistry, defaultAdminAgentId, defaultPublicAgentId, now } = args;

  if (!parsed.isAdmin) {
    return { ok: false, text: 'Admin permission required.' };
  }

  if (command.kind === 'list') {
    const scenes = Array.from(sceneRegistry.values())
      .filter((scene) => (command.scope === 'pending' ? scene.status === 'pending' : true))
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    if (scenes.length === 0) {
      return {
        ok: true,
        text: command.scope === 'pending' ? 'No pending scenes.' : 'No scenes recorded.',
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
    const existingScene = sceneRegistry.get(sceneKey);
    if (!existingScene) {
      return { ok: false, text: `Scene not found: ${sceneKey}` };
    }
    if (existingScene.kind !== 'group') {
      return { ok: false, text: `Scene ${sceneKey} is not a group scene.` };
    }
    return {
      ok: true,
      text: `Current ${sceneKey} reply mode is ${existingScene.groupReplyMode || 'admin'}.`,
    };
  }

  const sceneKey = command.sceneKey || resolveCurrentGroupSceneKey(parsed);
  if (!sceneKey) {
    return { ok: false, text: 'Current group shortcut only works inside a group chat.' };
  }

  const existing = sceneRegistry.get(sceneKey);
  if (!existing) {
    return { ok: false, text: `Scene not found: ${sceneKey}` };
  }

  if (command.kind === 'revoke') {
    sceneRegistry.delete(sceneKey);
    return { ok: true, text: `Revoked scene ${sceneKey}.` };
  }

  if (command.kind === 'bind') {
    sceneRegistry.set(sceneKey, {
      ...existing,
      agentId: command.agentId,
      lastSeenAt: now(),
    });
    return { ok: true, text: `Bound ${sceneKey} to agent ${command.agentId}.` };
  }

  if (command.kind === 'mode') {
    if (existing.kind !== 'group') {
      return { ok: false, text: `Scene ${sceneKey} is not a group scene.` };
    }
    sceneRegistry.set(sceneKey, {
      ...existing,
      groupReplyMode: command.mode,
      lastSeenAt: now(),
    });
    return { ok: true, text: `Set ${sceneKey} reply mode to ${command.mode}.` };
  }

  const fallbackAgentId =
    existing.kind === 'group'
      ? defaultPublicAgentId
      : parsed.isAdmin
        ? defaultAdminAgentId
        : defaultPublicAgentId;
  const next = applySceneStatus(existing, command.kind === 'allow' ? 'allowed' : 'denied');
  sceneRegistry.set(sceneKey, {
    ...next,
    ...(command.kind === 'allow' ? { agentId: existing.agentId || fallbackAgentId } : {}),
    lastSeenAt: now(),
  });

  return {
    ok: true,
    text: command.kind === 'allow' ? `Allowed scene ${sceneKey}.` : `Denied scene ${sceneKey}.`,
  };
}
