import { normalizeAccountId } from './accounts.ts';
import { normalizeStoredSessionKey, parseRouteLike } from './targets.ts';
import type { OutboxEntry } from './types.ts';
import { asString, finiteNumberOr } from './value-sanitize.ts';

type PersistedOutboxEntryInput = Partial<OutboxEntry> & {
  payload?: Record<string, unknown>;
};

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function normalizePersistedOutboxEntry(args: {
  entry: PersistedOutboxEntryInput | null | undefined;
  canonicalAgentId: string;
  now: () => number;
}): OutboxEntry | null {
  const { entry, canonicalAgentId } = args;
  if (!entry?.messageId) return null;
  const accountId = normalizeAccountId(entry.accountId);
  const sessionKey = asString(entry.sessionKey || '').trim();
  const normalized = normalizeStoredSessionKey(sessionKey, canonicalAgentId);
  if (!normalized) return null;

  const route = parseRouteLike(entry.route) || normalized.route;
  const payload: Record<string, unknown> =
    entry.payload && typeof entry.payload === 'object' ? { ...entry.payload } : {};
  payload.sessionKey = normalized.sessionKey;
  payload.platform = route.platform;
  payload.groupId = route.groupId;
  payload.userId = route.userId;

  // Migrate old _meta format entries to the new message format.
  // Old entries persisted before the _meta→message refactor carry media
  // metadata in payload._meta.  New code reads from payload.message.
  const oldMeta = payload._meta as Record<string, unknown> | undefined;
  if (oldMeta && !payload.message) {
    const oldKind = asString(oldMeta.kind);
    if (oldKind === 'file-transfer') {
      // Move replyToId from _meta to payload top level
      const replyToId = asString(oldMeta.replyToId || '').trim() || undefined;
      if (replyToId) payload.replyToId = replyToId;

      // Build new message object from old _meta fields
      const msg: Record<string, unknown> = {
        type: (oldMeta.type as string) || 'file',
        msg: oldMeta.text || '',
        mediaUrl: oldMeta.mediaUrl,
        mediaLocalRoots: oldMeta.mediaLocalRoots,
        asVoice: oldMeta.asVoice === true,
        audioAsVoice: oldMeta.audioAsVoice === true,
        downloadMedia: oldMeta.downloadMedia === true,
        kind: oldMeta.messageKind,
        transferMode: 'media',
        path: '',
        base64: '',
        fileName: '',
      };
      // Strip consumed _meta keys, pass through remaining as extra
      const consumed = new Set([
        'kind',
        'mediaUrl',
        'mediaLocalRoots',
        'text',
        'asVoice',
        'audioAsVoice',
        'replyToId',
        'finalEvent',
        'type',
        'downloadMedia',
        'messageKind',
        'retryCount',
        'nextAttemptAt',
      ]);
      for (const [key, value] of Object.entries(oldMeta)) {
        if (!consumed.has(key)) {
          msg[key] = value;
        }
      }
      payload.message = msg;
    }
    // Remove old _meta after migration
    delete payload._meta;
  }

  return {
    ...entry,
    messageId: asString(entry.messageId).trim(),
    accountId,
    sessionKey: normalized.sessionKey,
    route,
    payload,
    createdAt: finiteNumberOr(entry.createdAt, args.now()),
    retryCount: finiteNumberOr(entry.retryCount, 0),
    nextAttemptAt: finiteNumberOr(entry.nextAttemptAt, args.now()),
    lastAttemptAt: optionalFiniteNumber(entry.lastAttemptAt),
    lastError: entry.lastError ? asString(entry.lastError) : undefined,
    lastPushAt: optionalFiniteNumber(entry.lastPushAt),
    lastPushConnId: entry.lastPushConnId ? asString(entry.lastPushConnId) : undefined,
    lastPushClientId: entry.lastPushClientId ? asString(entry.lastPushClientId) : undefined,
    routeAttemptConnIds: Array.isArray(entry.routeAttemptConnIds)
      ? entry.routeAttemptConnIds.map((value) => asString(value)).filter(Boolean)
      : undefined,
    routeAttemptRound: optionalFiniteNumber(entry.routeAttemptRound),
    fastReroutePending: entry.fastReroutePending === true,
    awaitingRetryPush: entry.awaitingRetryPush === true,
  };
}
