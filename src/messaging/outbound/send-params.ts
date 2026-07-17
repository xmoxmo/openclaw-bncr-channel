import { normalizeAccountId } from '../../core/accounts.ts';
import { readOpenClawBooleanParam, readOpenClawStringParam } from '../../openclaw/sdk-helpers.ts';
import { extractConsumptionFields, parseBncrMarker } from './marker-parser.ts';

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
  downloadMedia?: boolean;
  extra?: Record<string, unknown>;
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

  const rawMessage = readOpenClawStringParam(paramsObj, 'message', { allowEmpty: true }) ?? '';
  const rawCaption = readOpenClawStringParam(paramsObj, 'caption', { allowEmpty: true }) ?? '';
  // Parse [BncrParam:...] markers from message and caption text
  const { cleanText: parsedMessage, params: msgMarker } = parseBncrMarker(rawMessage);
  const { cleanText: parsedCaption, params: capMarker } = parseBncrMarker(rawCaption);
  const message = parsedMessage;
  const caption = parsedCaption;
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
  const rawExtra = paramsObj.extra;
  const paramsExtra = isPlainObject(rawExtra) ? { ...rawExtra } : {};
  // Merge marker params into extra (marker takes priority over direct extra)
  const mergedExtra = { ...paramsExtra, ...msgMarker, ...capMarker };
  const extra = Object.keys(mergedExtra).length > 0 ? mergedExtra : undefined;

  // Extract consumption fields from merged extra - marker-specified values override params
  const { consumed, remaining } = extractConsumptionFields(
    Object.keys(mergedExtra).length > 0 ? mergedExtra : undefined,
  );
  const effectiveAsVoice = consumed.asVoice ?? asVoice;
  const effectiveAudioAsVoice = consumed.audioAsVoice ?? audioAsVoice;
  const effectiveDownloadMedia = consumed.downloadMedia === true;
  const effectiveType = consumed.type ?? type;
  const cleanedExtra = Object.keys(remaining).length > 0 ? remaining : undefined;

  const hasMedia = Boolean(mediaUrl || dedupedMediaUrls?.length);

  if (effectiveAsVoice && !hasMedia) throw new Error('send voice requires media path');

  const normalizedMessage = hasMedia ? '' : message || caption || '';
  const normalizedCaption = hasMedia ? caption || message || '' : '';

  if (!normalizedMessage.trim() && !normalizedCaption.trim() && !hasMedia && !extra) {
    throw new Error('send requires message, media, or extra params');
  }
  console.log(
    '[bncr] normalizeBncrSendParams rawMessage=' +
      JSON.stringify(rawMessage) +
      '|msgMarker=' +
      JSON.stringify(msgMarker) +
      '|consumed=' +
      JSON.stringify(consumed) +
      '|effectiveDownloadMedia=' +
      effectiveDownloadMedia +
      '|mediaUrl=' +
      JSON.stringify(mediaUrl),
  );

  return {
    to,
    accountId: resolvedAccountId,
    message: normalizedMessage,
    caption: normalizedCaption,
    mediaUrl: dedupedMediaUrls?.length ? undefined : mediaUrl || undefined,
    mediaUrls: dedupedMediaUrls,
    asVoice: effectiveAsVoice,
    ...(effectiveDownloadMedia ? { downloadMedia: true } : {}),
    audioAsVoice: effectiveAudioAsVoice,
    ...(effectiveType ? { type: effectiveType } : {}),
    ...(cleanedExtra ? { extra: cleanedExtra } : {}),
  };
}
