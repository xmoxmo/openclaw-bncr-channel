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

export type NativeVerboseCommand = {
  handled: true;
  verboseLevel?: 'on' | 'off' | 'full';
  text: string;
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

const BNCR_HELP_TEXT = [
  '🦞 Bncr command usage',
  '',
  '📌 Bncr builtins',
  '  • /bncr whoami',
  '  • /bncr verbose on|off|full',
  '',
  '🛡 Scene approval',
  '  • /bncr allow [<SceneId>]',
  '  • /bncr deny [<SceneId>]',
  '  • /bncr bind <agentId> [<SceneId>]',
  '  • /bncr mode',
  '  • /bncr mode help',
  '  • /bncr mode <admin|mention|hybrid|all> [<SceneId>]',
  '  • /bncr revoke [<SceneId>]',
  '  • /bncr list pending',
  '  • /bncr list scenes',
].join('\n');

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
]);

export const BNCR_DIRECT_ALLOWED_BARE_COMMANDS = new Set(['whoami', 'status', 'new', 'reset']);

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
  const match = raw.match(/^\/bncr(?:@[A-Za-z0-9_]+)?(?:\s+([^\s]+)(?:\s+([\s\S]*))?)?$/i);
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

  const bareMatch = raw.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+.*)?$/);
  if (!bareMatch) return null;
  const bareCommand = String(bareMatch[1] || '')
    .trim()
    .toLowerCase();
  if (!bareCommand) return null;

  if (bareCommand === 'bncr') {
    const subMatch = raw.match(/^\/bncr(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]+))?/i);
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

export function resolveBncrNativeHelpCommand(command: NativeCommand): NativeHelpCommand | null {
  if (command.command !== 'help') return null;
  return { handled: true, text: BNCR_HELP_TEXT };
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
}): NativeSessionResetCommand | null {
  if (args.command.command !== 'new' && args.command.command !== 'reset') return null;
  const reason = args.command.command === 'new' ? 'new' : 'reset';
  return {
    handled: true,
    reason,
    text:
      reason === 'new'
        ? 'Started a new session for this private chat.'
        : 'Reset the current session for this private chat.',
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
