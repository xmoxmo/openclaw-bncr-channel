import { emitBncrLogLine } from '../../core/logging.ts';

const bncrReplyDispatchChains = new Map<string, Promise<void>>();

export async function runBncrReplyDispatchSerial<T>(
  sessionKey: string,
  task: () => Promise<T>,
  meta?: { msgId?: string | null; to?: string | null; debugEnabled?: boolean },
) {
  const key = String(sessionKey || '').trim();
  if (!key) return await task();

  const metaSuffix = `|msgId=${String(meta?.msgId || '-')}|to=${String(meta?.to || '-')}`;

  const previous = bncrReplyDispatchChains.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  bncrReplyDispatchChains.set(key, chain);

  const debugGate = () => meta?.debugEnabled === true;

  emitBncrLogLine(
    'info',
    `[bncr] reply-serial queued|sessionKey=${key}${metaSuffix}`,
    { debugOnly: true },
    debugGate,
  );
  await previous;
  emitBncrLogLine(
    'info',
    `[bncr] reply-serial acquired|sessionKey=${key}${metaSuffix}`,
    { debugOnly: true },
    debugGate,
  );
  try {
    return await task();
  } finally {
    emitBncrLogLine(
      'info',
      `[bncr] reply-serial releasing|sessionKey=${key}${metaSuffix}`,
      { debugOnly: true },
      debugGate,
    );
    release();
    if (bncrReplyDispatchChains.get(key) === chain) {
      bncrReplyDispatchChains.delete(key);
    }
    emitBncrLogLine(
      'info',
      `[bncr] reply-serial released|sessionKey=${key}${metaSuffix}`,
      { debugOnly: true },
      debugGate,
    );
  }
}

export function resetBncrReplyDispatchSerialForTest() {
  bncrReplyDispatchChains.clear();
}
