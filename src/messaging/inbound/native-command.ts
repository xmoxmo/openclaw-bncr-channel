export type NativeCommand = {
  command: string;
  raw: string;
  body: string;
};

export type NativeVerboseCommand = {
  handled: true;
  verboseLevel?: 'on' | 'off' | 'full';
  text: string;
};

export function parseBncrNativeCommand(text: string): NativeCommand | null {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const match = raw.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const command = String(match[1] || '')
    .trim()
    .toLowerCase();
  if (!command) return null;

  const rest = String(match[2] || '').trim();
  const body = command === 'help' ? ['/commands', rest].filter(Boolean).join(' ') : raw;
  return { command, raw, body };
}

export function resolveBncrNativeVerboseCommand(
  command: NativeCommand,
): NativeVerboseCommand | null {
  if (command.command !== 'verbose') return null;
  const rawLevel = String(command.raw.slice('/verbose'.length) || '')
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
