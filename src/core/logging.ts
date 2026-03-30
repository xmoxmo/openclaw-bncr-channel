export type BncrLogLevel = 'info' | 'warn' | 'error';
export type BncrLogOptions = { debugOnly?: boolean };

const BNCR_PREFIX = '[bncr]';

type DebugGate = () => boolean;

type ConsoleMethod = 'log' | 'warn' | 'error';

function resolveConsoleMethod(level: BncrLogLevel): ConsoleMethod {
  switch (level) {
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'log';
  }
}

function emitConsole(method: ConsoleMethod, line: string) {
  if (method === 'warn') {
    console.warn(line);
    return;
  }
  if (method === 'error') {
    console.error(line);
    return;
  }
  console.log(line);
}

export function normalizeBncrLogLine(raw: string | undefined) {
  const text = String(raw || '').trim();
  if (!text) return BNCR_PREFIX;
  return text.startsWith(BNCR_PREFIX) ? text : `${BNCR_PREFIX} ${text}`;
}

export function formatBncrLogLine(scope: string | undefined, message: string | undefined) {
  const normalizedScope = String(scope || '').trim();
  const normalizedMessage = String(message || '').trim();
  const prefix = normalizedScope ? `${BNCR_PREFIX} ${normalizedScope}` : BNCR_PREFIX;
  return normalizedMessage ? `${prefix} ${normalizedMessage}` : prefix;
}

export function emitBncrLog(
  level: BncrLogLevel,
  scope: string | undefined,
  message: string | undefined,
  options?: BncrLogOptions,
  isDebugEnabled?: DebugGate,
) {
  if (options?.debugOnly && !(isDebugEnabled?.() ?? false)) return;
  emitConsole(resolveConsoleMethod(level), formatBncrLogLine(scope, message));
}

export function emitBncrLogLine(
  level: BncrLogLevel,
  line: string | undefined,
  options?: BncrLogOptions,
  isDebugEnabled?: DebugGate,
) {
  if (options?.debugOnly && !(isDebugEnabled?.() ?? false)) return;
  emitConsole(resolveConsoleMethod(level), normalizeBncrLogLine(line));
}
