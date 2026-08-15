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

const BNCR_NATIVE_COMMANDS = new Set([
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

  const bareMatch = raw.match(/^\/([A-Za-z0-9_]+)(?:\s+.*)?$/);
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
      { label: '/bncr verbose on|off|full', scopes: ['admin'] },
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
    audience: 'admin',
    commands: [
      { label: '/bncr history-help', scopes: ['admin'] },
      { label: '/bncr history-limit [<number>|clear] [<SceneId>]', scopes: ['admin'] },
      { label: '/bncr history-force on|off|clear [<SceneId>]', scopes: ['admin'] },
    ],
  },
  {
    title: '🌐 Remote media',
    audience: 'admin',
    commands: [
      {
        label: '/bncr download-media on|off|clear|default on|off [<SceneId>]',
        scopes: ['admin'],
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
  const scope = args.peerKind === 'group' ? 'this group chat' : 'this private chat';
  return {
    handled: true,
    reason,
    text:
      reason === 'new'
        ? `Started a new session for ${scope}.`
        : `Reset the current session for ${scope}.`,
  };
}

export function resolveBncrNativeVerboseCommand(
  command: NativeCommand,
): NativeVerboseCommand | null {
  if (command.command !== 'verbose') return null;
  const rawLevel = String(command.argsText || '')
    .trim()
    .toLowerCase();
  if (!rawLevel || rawLevel === 'status') {
    return { handled: true, text: 'Current verbose level is unchanged.' };
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
