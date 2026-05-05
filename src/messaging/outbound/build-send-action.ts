import { randomUUID } from 'node:crypto';

type MinimalBncrSendInput = {
  channel?: string;
  action?: string;
  idempotencyKey?: string;
  accountId?: string;
  to?: string;
  message?: string;
  caption?: string;
  path?: string;
  media?: string;
  filePath?: string;
  mediaUrl?: string;
  asVoice?: boolean;
  audioAsVoice?: boolean;
  params?: Record<string, unknown>;
};

type BuiltBncrMessageAction = {
  channel: string;
  action: string;
  idempotencyKey: string;
  accountId?: string;
  params: Record<string, unknown>;
};

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    if (value.length === 0) return '';
    return value;
  }
  return undefined;
}

function pickFirstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

export function buildBncrMessageAction(input: MinimalBncrSendInput): BuiltBncrMessageAction {
  const paramsObj = isPlainObject(input.params) ? input.params : {};

  const channel = asString(input.channel || 'bncr').trim() || 'bncr';
  const action = asString(input.action || 'send').trim() || 'send';
  const idempotencyKey =
    asString(input.idempotencyKey || '').trim() || `bncr-${randomUUID()}`;
  const accountId =
    asString(pickFirstString(paramsObj.accountId, input.accountId) || '').trim() || undefined;

  const to = asString(pickFirstString(paramsObj.to, input.to) || '').trim();
  if (!to) throw new Error('bncr send requires to');

  const mediaPath = pickFirstString(
    paramsObj.media,
    paramsObj.path,
    paramsObj.filePath,
    paramsObj.mediaUrl,
    input.media,
    input.path,
    input.filePath,
    input.mediaUrl,
  );

  const message = pickFirstString(paramsObj.message, input.message) ?? '';
  const explicitCaption = pickFirstString(paramsObj.caption, input.caption) ?? '';
  const asVoice = pickFirstBoolean(paramsObj.asVoice, input.asVoice);
  const audioAsVoice = pickFirstBoolean(paramsObj.audioAsVoice, input.audioAsVoice);

  if ((asVoice === true || audioAsVoice === true) && !mediaPath) {
    throw new Error('bncr voice send requires media path');
  }

  const normalizedParams: Record<string, unknown> = {
    ...paramsObj,
    to,
  };

  if (mediaPath) {
    normalizedParams.path = mediaPath;
    const finalCaption = explicitCaption || message;
    if (finalCaption) normalizedParams.caption = finalCaption;
    delete normalizedParams.message;
  } else {
    const finalMessage = message || explicitCaption;
    if (!finalMessage.trim()) throw new Error('bncr send requires message or media');
    normalizedParams.message = finalMessage;
    delete normalizedParams.caption;
  }

  if (asVoice === true) normalizedParams.asVoice = true;
  if (audioAsVoice === true) normalizedParams.audioAsVoice = true;
  if (accountId) normalizedParams.accountId = accountId;

  return {
    channel,
    action,
    idempotencyKey,
    ...(accountId ? { accountId } : {}),
    params: normalizedParams,
  };
}
