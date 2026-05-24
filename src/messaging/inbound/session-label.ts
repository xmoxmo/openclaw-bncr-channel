import {
  recordSessionMetaFromInbound,
  updateSessionStoreEntry,
} from 'openclaw/plugin-sdk/session-store-runtime';
import { emitBncrLogLine } from '../../core/logging.ts';

type RecordInboundSessionFn = (args: any) => Promise<unknown> | unknown;

export function buildBncrInboundSessionIdentityPatch(args: {
  channelId: string;
  accountId: string;
  chatType: 'direct' | 'group';
  displayTo: string;
  senderId: string;
}) {
  const { channelId, accountId, chatType, displayTo, senderId } = args;
  return {
    label: displayTo,
    channel: channelId,
    chatType,
    origin: {
      label: displayTo,
      provider: channelId,
      surface: channelId,
      chatType,
      from: senderId,
      to: displayTo,
      accountId,
    },
    deliveryContext: {
      channel: channelId,
      to: displayTo,
      accountId,
    },
    route: {
      channel: channelId,
      accountId,
      target: { to: displayTo },
    },
    lastTo: displayTo,
  };
}

function normalizeNonEmptyString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export async function correctBncrInboundSessionLabel(args: {
  storePath: string;
  sessionKey: string;
  expectedLabel: string;
}) {
  const storePath = normalizeNonEmptyString(args.storePath);
  const sessionKey = normalizeNonEmptyString(args.sessionKey);
  const expectedLabel = normalizeNonEmptyString(args.expectedLabel);
  if (!storePath || !sessionKey || !expectedLabel) return;

  try {
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: (entry: any) => {
        if (entry?.label === expectedLabel) return null;
        return { label: expectedLabel };
      },
    });
  } catch (err) {
    emitBncrLogLine('warn', `[bncr] inbound session label correction failed: ${String(err)}`);
  }
}

export async function recordAndPatchBncrInboundSessionEntry(args: {
  storePath: string;
  sessionKey: string;
  ctx?: Record<string, unknown>;
  patch: Record<string, unknown>;
}) {
  const storePath = normalizeNonEmptyString(args.storePath);
  const sessionKey = normalizeNonEmptyString(args.sessionKey);
  if (!storePath || !sessionKey) return;

  try {
    if (args.ctx) {
      await recordSessionMetaFromInbound({
        storePath,
        sessionKey,
        ctx: args.ctx as any,
        createIfMissing: true,
      });
    }
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: () => args.patch,
    });
  } catch (err) {
    emitBncrLogLine('warn', `[bncr] inbound session patch failed: ${String(err)}`);
  }
}

export function wrapBncrInboundRecordSessionLabelCorrection(args: {
  recordInboundSession: RecordInboundSessionFn;
  expectedLabel: string;
}): RecordInboundSessionFn {
  return async (recordArgs: any) => {
    const result = await args.recordInboundSession(recordArgs);
    await correctBncrInboundSessionLabel({
      storePath: recordArgs?.storePath,
      sessionKey: recordArgs?.sessionKey,
      expectedLabel: args.expectedLabel,
    });
    return result;
  };
}
