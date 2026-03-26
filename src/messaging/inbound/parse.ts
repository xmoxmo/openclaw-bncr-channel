import { createHash } from 'node:crypto';
import { normalizeAccountId } from '../../core/accounts.ts';
import { extractInlineTaskKey } from '../../core/targets.ts';
import type { BncrRoute } from '../../core/types.ts';

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v == null) return fallback;
  return String(v);
}

export function inboundDedupKey(params: {
  accountId: string;
  platform: string;
  groupId: string;
  userId: string;
  msgId?: string;
  text?: string;
  mediaBase64?: string;
}): string {
  const accountId = normalizeAccountId(params.accountId);
  const platform = asString(params.platform).trim().toLowerCase();
  const groupId = asString(params.groupId).trim();
  const userId = asString(params.userId).trim();
  const msgId = asString(params.msgId || '').trim();

  if (msgId) return `${accountId}|${platform}|${groupId}|${userId}|msg:${msgId}`;

  const text = asString(params.text || '').trim();
  const media = asString(params.mediaBase64 || '');
  const digest = createHash('sha1')
    .update(`${text}\n${media.slice(0, 256)}`)
    .digest('hex')
    .slice(0, 16);
  return `${accountId}|${platform}|${groupId}|${userId}|hash:${digest}`;
}

export function resolveChatType(_route: BncrRoute): 'direct' | 'group' {
  return 'direct';
}

export function parseBncrInboundParams(params: any) {
  const accountId = normalizeAccountId(asString(params?.accountId || ''));
  const platform = asString(params?.platform || '').trim();
  const groupId = asString(params?.groupId || '0').trim() || '0';
  const userId = asString(params?.userId || '').trim();
  const sessionKeyfromroute = asString(params?.sessionKey || '').trim();
  const clientId = asString(params?.clientId || '').trim() || undefined;

  const route: BncrRoute = {
    platform,
    groupId,
    userId,
  };

  const text = asString(params?.msg || '');
  const msgType = asString(params?.type || 'text') || 'text';
  const mediaBase64 = asString(params?.base64 || '');
  const mediaPathFromTransfer = asString(params?.path || '').trim();
  const mimeType = asString(params?.mimeType || '').trim() || undefined;
  const fileName = asString(params?.fileName || '').trim() || undefined;
  const msgId = asString(params?.msgId || '').trim() || undefined;

  const dedupKey = inboundDedupKey({
    accountId,
    platform,
    groupId,
    userId,
    msgId,
    text,
    mediaBase64,
  });

  const peer = {
    kind: resolveChatType(route),
    id: route.groupId === '0' ? route.userId : route.groupId,
  } as const;

  const extracted = extractInlineTaskKey(text);

  return {
    accountId,
    platform,
    groupId,
    userId,
    sessionKeyfromroute,
    clientId,
    route,
    text,
    msgType,
    mediaBase64,
    mediaPathFromTransfer,
    mimeType,
    fileName,
    msgId,
    dedupKey,
    peer,
    extracted,
  };
}
