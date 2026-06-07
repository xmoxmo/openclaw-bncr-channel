export function stringifyConsoleArgs(args) {
  return args.map((part) => String(part)).join(' ');
}

export async function withConsoleCapture(channels, fn) {
  const names = Array.isArray(channels) ? channels : [channels];
  const captures = Object.fromEntries(names.map((name) => [name, []]));
  const originals = Object.fromEntries(names.map((name) => [name, console[name]]));

  try {
    for (const name of names) {
      console[name] = (...args) => {
        captures[name].push(stringifyConsoleArgs(args));
      };
    }
    return await fn(captures);
  } finally {
    for (const name of names) {
      console[name] = originals[name];
    }
  }
}
