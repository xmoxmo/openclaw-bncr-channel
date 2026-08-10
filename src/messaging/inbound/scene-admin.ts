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
  | { kind: 'mode'; sceneKey: string; mode: string }
  | { kind: 'list'; scope: 'pending' | 'scenes'; filters?: string[] }
  | { kind: 'history-limit-get'; sceneKey?: string }
  | { kind: 'history-limit-set'; sceneKey: string; limit: number | 'clear' }
  | { kind: 'history-force-get'; sceneKey?: string }
  | { kind: 'history-force-set'; sceneKey: string; enabled: boolean | 'clear' }
  | { kind: 'history-help' }
  | { kind: 'download-media-get'; sceneKey?: string }
  | { kind: 'download-media-set'; sceneKey: string; enabled: boolean | undefined }
  | { kind: 'download-media-global-get' }
  | { kind: 'download-media-global-set'; enabled: boolean };

const GROUP_REPLY_MODES = new Set<BncrGroupReplyMode>(['admin', 'mention', 'hybrid', 'all']);

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
  '  • /bncr mode <admin|mention|hybrid|all> [<SceneId>]',
].join('\n');

export const HISTORY_HELP_TEXT = [
  '📋 Bncr Conversation History Configuration',
  '',
  'Commands:',
  '  • /bncr history-limit <number> [<SceneId>]',
  '    Set history limit (default: 50)',
  '  • /bncr history-force on|off [<SceneId>]',
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
        if (args[0] === 'clear') {
          return {
            matched: true,
            valid: true,
            command: { kind: 'mode', sceneKey: '', mode: 'clear' },
          };
        }
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
      if (args[0] === 'clear' && args[1]) {
        return {
          matched: true,
          valid: true,
          command: { kind: 'mode', sceneKey: args[1], mode: 'clear' },
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
    case 'history-limit':
      if (args.length === 0) {
        return { matched: true, valid: true, command: { kind: 'history-limit-get' } };
      }
      if (args.length === 1) {
        if (args[0] === 'clear') {
          return {
            matched: true,
            valid: true,
            command: { kind: 'history-limit-set', sceneKey: '', limit: 'clear' },
          };
        }
        const num = parseInt(args[0], 10);
        if (Number.isFinite(num)) {
          return {
            matched: true,
            valid: true,
            command: { kind: 'history-limit-set', sceneKey: '', limit: num },
          };
        }
        return {
          matched: true,
          valid: true,
          command: { kind: 'history-limit-get', sceneKey: args[0] },
        };
      }
      if (args.length === 2) {
        if (args[0] === 'clear') {
          return {
            matched: true,
            valid: true,
            command: { kind: 'history-limit-set', sceneKey: args[1], limit: 'clear' },
          };
        }
        const num = parseInt(args[0], 10);
        if (Number.isFinite(num)) {
          return {
            matched: true,
            valid: true,
            command: { kind: 'history-limit-set', sceneKey: args[1], limit: num },
          };
        }
      }
      return {
        matched: true,
        valid: false,
        text: 'Usage: /bncr history-limit [<number>] [<sceneKey>]',
      };
    case 'history-force':
      if (args.length === 0) {
        return { matched: true, valid: true, command: { kind: 'history-force-get' } };
      }
      if (args[0] === 'clear') {
        if (args.length === 1) {
          return {
            matched: true,
            valid: true,
            command: { kind: 'history-force-set', sceneKey: '', enabled: 'clear' },
          };
        }
        return {
          matched: true,
          valid: true,
          command: { kind: 'history-force-set', sceneKey: args[1], enabled: 'clear' },
        };
      }
      if (args[0] === 'on' || args[0] === 'off') {
        if (args.length === 1) {
          return {
            matched: true,
            valid: true,
            command: { kind: 'history-force-set', sceneKey: '', enabled: args[0] === 'on' },
          };
        }
        return {
          matched: true,
          valid: true,
          command: { kind: 'history-force-set', sceneKey: args[1], enabled: args[0] === 'on' },
        };
      }
      return {
        matched: true,
        valid: true,
        command: { kind: 'history-force-get', sceneKey: args[0] },
      };
    case 'download-media':
      if (args.length === 0) {
        return { matched: true, valid: true, command: { kind: 'download-media-get' } };
      }
      if (args[0] === 'default') {
        if (args[1] === 'on' || args[1] === 'off') {
          return {
            matched: true,
            valid: true,
            command: { kind: 'download-media-global-set', enabled: args[1] === 'on' },
          };
        }
        return { matched: true, valid: true, command: { kind: 'download-media-global-get' } };
      }
      if (args[0] === 'clear') {
        return {
          matched: true,
          valid: true,
          command: {
            kind: 'download-media-set',
            sceneKey: args[1] || '',
            enabled: undefined,
          },
        };
      }
      if (args[0] === 'on' || args[0] === 'off') {
        if (args.length === 1) {
          return {
            matched: true,
            valid: true,
            command: { kind: 'download-media-set', sceneKey: '', enabled: args[0] === 'on' },
          };
        }
        return {
          matched: true,
          valid: true,
          command: { kind: 'download-media-set', sceneKey: args[1], enabled: args[0] === 'on' },
        };
      }
      return {
        matched: true,
        valid: true,
        command: { kind: 'download-media-get', sceneKey: args[0] },
      };
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
  const historyLimitVal = scene.historyLimit;
  const historyForceVal = scene.historyForce;
  const hasNonDefaultHistory =
    (typeof historyLimitVal === 'number' && historyLimitVal !== 50) || historyForceVal === false;
  const historyPart = hasNonDefaultHistory
    ? ` historyLimit=${historyLimitVal ?? 50} autoFlush=${historyForceVal !== false ? 'on' : 'off'}`
    : '';
  return `  Details: status=${scene.status} id=${idPart}${labelPart}${historyPart}`;
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
}): { ok: true; text: string } | { ok: false; text: string } {
  const { parsed, command, sceneRegistry, defaultAdminAgentId, defaultPublicAgentId, now } = args;

  if (!parsed.isAdmin) {
    return { ok: false, text: 'Admin permission required.' };
  }

  if (command.kind === 'history-help') {
    return { ok: true, text: HISTORY_HELP_TEXT };
  }

  if (command.kind === 'list') {
    const scenes = Array.from(sceneRegistry.values())
      .filter((scene) => (command.scope === 'pending' ? scene.status === 'pending' : true))
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

  if (command.kind === 'history-limit-get') {
    const qSceneKey = command.sceneKey || resolveCurrentSceneKey(parsed);
    if (!qSceneKey) {
      return { ok: true, text: 'Default history limit is 50.' };
    }
    const s = sceneRegistry.get(qSceneKey);
    if (!s) return { ok: true, text: 'Default history limit is 50.' };
    return { ok: true, text: `Current ${qSceneKey} history limit is ${s.historyLimit ?? 50}.` };
  }

  if (command.kind === 'history-limit-set') {
    const sSceneKey = command.sceneKey || resolveCurrentSceneKey(parsed);
    if (!sSceneKey) {
      return { ok: false, text: 'Current conversation shortcut requires a valid chat.' };
    }
    const sExisting = sceneRegistry.get(sSceneKey);
    if (!sExisting) return { ok: false, text: `Scene not found: ${sSceneKey}` };
    if (command.limit === 'clear') {
      const { historyLimit: _, ...rest } = sExisting;
      sceneRegistry.set(sSceneKey, { ...rest, lastSeenAt: now() });
      return { ok: true, text: `Cleared ${sSceneKey} history limit. Will use default (50).` };
    }
    const rawLimit = command.limit;
    if (!Number.isFinite(rawLimit) || Number.isNaN(rawLimit)) {
      return { ok: false, text: 'Invalid number.' };
    }
    let resolvedLimit = rawLimit;
    if (resolvedLimit >= 51) {
      resolvedLimit = Math.min(Math.floor(resolvedLimit), 10000);
    } else if (resolvedLimit < 0 && Math.abs(resolvedLimit) >= 3) {
      resolvedLimit = Math.floor(Math.abs(resolvedLimit));
    } else {
      return {
        ok: false,
        text: `Value too small, must be >= 51, or use negative number (abs >= 3) for hidden override.`,
      };
    }
    sceneRegistry.set(sSceneKey, {
      ...sExisting,
      historyLimit: resolvedLimit,
      lastSeenAt: now(),
    });
    return { ok: true, text: `Set ${sSceneKey} history limit to ${resolvedLimit}.` };
  }

  if (command.kind === 'history-force-get') {
    const qSceneKey = command.sceneKey || resolveCurrentSceneKey(parsed);
    if (!qSceneKey) {
      return { ok: true, text: 'Default history auto flush is on.' };
    }
    const s = sceneRegistry.get(qSceneKey);
    if (!s) return { ok: true, text: 'Default history auto flush is on.' };
    const enabled = s.historyForce !== false;
    return {
      ok: true,
      text: `Current ${qSceneKey} history auto flush is ${enabled ? 'on' : 'off'}.`,
    };
  }

  if (command.kind === 'history-force-set') {
    const sSceneKey = command.sceneKey || resolveCurrentSceneKey(parsed);
    if (!sSceneKey) {
      return { ok: false, text: 'Current conversation shortcut requires a valid chat.' };
    }
    const sExisting = sceneRegistry.get(sSceneKey);
    if (!sExisting) return { ok: false, text: `Scene not found: ${sSceneKey}` };
    if (command.enabled === 'clear') {
      const { historyForce: _, ...rest } = sExisting;
      sceneRegistry.set(sSceneKey, { ...rest, lastSeenAt: now() });
      return { ok: true, text: `Cleared ${sSceneKey} history auto flush. Will use default (on).` };
    }
    sceneRegistry.set(sSceneKey, {
      ...sExisting,
      historyForce: command.enabled,
      lastSeenAt: now(),
    });
    return {
      ok: true,
      text: `Set ${sSceneKey} history auto flush to ${command.enabled ? 'on' : 'off'}.`,
    };
  }

  if (command.kind === 'download-media-global-get') {
    const g = sceneRegistry.get(GLOBAL_SCENE_KEY);
    const enabled = g?.downloadMedia === true;
    return { ok: true, text: `Global default download remote media is ${enabled ? 'on' : 'off'}.` };
  }

  if (command.kind === 'download-media-global-set') {
    const g = sceneRegistry.get(GLOBAL_SCENE_KEY);
    sceneRegistry.set(GLOBAL_SCENE_KEY, {
      sceneKey: GLOBAL_SCENE_KEY,
      kind: 'group',
      status: 'allowed',
      ...(g || { platform: 'bncr' }),
      downloadMedia: command.enabled,
      lastSeenAt: now(),
    });
    return {
      ok: true,
      text: `Global default download remote media set to ${command.enabled ? 'on' : 'off'}.`,
    };
  }

  if (command.kind === 'download-media-get') {
    const qSceneKey = command.sceneKey || resolveCurrentGroupSceneKey(parsed);
    if (!qSceneKey) {
      return {
        ok: true,
        text: `Global default download remote media is ${sceneRegistry.get(GLOBAL_SCENE_KEY)?.downloadMedia === true ? 'on' : 'off'}.`,
      };
    }
    const s = sceneRegistry.get(qSceneKey);
    if (!s) return { ok: true, text: 'Default download remote media is off.' };
    const enabled = s.downloadMedia === true;
    return {
      ok: true,
      text: `Current ${qSceneKey} download remote media is ${enabled ? 'on' : 'off'}.`,
    };
  }

  if (command.kind === 'download-media-set') {
    const sSceneKey = command.sceneKey || resolveCurrentGroupSceneKey(parsed);
    if (!sSceneKey) {
      return { ok: false, text: 'Current group shortcut only works inside a group chat.' };
    }
    const sExisting = sceneRegistry.get(sSceneKey);
    if (command.enabled === undefined) {
      // Clear per-group setting
      if (sExisting) {
        const { downloadMedia: _, ...rest } = sExisting;
        sceneRegistry.set(sSceneKey, { ...rest, lastSeenAt: now() });
        return {
          ok: true,
          text: `Cleared ${sSceneKey} download remote media. Will use global default.`,
        };
      }
      return { ok: true, text: `No per-group config to clear for ${sSceneKey}.` };
    }
    if (!sExisting) return { ok: false, text: `Scene not found: ${sSceneKey}` };
    sceneRegistry.set(sSceneKey, {
      ...sExisting,
      downloadMedia: command.enabled,
      lastSeenAt: now(),
    });
    return {
      ok: true,
      text: `Set ${sSceneKey} download remote media to ${command.enabled ? 'on' : 'off'}.`,
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
    if (command.mode === 'clear') {
      const { groupReplyMode: _, ...rest } = existing;
      sceneRegistry.set(sceneKey, { ...rest, lastSeenAt: now() });
      return { ok: true, text: `Cleared ${sceneKey} reply mode. Will use default (admin).` };
    }
    sceneRegistry.set(sceneKey, {
      ...existing,
      groupReplyMode: command.mode as BncrGroupReplyMode,
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
