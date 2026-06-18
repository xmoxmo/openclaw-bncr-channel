import { normalizeAccountId } from '../../core/accounts.ts';
import { readOpenClawBooleanParam, readOpenClawStringParam } from '../../openclaw/sdk-helpers.ts';

export type NormalizedBncrSendParams = {
  to: string;
  accountId: string;
  message: string;
  caption: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  asVoice: boolean;
  audioAsVoice: boolean;
  type?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeBncrSendParams(input: {
  params: unknown;
  accountId: string;
}): NormalizedBncrSendParams {
  const paramsObj = isPlainObject(input.params) ? input.params : {};
  const to = readOpenClawStringParam(paramsObj, 'to', { required: true });
  const resolvedAccountId = normalizeAccountId(
    readOpenClawStringParam(paramsObj, 'accountId') ?? input.accountId,
  );

  const message = readOpenClawStringParam(paramsObj, 'message', { allowEmpty: true }) ?? '';
  const caption = readOpenClawStringParam(paramsObj, 'caption', { allowEmpty: true }) ?? '';
  const mediaUrl =
    readOpenClawStringParam(paramsObj, 'media', { trim: false }) ??
    readOpenClawStringParam(paramsObj, 'path', { trim: false }) ??
    readOpenClawStringParam(paramsObj, 'filePath', { trim: false }) ??
    readOpenClawStringParam(paramsObj, 'mediaUrl', { trim: false });
  const rawMediaUrls = paramsObj.mediaUrls;
  const mediaUrls = Array.isArray(rawMediaUrls)
    ? Array.from(
        new Set(rawMediaUrls.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)),
      )
    : undefined;
  // 如果 mediaUrl 已经在 mediaUrls 中，去重避免重复发送
  const dedupedMediaUrls = mediaUrls?.length
    ? mediaUrl && mediaUrls.includes(mediaUrl)
      ? mediaUrls
      : mediaUrl
        ? [mediaUrl, ...mediaUrls]
        : mediaUrls
    : undefined;
  const asVoice = readOpenClawBooleanParam(paramsObj, 'asVoice') ?? false;
  const audioAsVoice = readOpenClawBooleanParam(paramsObj, 'audioAsVoice') ?? false;
  const type = readOpenClawStringParam(paramsObj, 'type') || undefined;

  const hasMedia = Boolean(mediaUrl || dedupedMediaUrls?.length);

  if (asVoice && !hasMedia) throw new Error('send voice requires media path');

  const normalizedMessage = hasMedia ? '' : message || caption || '';
  const normalizedCaption = hasMedia ? caption || message || '' : '';

  if (!normalizedMessage.trim() && !normalizedCaption.trim() && !hasMedia) {
    throw new Error('send requires message or media');
  }

  return {
    to,
    accountId: resolvedAccountId,
    message: normalizedMessage,
    caption: normalizedCaption,
    mediaUrl: dedupedMediaUrls?.length ? undefined : mediaUrl || undefined,
    mediaUrls: dedupedMediaUrls,
    asVoice,
    audioAsVoice,
    ...(type ? { type } : {}),
  };
}
