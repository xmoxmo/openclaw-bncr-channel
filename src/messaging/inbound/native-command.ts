export type NativeCommand = {
  command: string;
  raw: string;
  body: string;
  argsText: string;
};

export type ParseBncrNativeCommandOptions = {
  allowBareWhoami?: boolean;
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

const BNCR_HELP_TEXT = [
  '🦞 Bncr command usage',
  '',
  '📌 Bncr builtins',
  '  • /bncr whoami',
  '  • /bncr verbose on|off|full',
  '',
  '🛡 Scene approval',
  '  • /bncr allow [<platform>:<groupId>]',
  '  • /bncr deny [<platform>:<groupId>]',
  '  • /bncr bind <agentId> [<platform>:<groupId>]',
  '  • /bncr mode',
  '  • /bncr mode help',
  '  • /bncr mode <admin|mention|hybrid|all> [<platform>:<groupId>]',
  '  • /bncr revoke [<platform>:<groupId>]',
  '  • /bncr list pending',
  '  • /bncr list scenes',
].join('\n');

const BNCR_NATIVE_COMMANDS = new Set([
  'help',
  'whoami',
  'verbose',
  'allow',
  'deny',
  'bind',
  'mode',
  'revoke',
  'list',
]);

export function parseBncrNativeCommand(
  text: string,
  options?: ParseBncrNativeCommandOptions,
): NativeCommand | null {
  const raw = String(text || '').trim();
  const allowBareWhoami = options?.allowBareWhoami !== false;
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
