export type NativeCommand = {
  command: string;
  raw: string;
  body: string;
  argsText: string;
};

export type ParseBncrNativeCommandOptions = {
  allowBareWhoami?: boolean;
  allowBareStatus?: boolean;
  allowBareSessionReset?: boolean;
};

export function isBncrStopCommandText(rawBody: string): boolean {
  const raw = String(rawBody || '')
    .trim()
    .toLowerCase();
  return raw === '/stop';
}

export type NativeVerboseCommand = {
  handled: true;
  verboseLevel?: 'on' | 'off' | 'full';
  text: string;
};

export type NativeHelpCommandOptions = {
  isAdmin?: boolean;
  peerKind?: 'direct' | 'group';
};

export type NativeHelpCommand = {
  handled: true;
  text: string;
};

export type NativeWhoamiCommand = {
  handled: true;
  text: string;
};

export type NativeStatusCommand = {
  handled: true;
  text: string;
};

export type NativeSessionResetCommand = {
  handled: true;
  reason: 'new' | 'reset';
  text: string;
};

/**
 * Commands that non-admin private-chat users may self-elevate for.
 * When a non-admin direct-chat caller issues one of these commands,
 * the plugin temporarily treats them as admin so the command follows
 * the same code path as an admin caller. This whitelist is shared
 * across permission checks so admin and non-admin logic stay in sync.
 *
 * `stop` stays in this whitelist for semantic consistency, but it is
 * routed through the unified stop fast path in dispatch.ts rather than
 * the native command handler, so it is never processed here.
 */
export const BNCR_SELF_SERVICE_COMMANDS: ReadonlySet<string> = new Set([
  'whoami',
  'status',
  'verbose',
  'model',
  'new',
  'reset',
  'stop',
]);

/**
 * Synthetic command name used when an admin bare command is routed to the
 * OpenClaw native parser. It must never be exposed to the user.
 */
export const BNCR_OPENCLAW_NATIVE_COMMAND = '__openclaw_native__';

/**
 * Detect if the raw text is a bare whitelist command that should be
 * elevated to admin for OpenClaw native parsing (private non-admin)
 * or mapped to /bncr (group non-admin).
 */
export function isBncrWhitelistBareCommandText(rawBody: string): string | null {
  const raw = String(rawBody || '')
    .trim()
    .toLowerCase();
  if (!raw.startsWith('/')) return null;
  const bare = raw.slice(1);
  if (!bare) return null;
  // Whitelist commands match the exact command name only. @bot suffixes are
  // intentionally unsupported so bare commands stay consistent with /stop.
  const commandName = bare.split(/\s+/, 1)[0];
  if (!commandName) return null;
  return BNCR_SELF_SERVICE_COMMANDS.has(commandName) ? commandName : null;
}

/**
 * Resolve which bare slash commands bncr should treat as native commands.
 *
 * Admin callers never have whitelist restrictions: their bare commands go to
 * the OpenClaw parser. Non-admin group callers map the whitelist onto /bncr
 * native commands; non-admin private callers are elevated and routed to the
 * OpenClaw parser instead (handled before this helper runs).
 */
export function resolveBncrNativeCommandParseOptions(args: {
  isAdmin: boolean;
  peerKind: 'direct' | 'group';
}): ParseBncrNativeCommandOptions {
  const isGroup = args.peerKind === 'group';
  const isNonAdmin = args.isAdmin !== true;
  return {
    allowBareWhoami: isNonAdmin && isGroup,
    allowBareStatus: isNonAdmin && isGroup,
    allowBareSessionReset: isNonAdmin && isGroup,
  };
}

export const BNCR_NATIVE_COMMANDS = new Set([
  'help',
  'new',
  'reset',
  'status',
  'whoami',
  'verbose',
  'allow',
  'deny',
  'bind',
  'mode',
  'revoke',
  'list',
  'history-limit',
  'history-help',
  'history-force',
  'download-media',
]);

export const BNCR_DIRECT_ALLOWED_BARE_COMMANDS = new Set([
  'whoami',
  'status',
  'new',
  'reset',
  'stop',
]);

export const BNCR_DIRECT_ALLOWED_SUBCOMMANDS = new Set([
  'help',
  'whoami',
  'status',
  'new',
  'reset',
]);

export function parseBncrNativeCommand(
  text: string,
  options?: ParseBncrNativeCommandOptions,
): NativeCommand | null {
  const raw = String(text || '').trim();
  const allowBareWhoami = options?.allowBareWhoami !== false;
  const allowBareStatus = options?.allowBareStatus === true;
  const allowBareSessionReset = options?.allowBareSessionReset === true;
  if (allowBareSessionReset && raw.toLowerCase() === '/new') {
    return { command: 'new', raw, body: '/new', argsText: '' };
  }
  if (allowBareSessionReset && raw.toLowerCase() === '/reset') {
    return { command: 'reset', raw, body: '/reset', argsText: '' };
  }
  if (allowBareStatus && raw.toLowerCase() === '/status') {
    return { command: 'status', raw, body: '/status', argsText: '' };
  }
  if (allowBareWhoami && raw.toLowerCase() === '/whoami') {
    return { command: 'whoami', raw, body: '/whoami', argsText: '' };
  }
  if (!raw.startsWith('/bncr')) return null;
  const match = raw.match(/^\/bncr(?:\s+([^\s]+)(?:\s+([\s\S]*))?)?$/i);
  if (!match) return null;

  const command = String(match[1] || 'help')
    .trim()
    .toLowerCase();
  if (!command) return null;
  if (!BNCR_NATIVE_COMMANDS.has(command)) return null;

  const argsText = String(match[2] || '').trim();
  const body =
    command === 'help' ? '/commands' : [`/${command}`, argsText].filter(Boolean).join(' ');
  return { command, raw, body, argsText };
}

export function parseBncrUnsupportedDirectCommand(text: string): {
  command: string;
  raw: string;
} | null {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;

  // Hyphens are allowed in command names (e.g. /history-limit) so bare slash
  // parsing matches the same command vocabulary as the /bncr subcommands.
  const bareMatch = raw.match(/^\/([A-Za-z0-9_-]+)(?:\s+.*)?$/);
  if (!bareMatch) return null;
  const bareCommand = String(bareMatch[1] || '')
    .trim()
    .toLowerCase();
  if (!bareCommand) return null;

  if (bareCommand === 'bncr') {
    const subMatch = raw.match(/^\/bncr(?:\s+([A-Za-z0-9_-]+))?/i);
    const subCommand =
      String(subMatch?.[1] || '')
        .trim()
        .toLowerCase() || 'help';
    if (BNCR_DIRECT_ALLOWED_SUBCOMMANDS.has(subCommand)) return null;
    return { command: `bncr ${subCommand}`, raw };
  }

  if (BNCR_DIRECT_ALLOWED_BARE_COMMANDS.has(bareCommand)) return null;
  return { command: bareCommand, raw };
}

const BNCR_HELP_SECTIONS = [
  {
    title: '📌 Bncr builtins',
    audience: 'all',
    commands: [
      { label: '/bncr whoami', scopes: ['admin', 'direct', 'group'] },
      { label: '/bncr status', scopes: ['admin', 'direct', 'group'] },
      { label: '/bncr new', scopes: ['admin', 'direct'] },
      { label: '/bncr reset', scopes: ['admin', 'direct'] },
      { label: '/bncr verbose on|off|full', scopes: ['admin', 'direct'] },
    ],
  },
  {
    title: '🛡 Scene approval',
    audience: 'admin',
    commands: [
      { label: '/bncr allow [<SceneId>]', scopes: ['admin'] },
      { label: '/bncr deny [<SceneId>]', scopes: ['admin'] },
      { label: '/bncr bind <agentId> [<SceneId>]', scopes: ['admin'] },
      { label: '/bncr mode help', scopes: ['admin'] },
      {
        label: '/bncr mode <admin|mention|hybrid|all|clear> [<SceneId>]',
        scopes: ['admin'],
      },
      { label: '/bncr revoke [<SceneId>]', scopes: ['admin'] },
      { label: '/bncr list pending [filters...]', scopes: ['admin'] },
      { label: '/bncr list scenes [filters...]', scopes: ['admin'] },
    ],
  },
  {
    title: '📋 Conversation history',
    audience: 'all',
    commands: [
      { label: '/bncr history-help', scopes: ['admin', 'direct'] },
      { label: '/bncr history-limit [<number>|clear] [<SceneId>]', scopes: ['admin', 'direct'] },
      { label: '/bncr history-force on|off|clear [<SceneId>]', scopes: ['admin', 'direct'] },
    ],
  },
  {
    title: '🌐 Remote media',
    audience: 'all',
    commands: [
      {
        label: '/bncr download-media on|off|clear|default on|off [<SceneId>]',
        scopes: ['admin', 'direct'],
      },
    ],
  },
];

export function resolveBncrNativeHelpCommand(
  command: NativeCommand,
  options?: NativeHelpCommandOptions,
): NativeHelpCommand | null {
  if (command.command !== 'help') return null;

  const isAdmin = options?.isAdmin === true;
  const isGroup = options?.peerKind === 'group';
  const audience = isAdmin ? 'admin' : isGroup ? 'group' : 'direct';
  const sections: string[] = ['🦞 Bncr command usage', ''];

  for (const section of BNCR_HELP_SECTIONS) {
    if (section.audience !== 'all' && section.audience !== audience) continue;
    const visible = section.commands.filter((item) => item.scopes.includes(audience));
    if (visible.length === 0) continue;
    sections.push(section.title);
    for (const item of visible) sections.push(`  • ${item.label}`);
    sections.push('');
  }

  return { handled: true, text: sections.join('\n') };
}

export function resolveBncrNativeWhoamiCommand(args: {
  command: NativeCommand;
  platform: string;
  groupId: string;
  groupName?: string;
  userId: string;
  userName?: string;
  isGroup: boolean;
  isAdmin: boolean;
}): NativeWhoamiCommand | null {
  if (args.command.command !== 'whoami') return null;
  const lines = ['🧭 Bncr Identity', ''];
  lines.push(`Platform: ${args.platform || '(unknown)'}`);
  lines.push(`User: ${args.userName || '(unknown)'} (${args.userId || '0'})`);
  if (args.isGroup) {
    lines.push(`Group: ${args.groupName || '(unknown)'} (${args.groupId || '0'})`);
    lines.push(`Scene: ${args.platform || '(unknown)'}:${args.groupId || '0'}`);
  } else {
    lines.push(`Scene: ${args.platform || '(unknown)'}:${args.userId || '0'}`);
  }
  lines.push(`Admin: ${args.isAdmin ? 'true' : 'false'}`);
  return { handled: true, text: lines.join('\n') };
}

export function resolveBncrNativeStatusCommand(args: {
  command: NativeCommand;
  accountId: string;
  platform: string;
  userId: string;
  userName?: string;
  resolvedAgentId: string;
  sessionKey: string;
}): NativeStatusCommand | null {
  if (args.command.command !== 'status') return null;
  const lines = ['🦞 Bncr Status', ''];
  lines.push(`Channel: bncr`);
  lines.push(`Account: ${args.accountId || 'Primary'}`);
  lines.push(`User: ${args.userName || '(unknown)'} (${args.userId || '0'})`);
  lines.push(`Scene: ${args.platform || '(unknown)'}:${args.userId || '0'}`);
  lines.push(`Agent: ${args.resolvedAgentId || '(unknown)'}`);
  lines.push(`SessionKey: ${args.sessionKey || '(unknown)'}`);
  return { handled: true, text: lines.join('\n') };
}

export function resolveBncrNativeSessionResetCommand(args: {
  command: NativeCommand;
  peerKind: 'direct' | 'group';
}): NativeSessionResetCommand | null {
  if (args.command.command !== 'new' && args.command.command !== 'reset') return null;
  const reason = args.command.command === 'new' ? 'new' : 'reset';
  return {
    handled: true,
    reason,
    text: reason === 'new' ? '✅ New session started.' : '✅ Session reset.',
  };
}

export function resolveBncrNativeVerboseCommand(
  command: NativeCommand,
  currentLevel?: 'on' | 'off' | 'full',
): NativeVerboseCommand | null {
  if (command.command !== 'verbose') return null;
  const rawLevel = String(command.argsText || '')
    .trim()
    .toLowerCase();
  if (!rawLevel || rawLevel === 'status') {
    const label =
      currentLevel === 'full'
        ? 'full'
        : currentLevel === 'off'
          ? 'off'
          : currentLevel === 'on'
            ? 'on'
            : 'default';
    return { handled: true, text: `Current verbose level: ${label}` };
  }
  if (rawLevel === 'on')
    return { handled: true, verboseLevel: 'on', text: 'Verbose logging enabled.' };
  if (rawLevel === 'off')
    return { handled: true, verboseLevel: 'off', text: 'Verbose logging disabled.' };
  if (rawLevel === 'full')
    return { handled: true, verboseLevel: 'full', text: 'Verbose logging set to full.' };
  return {
    handled: true,
    text: `Unrecognized verbose level "${rawLevel}". Valid levels: off, on, full.`,
  };
}
